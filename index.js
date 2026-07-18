// 2Connected Interpreter Server — Multi-Tenant Conference Architecture
// Flow:
// 1. A customer calls one of YOUR clients' Twilio numbers → Twilio hits /incoming
// 2. We look up which CLIENT owns that number in Supabase (business name,
// owner phone, interpreter phone)
// 3. We drop the caller into a Twilio Conference room
// 4. The moment the conference starts, we dial that CLIENT's interpreter
// number into the same room
// 5. If the AI hits /bring-in-owner, we identify which client this call
// belongs to (by matching the Twilio number Vapi saw as the caller)
// and dial THAT client's owner number into the same room

const express = require('express');
const twilio = require('twilio');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const twilioClient = twilio(
process.env.TWILIO_ACCOUNT_SID,
process.env.TWILIO_AUTH_TOKEN
);

// Service-role client — full backend access, bypasses RLS.
// Used only by the calling engine (/incoming, /bring-in-owner, etc.)
const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_KEY
);

const BASE_URL = process.env.BASE_URL;

// Tracks live conferences: room name → { conferenceSid, client, pending }
// client = { business_name, twilio_number, owner_number, interpreter_number }
const activeConferences = new Map();

// ── Helper: look up which client owns a given Twilio number ────────
async function getClientByTwilioNumber(twilioNumber) {
const { data, error } = await supabase
.from('clients')
.select('*')
.eq('twilio_number', twilioNumber)
.eq('active', true)
.single();

if (error) {
console.error(`No client found for ${twilioNumber}:`, error.message);
return null;
}
return data;
}

// ── STEP 1: Customer calls a client's number → language menu ───────
app.post('/incoming', async (req, res) => {
console.log(`Incoming call to ${req.body.To} from ${req.body.From}`);

const twiml = new twilio.twiml.VoiceResponse();

const gather = twiml.gather({
numDigits: 1,
timeout: 6,
action: `${BASE_URL}/language-selected`,
method: 'POST',
});
gather.say('For English, press 1.');
gather.say({ language: 'es-MX' }, 'Para español, presione 2.');

twiml.redirect({ method: 'POST' }, `${BASE_URL}/language-selected`);

res.type('text/xml');
res.send(twiml.toString());
});

// ── STEP 1b: Language chosen (or timed out) → route to conference ──
app.post('/language-selected', async (req, res) => {
const digits = req.body.Digits;
const language = digits === '1' ? 'en' : digits === '2' ? 'es' : 'both';
console.log(`Language selected: ${digits || 'none pressed'} -> ${language}`);

const calledNumber = req.body.To;
const client = await getClientByTwilioNumber(calledNumber);

const twiml = new twilio.twiml.VoiceResponse();

if (!client) {
console.error(`Rejecting call: ${calledNumber} is not a configured client number`);
twiml.say('This number is not currently in service. Goodbye.');
twiml.hangup();
res.type('text/xml');
return res.send(twiml.toString());
}

const room = `interp-${req.body.CallSid}`;
console.log(`Routing call to client "${client.business_name}" -> room ${room} (language: ${language})`);

if (language === 'en') {
twiml.say('Connecting you to your interpreter now.');
} else if (language === 'es') {
twiml.say({ language: 'es-MX' }, 'Conectándolo con su intérprete ahora.');
} else {
twiml.say('Connecting you to your interpreter now.');
twiml.say({ language: 'es-MX' }, 'Conectándolo con su intérprete ahora.');
}

const dial = twiml.dial();
dial.conference(
{
startConferenceOnEnter: true,
endConferenceOnExit: true,
beep: false,
statusCallback: `${BASE_URL}/conference-events`,
statusCallbackEvent: 'end join leave',
statusCallbackMethod: 'POST',
},
room
);

res.type('text/xml');
res.send(twiml.toString());

activeConferences.set(room, {
conferenceSid: null,
client,
pending: true,
callerNumber: req.body.From,
callerLanguage: language,
logId: null,
});
});

