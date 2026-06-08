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
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;
const VAPI_API_KEY = process.env.VAPI_API_KEY;

app.post('/incoming', (req, res) => {
  console.log('Incoming call from:', req.body.From);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Please hold while we connect you.');
  twiml.pause({ length: 30 });

  res.type('text/xml');
  res.send(twiml.toString());

  fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId: GREETER_ASSISTANT_ID,
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      customer: {
        number: req.body.From
      }
    })
  })
  .then(r => r.json())
  .then(data => console.log('Vapi response:', JSON.stringify(data)))
  .catch(err => console.error('Vapi error:', err.message));
});

app.post('/bring-in-owner', async (req, res) => {
  console.log('Bringing in owner');

  try {
    await client.calls.create({
      to: process.env.OWNER_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response>
        <Say>You have a call from 2Connected.</Say>
      </Response>`
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
