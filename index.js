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
  console.log('Request body:', JSON.stringify(req.body));
  
  try {
    const callSid = req.body.call?.twilioCallSid || req.body.callSid;
    console.log('Call SID:', callSid);

    await client.calls(callSid).update({
      twiml: `<Response>
        <Dial>
          <Number>${process.env.OWNER_PHONE_NUMBER}</Number>
        </Dial>
      </Response>`
    });

    res.json({ result: 'Business owner is being connected. Please stay on the line.' });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ result: 'Error connecting owner.', error: err.message });
  }
});

app.get('/', (req, res) => res.send('2Connected Interpreter Server Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
