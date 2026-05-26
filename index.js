const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const ownerNumber = process.env.OWNER_PHONE_NUMBER;

const client = twilio(accountSid, authToken);

// Incoming call — put caller in conference room
app.post('/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference('2connected-room', {
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    waitUrl: ''
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

// Vapi calls this to bring in the business owner
app.post('/bring-in-owner', async (req, res) => {
  try {
    await client.calls.create({
      to: ownerNumber,
      from: twilioNumber,
      twiml: `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">2connected-room</Conference></Dial></Response>`
    });
    res.json({ result: 'Business owner is being connected. Please stay on the line.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ result: 'Failed to connect owner.' });
  }
});

app.get('/', (req, res) => res.send('2Connected Interpreter Server Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
