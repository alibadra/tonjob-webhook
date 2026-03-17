require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const redis = require('redis');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Connexion Redis
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const FREE_LIMIT = 3; // messages gratuits par jour

async function getMessageCount(phone) {
  const key = `msg:${phone}:${new Date().toISOString().slice(0,10)}`;
  const count = await redisClient.get(key);
  return parseInt(count || '0');
}

async function incrementMessageCount(phone) {
  const key = `msg:${phone}:${new Date().toISOString().slice(0,10)}`;
  await redisClient.incr(key);
  await redisClient.expire(key, 86400); // expire après 24h
}

async function isPremium(phone) {
  const val = await redisClient.get(`premium:${phone}`);
  return val === '1';
}

async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Vérification webhook Meta
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

// Réception des messages
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const userMessage = message.text.body;
    const userPhone = message.from;

    console.log(`Message de ${userPhone}: ${userMessage}`);

    const premium = await isPremium(userPhone);
    const count = await getMessageCount(userPhone);

    // Limite gratuite atteinte
    if (!premium && count >= FREE_LIMIT) {
      await sendWhatsApp(userPhone,
        `⚠️ Vous avez atteint votre limite de ${FREE_LIMIT} messages gratuits aujourd'hui.\n\n` +
        `🌟 *Passez Premium à 2$/mois* pour :\n` +
        `✅ Messages illimités\n` +
        `✅ Génération de CV\n` +
        `✅ Alertes emploi personnalisées\n\n` +
        `👉 Abonnez-vous sur : *tonjob.net/premium*\n\n` +
        `_Vos messages reprennent automatiquement demain._`
      );
      return;
    }

    // Incrémenter compteur
    await incrementMessageCount(userPhone);

    // Message d'avertissement à 1 message restant
    if (!premium && count === FREE_LIMIT - 1) {
      await sendWhatsApp(userPhone,
        `💡 _Il vous reste 1 message gratuit aujourd'hui. Passez Premium sur tonjob.net/premium pour un accès illimité !_`
      );
    }

    // Réponse Claude AI
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1000,
      system: `Tu es TONJOB AI, l'assistant officiel de TONJOB.net, la plateforme d'emploi de référence en Afrique francophone.

Tu aides les candidats à :
- Trouver des offres d'emploi adaptées à leur profil
- Rédiger leur CV et lettre de motivation
- Préparer leurs entretiens
- Comprendre le marché de l'emploi local

RÈGLES IMPORTANTES :
- Tu diriges TOUJOURS vers tonjob.net pour les offres d'emploi
- Tu ne mentionnes JAMAIS d'autres plateformes (LinkedIn, emploi.cm, lesmetiers.net, etc.)
- Tu es chaleureux, concis et utile
- Maximum 3 paragraphes courts par réponse (format WhatsApp)
- Tu réponds toujours en français`,
      messages: [{ role: 'user', content: userMessage }]
    });

    const replyText = aiResponse.content[0].text;
    await sendWhatsApp(userPhone, replyText);
    console.log(`Réponse envoyée à ${userPhone} (message ${count + 1}/${FREE_LIMIT})`);

  } catch (error) {
    console.error('Erreur:', JSON.stringify(error.response?.data || error.message));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TONJOB Webhook actif sur le port ${PORT}`));
