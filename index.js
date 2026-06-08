const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const INTERPRETER_ASSISTANT_ID = '47ec4252-6e5d-4320-a61e-8b5f8795a97a';

app.post('/bring-in-owner', async (req, res) => {
  console.log('BODY:', JSON.stringify(req.body, null, 2));

  try {
    // Step 1 - Dial the owner via Twilio
    await client.calls.create({
      to: process.env.OWNER_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response>
        <Say>You have a call from 2Connected. 
        Connecting you now.</Say>
        <Dial>
          <Conference startConferenceOnEnter="true" 
            endConferenceOnExit="true">
            2connected-room
          </Conference>
        </Dial>
      </Response>`
    });

    // Step 2 - Dial the interpreter assistant via Vapi
    await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: INTERPRETER_ASSISTANT_ID,
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: {
          number: process.env.TWILIO_PHONE_NUMBER
        }
      })
    });

    res.json({ 
      result: 'Connecting you to the business owner now. Please stay on the line.' 
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
