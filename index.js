require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ✅ Vérification webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook vérifié !');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ✅ Réception des messages WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Répondre vite à Meta

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const userMessage = message.text.body;
    const userPhone = message.from;

    console.log(`Message de ${userPhone}: ${userMessage}`);

    // 🤖 Réponse Claude AI
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Tu es TONJOB AI, un assistant spécialisé dans la recherche d'emploi en Afrique francophone.
Tu aides les candidats à :
- Trouver des offres d'emploi adaptées à leur profil
- Rédiger leur CV et lettre de motivation
- Préparer leurs entretiens
- Comprendre le marché de l'emploi local

Réponds toujours en français, de façon chaleureuse, concise et utile.
Maximum 3 paragraphes courts par réponse (format WhatsApp).`,
      messages: [
        { role: 'user', content: userMessage }
      ]
    });

    const replyText = aiResponse.content[0].text;

    // 📤 Envoi de la réponse sur WhatsApp
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: userPhone,
        type: 'text',
        text: { body: replyText }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Réponse envoyée à ${userPhone}`);

  } catch (error) {
    console.error('Erreur:', error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TONJOB Webhook actif sur le port ${PORT}`);
});
