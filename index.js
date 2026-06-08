const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post('/bring-in-owner', async (req, res) => {
  console.log('BODY:', JSON.stringify(req.body, null, 2));

  try {
    // Vapi sends the call object inside message
    const call = req.body?.message?.call || req.body?.call || req.body;
    const callSid = call?.twilioCallSid || call?.externalId;

    console.log('Call SID:', callSid);

    if (callSid) {
      // Update the existing call to dial owner
      await client.calls(callSid).update({
        twiml: `<Response>
          <Say>Please hold while I connect you.</Say>
          <Dial>
            <Number>${process.env.OWNER_PHONE_NUMBER}</Number>
          </Dial>
        </Response>`
      });
    } else {
      // No SID found — dial owner as outbound call
      console.log('No SID — making outbound call to owner');
      await client.calls.create({
        to: process.env.OWNER_PHONE_NUMBER,
        from: process.env.TWILIO_PHONE_NUMBER,
        twiml: `<Response>
          <Say>You have a call from 2Connected. 
          Connecting you now.</Say>
        </Response>`
      });
    }

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