// ── STEP 2: First person joins the room -> dial that client's AI in ─
app.post('/conference-events', async (req, res) => {
res.sendStatus(200);

const event = req.body.StatusCallbackEvent;
const room = req.body.FriendlyName;
const conferenceSid = req.body.ConferenceSid;
console.log(`Conference event: ${event} | room: ${room}`);

const entry = activeConferences.get(room);
if (!entry) {
console.error(`No client record found for room ${room} - ignoring event`);
return;
}

if (event === 'participant-join' && entry.pending) {
entry.conferenceSid = conferenceSid;
entry.pending = false;

const { client } = entry;
try {
await twilioClient.conferences(conferenceSid).participants.create({
from: client.twilio_number,
to: client.interpreter_number,
earlyMedia: true,
endConferenceOnExit: false,
beep: false,
});
console.log(`AI interpreter dialed into ${room} for "${client.business_name}"`);
} catch (err) {
console.error('Failed to add AI interpreter:', err.message);
}

try {
const startedAt = new Date();
const { data, error } = await supabase
.from('call_logs')
.insert({
client_id: client.id,
caller_number: entry.callerNumber,
caller_language: entry.callerLanguage || null,
room,
started_at: startedAt.toISOString(),
})
.select('id')
.single();

if (error) {
console.error('Failed to log call start:', error.message);
} else {
entry.logId = data.id;
entry.callStartedAt = startedAt;
console.log(`Call logged: id ${data.id} for "${client.business_name}"`);
}
} catch (err) {
console.error('Failed to log call start:', err.message);
}
}

if (event === 'conference-end') {
if (entry.logId) {
const endedAt = new Date();
const startedAt = entry.callStartedAt || endedAt;
const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
try {
await supabase
.from('call_logs')
.update({
ended_at: endedAt.toISOString(),
duration_seconds: durationSeconds,
})
.eq('id', entry.logId);
console.log(`Call log ${entry.logId} closed out — ${durationSeconds}s`);
} catch (err) {
console.error('Failed to log call end:', err.message);
}
}

activeConferences.delete(room);
console.log(`Conference ${room} ended`);
}
});

// ── STEP 3: AI's tool call brings the right client's owner in ──────
app.post('/bring-in-owner', async (req, res) => {
console.log('Bringing in owner');

const toolCallId =
req.body?.message?.toolCalls?.[0]?.id ||
req.body?.message?.toolCallList?.[0]?.id ||
null;

const respond = (text, status = 200) => {
if (toolCallId) {
res.status(status).json({ results: [{ toolCallId, result: text }] });
} else {
res.status(status).json({ result: text });
}
};

const seenNumber = req.body?.message?.call?.customer?.number || null;
console.log(`bring-in-owner: Vapi reports call.customer.number = ${seenNumber}`);

let matchRoom = null;
let matchEntry = null;

if (seenNumber) {
for (const [room, entry] of activeConferences.entries()) {
if (entry.client?.twilio_number === seenNumber && !entry.pending) {
matchRoom = room;
matchEntry = entry;
break;
}
}
}

if (!matchEntry) {
const rooms = [...activeConferences.entries()].filter(([, e]) => !e.pending);
if (rooms.length > 0) {
[matchRoom, matchEntry] = rooms[rooms.length - 1];
console.log(`bring-in-owner: no exact match, falling back to most recent room ${matchRoom}`);
}
}

if (!matchEntry) {
return respond('No active call found to join.', 200);
}

const { client, conferenceSid } = matchEntry;

try {
await twilioClient.conferences(conferenceSid).participants.create({
from: client.twilio_number,
to: client.owner_number,
earlyMedia: true,
endConferenceOnExit: false,
beep: true,
timeout: 20,
statusCallback: `${BASE_URL}/owner-call-status`,
statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
statusCallbackMethod: 'POST',
});
console.log(`Owner dialed into ${matchRoom} for "${client.business_name}"`);
respond('The owner is being connected now. Please stay on the line.');
} catch (err) {
console.error('Error adding owner:', err.message);
respond('Sorry, I was unable to connect the owner right now.', 200);
}
});

app.post('/owner-call-status', (req, res) => {
const status = req.body.CallStatus;
const to = req.body.To;
console.log(`Owner call status: ${status} (dialed ${to})`);

if (status === 'no-answer' || status === 'busy' || status === 'failed') {
console.error(`OWNER DID NOT ANSWER (${status}) — caller and AI are still on the line without them.`);
}

res.sendStatus(200);
});

app.get('/', (req, res) =>
res.send('2Connected Interpreter Server Running (multi-tenant)'));

// ── Internal Dashboard — password-protected, live from Supabase ────
function escapeHtml(str) {
if (str == null) return '';
return String(str)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');
}

