require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
console.log("Starting WhatsApp Bot Server...");

app.use(bodyParser.json());

// Serve static files from the frontend
app.use(express.static(path.join(__dirname, '../restaurant-bot-web/dist')));

// Root route for health/status check
app.get('/status', (req, res) => {
  res.status(200).send('Whatsapp Chatbot API is running.');
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verify_token) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook to receive messages

// WhatsApp webhook with backend bot engine integration
const botEngine = require('./bot/engine');
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    if (
      body.entry &&
      Array.isArray(body.entry) &&
      body.entry[0].changes &&
      Array.isArray(body.entry[0].changes) &&
      body.entry[0].changes[0].value &&
      body.entry[0].changes[0].value.messages &&
      Array.isArray(body.entry[0].changes[0].value.messages)
    ) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from;
      let msgBody = '';

      if (message.type === 'text') {
        msgBody = message.text.body;
      } else if (message.type === 'interactive' && message.interactive.button_reply) {
        msgBody = message.interactive.button_reply.id;
      } else if (message.type === 'audio') {
        console.log("Audio message received. ID:", message.audio.id);

        // 1. TRY REAL TRANSCRIPTION
        try {
          const apiKey = process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY;

          if (apiKey) {
            // Fetch Media URL from WhatsApp
            const mediaResponse = await axios.get(
              `https://graph.facebook.com/v18.0/${message.audio.id}`,
              { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } }
            );

            const mediaUrl = mediaResponse.data.url;

            // Download Audio Binary
            const audioData = await axios.get(mediaUrl, {
              headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` },
              responseType: 'arraybuffer'
            });

            // Create FormData for Whisper API
            const form = new FormData();
            form.append('file', Buffer.from(audioData.data), { filename: 'audio.ogg', contentType: 'audio/ogg' });
            form.append('model', 'whisper-1');
            if (process.env.GROQ_API_KEY) form.append('model', 'whisper-large-v3'); // Groq model

            const transcribeUrl = process.env.GROQ_API_KEY
              ? 'https://api.groq.com/openai/v1/audio/transcriptions'
              : 'https://api.openai.com/v1/audio/transcriptions';

            const response = await axios.post(transcribeUrl, form, {
              headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${apiKey}`
              }
            });

            msgBody = response.data.text;
            console.log("Real Transcription:", msgBody);

            // GUARD: Check for repetitions or empty results
            if (!msgBody || msgBody.trim().length === 0) {
              throw new Error("Empty transcription");
            }

            // Simple Repetition Guard (e.g., "and and and")
            const words = msgBody.split(/\s+/);
            if (words.length > 5) {
              const counts = {};
              words.forEach(w => counts[w] = (counts[w] || 0) + 1);
              const maxCount = Math.max(...Object.values(counts));
              if (maxCount > words.length * 0.6) {
                console.log("⚠️ Repetitive transcription detected, rejecting.");
                throw new Error("Unreliable transcription (repetitive)");
              }
            }

            // Feedback for Real Transcription
            const feedbackUrl = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
            await axios.post(feedbackUrl, {
              messaging_product: 'whatsapp',
              to: from,
              text: { body: `🎤 You said: "${msgBody}"` }
            }, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });

          } else {
            // 2. TRY FREE VOSK (OFFLINE)
            console.log("No API Key. Trying Vosk (Free/Offline)...");
            const { transcribeAudio } = require('./speechToText');

            // Need to download audio even for Vosk
            const mediaResponse = await axios.get(
              `https://graph.facebook.com/v18.0/${message.audio.id}`,
              { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } }
            );
            const audioData = await axios.get(mediaResponse.data.url, {
              headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` },
              responseType: 'arraybuffer'
            });

            const session = botEngine.getSession(from);
            let userLang = session ? (session.language || 'en') : 'en';
            console.log(`Transcribing for ${from} in ${userLang}...`);

            // 1. Try Primary Language
            let voskText = await transcribeAudio(audioData.data, userLang);

            // 2. Validate using NLP
            const { advancedNLP } = require('./bot/advancedNLP');
            let detected = advancedNLP(voskText, userLang);
            const hasValidIntent = detected.some(d => d.type === 'ITEM' || d.type === 'CATEGORY');

            // 3. SMART SWITCH: Only try other language if result is empty or non-sense
            // If we got a decent sentence like "how about a month", DON'T try Arabic (prevents OOM)
            const isVeryShort = !voskText || voskText.trim().length < 3;

            if (!hasValidIntent && isVeryShort) {
              const altLang = userLang === 'en' ? 'ar' : 'en';
              console.log(`Primary transcription (${userLang}) empty. Trying ${altLang}...`);

              // Small delay to allow memory cleanup
              await new Promise(r => setTimeout(r, 500));

              const altText = await transcribeAudio(audioData.data, altLang);
              const altDetected = advancedNLP(altText, altLang);

              if (altDetected.some(d => d.type === 'ITEM' || d.type === 'CATEGORY')) {
                console.log(`Switching language to ${altLang} based on match: "${altText}"`);
                voskText = altText;
                userLang = altLang;
                if (session) session.language = altLang;
              }
            }

            if (voskText && voskText.trim().length > 0) {
              msgBody = voskText;
              console.log("Vosk Transcription:", msgBody);
              // Feedback
              const feedbackUrl = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
              await axios.post(feedbackUrl, {
                messaging_product: 'whatsapp',
                to: from,
                text: { body: `🎤 You said (Vosk): "${msgBody}"` }
              }, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
            } else {
              throw new Error("Vosk failed or returned empty.");
            }
          }
        } catch (error) {
          console.log("Transcription failed:", error.message);
          // FALLBACK TO SIMULATION IF NO KEY / ERROR
          const userState = botEngine.getSession(from);
          let mockText = "2 Burgers";

          if (userState.step === 'ITEM_SPICY') {
            mockText = "Spicy";
          } else if (userState.step === 'ITEM_QTY' || userState.step === 'ITEM_QTY_MANUAL') {
            mockText = "2";
          } else if (userState.step === 'ITEM_REMOVE_QTY') {
            mockText = "1";
          } else if (userState.step === 'ITEMS_LIST') {
            mockText = "Beef Burger"; // Pick a valid item to advance flow
          } else if (userState.step === 'PAYMENT') {
            mockText = "Cash";
          } else if (userState.step === 'CANCEL_MENU') {
            mockText = "Cancel All";
          }

          // Reply with feedback (Simulated)
          const feedbackUrl = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
          await axios.post(feedbackUrl, {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: `🎤 You said: "${mockText}" (Simulated - Add OPENAI_API_KEY for Real Voice)` }
          }, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });

          msgBody = mockText;
        }
      }

      // Use backend bot engine to process message
      const replies = botEngine.processMessage(from, msgBody);

      for (const reply of replies) {
        try {
          const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
          let payload;
          if (reply && typeof reply === 'object' && reply.type === 'button') {
            // WhatsApp interactive button message
            payload = {
              messaging_product: 'whatsapp',
              to: from,
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: reply.body },
                action: {
                  buttons: reply.buttons.map((btn, idx) => ({
                    type: 'reply',
                    reply: {
                      id: btn.id || `btn_${idx + 1}`,
                      title: btn.title
                    }
                  }))
                }
              }
            };
          } else if (reply && typeof reply === 'object' && reply.type === 'image') {
            // WhatsApp image message
            payload = {
              messaging_product: 'whatsapp',
              to: from,
              type: 'image',
              image: {
                link: reply.link
              }
            };
          } else {
            // Plain text fallback
            payload = {
              messaging_product: 'whatsapp',
              to: from,
              text: { body: reply }
            };
          }
          await axios.post(
            url,
            payload,
            {
              headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
              }
            }
          );
          // Small delay for natural flow
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (error) {
          console.error('Error sending WhatsApp reply:', error.response ? error.response.data : error.message);
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Send message endpoint (for testing)
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  try {
    const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Wildcard route to serve index.html for unknown routes (SPA support)
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../restaurant-bot-web/dist/index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built yet. Run build first.');
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    const downloadModel = require('./download_model');
    await downloadModel();
  } catch (err) {
    console.error("Failed to download Vosk model:", err);
  }
});
