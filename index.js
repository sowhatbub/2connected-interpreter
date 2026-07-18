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
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(
process.env.TWILIO_ACCOUNT_SID,
process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_KEY
);

const BASE_URL = process.env.BASE_URL;

const activeConferences = new Map();

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
console.log(`Server running on port ${PORT}`));