function requireDashboardAuth(req, res, next) {
const expected = process.env.DASHBOARD_PASSWORD;
if (!expected) {
return res.status(500).send('DASHBOARD_PASSWORD is not set in Railway variables.');
}
const auth = req.headers.authorization;
if (!auth || !auth.startsWith('Basic ')) {
res.set('WWW-Authenticate', 'Basic realm="2Connected Dashboard"');
return res.status(401).send('Authentication required.');
}
const decoded = Buffer.from(auth.slice(6), 'base64').toString();
const password = decoded.split(':')[1];
if (password !== expected) {
res.set('WWW-Authenticate', 'Basic realm="2Connected Dashboard"');
return res.status(401).send('Invalid password.');
}
next();
}

app.get('/dashboard-admin', requireDashboardAuth, async (req, res) => {
try {
const { data: clients, error: clientsError } = await supabase
.from('clients')
.select('*')
.order('business_name');
if (clientsError) throw clientsError;

const startOfMonth = new Date();
startOfMonth.setDate(1);
startOfMonth.setHours(0, 0, 0, 0);

const { data: calls, error: callsError } = await supabase
.from('call_logs')
.select('*')
.gte('started_at', startOfMonth.toISOString())
.order('started_at', { ascending: false });
if (callsError) throw callsError;

const usageByClient = {};
for (const call of calls) {
const cid = call.client_id;
if (!usageByClient[cid]) usageByClient[cid] = { minutes: 0, calls: 0 };
usageByClient[cid].minutes += (call.duration_seconds || 0) / 60;
usageByClient[cid].calls += 1;
}

const clientRows = clients.map((c) => {
const usage = usageByClient[c.id] || { minutes: 0, calls: 0 };
return `<tr>
<td>${escapeHtml(c.business_name)}</td>
<td>${escapeHtml(c.twilio_number)}</td>
<td>${usage.calls}</td>
<td>${usage.minutes.toFixed(1)}</td>
<td><span class="status ${c.active ? 'active' : 'inactive'}">${c.active ? 'Active' : 'Inactive'}</span></td>
</tr>`;
}).join('');

const callRows = calls.slice(0, 25).map((call) => {
const client = clients.find((c) => c.id === call.client_id);
const dur = call.duration_seconds
? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, '0')}`
: 'in progress';
return `<tr>
<td>${new Date(call.started_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</td>
<td>${escapeHtml(client ? client.business_name : 'Unknown')}</td>
<td>${escapeHtml(call.caller_number || '—')}</td>
<td>${escapeHtml(call.caller_language || '—')}</td>
<td>${dur}</td>
</tr>`;
}).join('');

const totalMinutes = Object.values(usageByClient).reduce((sum, u) => sum + u.minutes, 0);

res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>2Connected Dashboard</title>
<style>
body { background:#0F1526; color:#F2EFE6; font-family: Arial, sans-serif; margin:0; padding:32px; }
h1 { font-size:22px; margin-bottom:4px; }
.sub { color:#8C93B8; margin-bottom:28px; font-size:13px; }
.stats { display:flex; gap:16px; margin-bottom:32px; flex-wrap:wrap; }
.stat { background:#19213C; border:1px solid #2B3560; border-radius:10px; padding:16px 20px; min-width:160px; }
.stat .label { font-size:11px; color:#8C93B8; text-transform:uppercase; letter-spacing:0.05em; }
.stat .value { font-size:26px; font-weight:700; margin-top:6px; }
table { width:100%; border-collapse:collapse; background:#19213C; border:1px solid #2B3560; border-radius:10px; overflow:hidden; margin-bottom:32px; }
th { text-align:left; padding:10px 14px; font-size:11px; text-transform:uppercase; color:#8C93B8; border-bottom:1px solid #2B3560; }
td { padding:10px 14px; font-size:13px; border-bottom:1px solid #212a4c; }
tr:last-child td { border-bottom:none; }
.status { padding:3px 9px; border-radius:20px; font-size:11px; font-weight:600; }
.status.active { background:#43BFAE22; color:#43BFAE; }
.status.inactive { background:#E2645C22; color:#E2645C; }
h2 { font-size:14px; color:#8C93B8; text-transform:uppercase; letter-spacing:0.05em; margin:0 0 12px; }
</style></head>
<body>
<h1>2Connected — Internal Dashboard</h1>
<div class="sub">${startOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>

<div class="stats">
<div class="stat"><div class="label">Active Clients</div><div class="value">${clients.filter((c) => c.active).length}</div></div>
<div class="stat"><div class="label">Calls This Month</div><div class="value">${calls.length}</div></div>
<div class="stat"><div class="label">Minutes Used</div><div class="value">${totalMinutes.toFixed(0)}</div></div>
</div>

<h2>Clients</h2>
<table>
<tr><th>Business</th><th>Twilio Number</th><th>Calls</th><th>Minutes</th><th>Status</th></tr>
${clientRows || '<tr><td colspan="5">No clients yet.</td></tr>'}
</table>

<h2>Recent Calls</h2>
<table>
<tr><th>Time (PT)</th><th>Client</th><th>Caller</th><th>Language</th><th>Duration</th></tr>
${callRows || '<tr><td colspan="5">No calls yet.</td></tr>'}
</table>
</body></html>`);
} catch (err) {
console.error('Dashboard error:', err.message);
res.status(500).send('Error loading dashboard: ' + err.message);
}
});

// ══════════════════════════════════════════════════════════════════
// CLIENT LOGIN + CLIENT-FACING DASHBOARD
// ══════════════════════════════════════════════════════════════════

function supabaseForUser(accessToken) {
return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
global: { headers: { Authorization: `Bearer ${accessToken}` } },
});
}

