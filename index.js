const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const GREETER_ASSISTANT_ID = '4cabf84c-2953-4679-b4d4-fc6825edfd0f';
const INTERPRETER_ASSISTANT_ID = '47ec4252-6e5d-4320-a61e-8b5f8795a97a';
const VAPI_PHONE_NUMBER_ID = 'd8a665e3-604b-401c-9578-033a522f1dbe';
const VAPI_API_KEY = process.env.VAPI_API_KEY;

// Incoming call — put caller in conference, dial Vapi greeter in
app.post('/incoming', async (req, res) => {
  console.log('Incoming call:', req.body.From);
  const roomName = '2connected-room';

  try {
    // Dial Vapi greeter into the conference room
    await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: GREETER_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: {
          number: process.env.TWILIO_PHONE_NUMBER
        }
      })
    });
  } catch (err) {
    console.error('Vapi dial error:', err.message);
  }

  // Put caller in conference room
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(roomName, {
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    beep: false,
    waitUrl: ''
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Bring in owner + interpreter
app.post('/bring-in-owner', async (req, res) => {
  console.log('Bringing in owner and interpreter');

  try {
    // Dial owner
    await client.calls.create({
      to: process.env.OWNER_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response>
        <Say>You have a call from 2Connected.</Say>
        <Dial>
          <Conference
            startConferenceOnEnter="true"
            endConferenceOnExit="true"
            beep="false">
            2connected-room
          </Conference>
        </Dial>
      </Response>`
    });

    // Dial interpreter assistant
    await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: INTERPRETER_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: {
          number: process.env.TWILIO_PHONE_NUMBER
        }
      })
    });

    res.json({
      result: 'Connecting you now. Please stay on the line.'
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({
      result: 'Error connecting.',
      error: err.message
    });
  }
});

app.get('/', (req, res) =>
  res.send('2Connected Interpreter Server Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`));
