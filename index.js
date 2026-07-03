// 2Connected Interpreter Server — Conference Architecture
// Flow:
//   1. Customer calls your main Twilio number → Twilio hits /incoming
//   2. We drop the caller into a Twilio Conference room (named after their CallSid)
//   3. The moment the conference starts, Twilio pings /conference-events
//   4. We dial the Vapi Interpreter's phone number INTO that same conference
//      → Vapi answers, the AI joins the room, and stays until the call ends
//   5. If the AI (via its tool) hits /bring-in-owner, we dial the owner
//      into the SAME conference room as a third participant

const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Environment variables you need set in Railway ──────────────────
// TWILIO_ACCOUNT_SID        (already have)
// TWILIO_AUTH_TOKEN         (already have)
// TWILIO_PHONE_NUMBER       (already have — your main number, E.164 like +12095551234)
// OWNER_PHONE_NUMBER        (already have — your cell)
// VAPI_INTERPRETER_NUMBER   (NEW — the phone number assigned to the
//                            Interpreter assistant in Vapi, E.164 format)
// BASE_URL                  (NEW — https://2connected-interpreter-production.up.railway.app)
// ────────────────────────────────────────────────────────────────────

const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const OWNER_NUMBER = process.env.OWNER_PHONE_NUMBER;
const INTERPRETER_NUMBER = process.env.VAPI_INTERPRETER_NUMBER;
const BASE_URL = process.env.BASE_URL;

// Tracks live conferences: room name → Twilio ConferenceSid
// (In-memory is fine for low call volume; swap for Supabase later if
// you ever run many simultaneous calls and multiple server instances.)
const activeConferences = new Map();
let lastConferenceRoom = null;

// ── STEP 1: Customer calls in → put them in a conference room ──────
app.post('/incoming', (req, res) => {
  const room = `interp-${req.body.CallSid}`;
  lastConferenceRoom = room;
  console.log(`Incoming call from ${req.body.From} → room ${room}`);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Connecting you to your interpreter now.');

  const dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,   // room opens the moment caller joins
      endConferenceOnExit: true,      // caller hangs up → whole call ends
      beep: false,
      statusCallback: `${BASE_URL}/conference-events`,
      statusCallbackEvent: 'start end join leave',
      statusCallbackMethod: 'POST',
    },
    room
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── STEP 2: Conference started → dial the AI interpreter into it ───
app.post('/conference-events', async (req, res) => {
  res.sendStatus(200); // acknowledge Twilio immediately

  const event = req.body.StatusCallbackEvent;
  const room = req.body.FriendlyName;
  const conferenceSid = req.body.ConferenceSid;
  console.log(`Conference event: ${event} | room: ${room}`);

  if (event === 'conference-start') {
    activeConferences.set(room, conferenceSid);

    try {
      // Dial the Vapi Interpreter's phone number INTO this conference.
      // Vapi auto-answers with the Interpreter assistant, so the AI
      // becomes a live participant in the same room as the caller.
      await client.conferences(conferenceSid).participants.create({
        from: TWILIO_NUMBER,
        to: INTERPRETER_NUMBER,
        earlyMedia: true,
        endConferenceOnExit: false, // AI leaving shouldn't kill the call
        beep: false,
      });
      console.log(`AI interpreter dialed into ${room}`);
    } catch (err) {
      console.error('Failed to add AI interpreter:', err.message);
    }
  }

  if (event === 'conference-end') {
    activeConferences.delete(room);
    if (lastConferenceRoom === room) lastConferenceRoom = null;
    console.log(`Conference ${room} ended`);
  }
});

// ── STEP 3 (optional): AI's tool call brings the owner into the room ─
app.post('/bring-in-owner', async (req, res) => {
  console.log('Bringing in owner');

  // Vapi's newer tool-call format expects results keyed by toolCallId.
  // We grab it if present and fall back gracefully if not.
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

  const room = lastConferenceRoom;
  const conferenceSid = room ? activeConferences.get(room) : null;

  if (!conferenceSid) {
    return respond('No active call found to join.', 200);
  }

  try {
    await client.conferences(conferenceSid).participants.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      earlyMedia: true,
      endConferenceOnExit: false,
      beep: true, // audible cue that the owner joined
    });
    respond('The owner is being connected now. Please stay on the line.');
  } catch (err) {
    console.error('Error adding owner:', err.message);
    respond('Sorry, I was unable to connect the owner right now.', 200);
  }
});

app.get('/', (req, res) =>
  res.send('2Connected Interpreter Server Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`));