const supabaseAnon = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_ANON_KEY
);

function loginPage(errorMsg) {
return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>2Connected — Client Login</title>
<style>
body { background:#0F1526; color:#F2EFE6; font-family: Arial, sans-serif;
display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
.box { background:#19213C; border:1px solid #2B3560; border-radius:12px; padding:40px; width:340px; }
h1 { font-size:20px; margin:0 0 6px; }
p.sub { color:#8C93B8; font-size:13px; margin:0 0 28px; }
label { font-size:12px; color:#8C93B8; display:block; margin-bottom:6px; }
input { width:100%; padding:10px 12px; margin-bottom:16px; border-radius:8px;
border:1px solid #2B3560; background:#0F1526; color:#F2EFE6; font-size:14px; box-sizing:border-box; }
button { width:100%; padding:11px; border:none; border-radius:8px; background:#43BFAE;
color:#0F1526; font-weight:700; font-size:14px; cursor:pointer; }
.error { background:#E2645C22; color:#E2645C; padding:10px 12px; border-radius:8px;
font-size:13px; margin-bottom:16px; }
</style></head>
<body>
<div class="box">
<h1>2Connected</h1>
<p class="sub">Client Dashboard Login</p>
${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
<form method="POST" action="/login">
<label>Email</label>
<input type="email" name="email" required>
<label>Password</label>
<input type="password" name="password" required>
<button type="submit">Log In</button>
</form>
</div>
</body></html>`;
}

app.get('/login', (req, res) => {
res.send(loginPage(null));
});

app.post('/login', async (req, res) => {
const { email, password } = req.body;
const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

if (error || !data.session) {
console.error('Login failed:', error && error.message);
return res.send(loginPage('Incorrect email or password.'));
}

res.cookie('sb_access_token', data.session.access_token, { httpOnly: true, sameSite: 'lax' });
res.cookie('sb_refresh_token', data.session.refresh_token, { httpOnly: true, sameSite: 'lax' });
res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
res.clearCookie('sb_access_token');
res.clearCookie('sb_refresh_token');
res.redirect('/login');
});

async function requireClientLogin(req, res, next) {
const accessToken = req.cookies.sb_access_token;
const refreshToken = req.cookies.sb_refresh_token;

if (!accessToken) return res.redirect('/login');

let userClient = supabaseForUser(accessToken);
let { data: userData, error } = await userClient.auth.getUser(accessToken);

if (error || !userData?.user) {
if (!refreshToken) return res.redirect('/login');
const { data: refreshed, error: refreshError } = await supabaseAnon.auth.refreshSession({
refresh_token: refreshToken,
});
if (refreshError || !refreshed.session) return res.redirect('/login');

res.cookie('sb_access_token', refreshed.session.access_token, { httpOnly: true, sameSite: 'lax' });
res.cookie('sb_refresh_token', refreshed.session.refresh_token, { httpOnly: true, sameSite: 'lax' });
userClient = supabaseForUser(refreshed.session.access_token);
}

req.userClient = userClient;
next();
}

const PLAN_MINUTES = { Starter: 100, Growth: 300, Pro: 750 };

app.get('/dashboard', requireClientLogin, async (req, res) => {
try {
const { data: clientRows, error: clientError } = await req.userClient
.from('clients')
.select('*')
.limit(1);
if (clientError) throw clientError;

if (!clientRows || clientRows.length === 0) {
return res.send('Your login isn\'t linked to a business yet. Contact 2Connected support.');
}
const client = clientRows[0];

const startOfMonth = new Date();
startOfMonth.setDate(1);
startOfMonth.setHours(0, 0, 0, 0);

const { data: calls, error: callsError } = await req.userClient
.from('call_logs')
.select('*')
.gte('started_at', startOfMonth.toISOString())
.order('started_at', { ascending: false });
if (callsError) throw callsError;

const totalMinutes = calls.reduce((sum, c) => sum + (c.duration_seconds || 0) / 60, 0);
const includedMinutes = PLAN_MINUTES[client.plan_name] || 100;
const pctUsed = Math.min(100, Math.round((totalMinutes / includedMinutes) * 100));

const callRows = calls.slice(0, 25).map((call) => {
const dur = call.duration_seconds
? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, '0')}`
: 'in progress';
return `<tr>
<td>${new Date(call.started_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</td>
<td>${escapeHtml(call.caller_number || '—')}</td>
<td>${escapeHtml(call.caller_language || '—')}</td>
<td>${dur}</td>
</tr>`;
}).join('');

res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>2Connected — Dashboard</title>
<style>
body { background:#0F1526; color:#F2EFE6; font-family: Arial, sans-serif; margin:0; padding:32px; }
.top { display:flex; justify-content:space-between; align-items:center; margin-bottom:28px; }
h1 { font-size:20px; margin:0; }
.sub { color:#8C93B8; font-size:13px; }
a.logout { color:#8C93B8; font-size:13px; text-decoration:none; }
.stats { display:flex; gap:16px; margin-bottom:28px; flex-wrap:wrap; }
.stat { background:#19213C; border:1px solid #2B3560; border-radius:10px; padding:16px 20px; min-width:170px; }
.stat .label { font-size:11px; color:#8C93B8; text-transform:uppercase; letter-spacing:0.05em; }
.stat .value { font-size:26px; font-weight:700; margin-top:6px; }
.progress-track { height:6px; background:#212a4c; border-radius:3px; margin-top:10px; overflow:hidden; }
.progress-fill { height:100%; background:#E3A548; }
table { width:100%; border-collapse:collapse; background:#19213C; border:1px solid #2B3560; border-radius:10px; overflow:hidden; margin-bottom:28px; }
th { text-align:left; padding:10px 14px; font-size:11px; text-transform:uppercase; color:#8C93B8; border-bottom:1px solid #2B3560; }
td { padding:10px 14px; font-size:13px; border-bottom:1px solid #212a4c; }
h2 { font-size:14px; color:#8C93B8; text-transform:uppercase; letter-spacing:0.05em; margin:0 0 12px; }
.plan-badge { background:#43BFAE22; color:#43BFAE; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600; }
</style></head>
<body>
<div class="top">
<div>
<h1>${escapeHtml(client.business_name)}</h1>
<div class="sub">${startOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
</div>
<a class="logout" href="/logout">Log out</a>
</div>

<h2>Usage &amp; Minutes</h2>
<div class="stats">
<div class="stat"><div class="label">Plan</div><div class="value" style="font-size:18px;"><span class="plan-badge">${escapeHtml(client.plan_name)}</span></div></div>
<div class="stat"><div class="label">Calls This Month</div><div class="value">${calls.length}</div></div>
<div class="stat" style="min-width:220px;">
<div class="label">Minutes Used</div>
<div class="value">${totalMinutes.toFixed(0)} <span style="font-size:15px;color:#8C93B8;">/ ${includedMinutes}</span></div>
<div class="progress-track"><div class="progress-fill" style="width:${pctUsed}%"></div></div>
</div>
</div>

<h2>Call History</h2>
<table>
<tr><th>Time (PT)</th><th>Caller</th><th>Language</th><th>Duration</th></tr>
${callRows || '<tr><td colspan="4">No calls yet this month.</td></tr>'}
</table>

<h2>Billing Status</h2>
<div class="stats">
<div class="stat"><div class="label">Current Plan</div><div class="value" style="font-size:18px;">${escapeHtml(client.plan_name)}</div></div>
<div class="stat"><div class="label">Included Minutes</div><div class="value" style="font-size:18px;">${includedMinutes}/mo</div></div>
</div>
</body></html>`);
} catch (err) {
console.error('Client dashboard error:', err.message);
res.status(500).send('Error loading dashboard: ' + err.message);
}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
console.log(`Server running on port ${PORT}`));
