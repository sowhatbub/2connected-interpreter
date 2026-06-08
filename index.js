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
