require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const redis = require('redis');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const ADMIN_NUMBERS = ['32483273024'];

async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function getProfile(phone) {
  const data = await redisClient.get(`profile:${phone}`);
  return data ? JSON.parse(data) : null;
}

async function saveProfile(phone, profile) {
  await redisClient.set(`profile:${phone}`, JSON.stringify(profile));
}

async function getStep(phone) {
  const step = await redisClient.get(`step:${phone}`);
  return step || 'welcome';
}

async function setStep(phone, step) {
  await redisClient.set(`step:${phone}`, step);
}

async function broadcastOffre({ titre, ville, secteur, lien }) {
  try {
    const abonnes = await redisClient.sMembers('abonnes:tous');
    let envoyes = 0;
    for (const phone of abonnes) {
      const profile = await getProfile(phone);
      if (!profile) continue;
      const villeMatch = !ville || (profile.ville && profile.ville.toLowerCase().includes(ville.toLowerCase()));
      const posteMatch = !secteur || (profile.poste && profile.poste.toLowerCase().includes(secteur.toLowerCase()));
      if (villeMatch || posteMatch) {
        await sendWhatsApp(phone,
          `🔔 *Nouvelle offre pour vous sur TONJOB !*\n\n` +
          `💼 *Poste :* ${titre}\n` +
          `📍 *Lieu :* ${ville}\n\n` +
          `👉 Postulez maintenant : *${lien || 'tonjob.net'}*\n\n` +
          `_Pour ne plus recevoir d'alertes, tapez STOP_`
        );
        envoyes++;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`Alertes envoyées : ${envoyes}/${abonnes.length}`);
  } catch (err) {
    console.error('Erreur broadcast:', err.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const userMessage = message.text.body.trim();
    const userPhone = message.from;
    const step = await getStep(userPhone);
    const profile = await getProfile(userPhone) || {};

    console.log(`[${userPhone}] step=${step} msg=${userMessage}`);

    // COMMANDES ADMIN
    if (ADMIN_NUMBERS.includes(userPhone)) {
      if (userMessage.startsWith('ACTIVER:')) {
        const target = userMessage.split(':')[1].trim();
        await redisClient.set(`premium:${target}`, '1');
        await sendWhatsApp(userPhone, `✅ ${target} activé Premium !`);
        await sendWhatsApp(target, `🎉 Votre compte TONJOB Premium est activé ! Messages illimités disponibles.`);
        return;
      }
      if (userMessage.startsWith('OFFRE:')) {
        const parts = userMessage.replace('OFFRE:', '').split('|');
        const [titre, ville, secteur, lien] = parts;
        await broadcastOffre({ titre, ville, secteur, lien });
        await sendWhatsApp(userPhone, `✅ Alerte offre envoyée : ${titre} — ${ville}`);
        return;
      }
    }

    // RESET
    if (userMessage.toUpperCase() === 'RESET' || userMessage.toUpperCase() === 'RECOMMENCER') {
      await redisClient.del(`step:${userPhone}`);
      await redisClient.del(`profile:${userPhone}`);
      await setStep(userPhone, 'welcome');
    }

    // STOP
    if (userMessage.toUpperCase() === 'STOP') {
      await redisClient.sRem('abonnes:tous', userPhone);
      await sendWhatsApp(userPhone, `✅ Vous avez été désinscrit des alertes emploi TONJOB. Tapez BONJOUR pour vous réinscrire.`);
      return;
    }

    // ÉTAPE WELCOME
    if (step === 'welcome' || userMessage.toUpperCase().includes('BONJOUR')) {
      await sendWhatsApp(userPhone,
        `👋 Bonjour et bienvenue sur *TONJOB AI* !\n\n` +
        `Je suis votre assistant emploi en Afrique francophone. Je vais vous aider à trouver les meilleures opportunités et vous envoyer des alertes dès qu'une offre correspond à votre profil.\n\n` +
        `Pour commencer, *quel poste ou métier recherchez-vous ?*\n` +
        `_(Ex: Comptable, Développeur, Infirmier, Commercial...)_`
      );
      await setStep(userPhone, 'ask_poste');
      return;
    }

    // ÉTAPE POSTE
   if (step === 'ask_poste') {
  const msgLower = userMessage.toLowerCase();
  // Détecter si l'utilisateur n'a pas compris la question
  if (
    msgLower.includes('je cherche') ||
    msgLower.includes('bonjour') ||
    msgLower.includes('emploi') ||
    userMessage.length < 3
  ) {
    await sendWhatsApp(userPhone,
      `😊 Merci ! Mais j'ai besoin du *nom du poste ou métier* que vous recherchez.\n\n` +
      `Par exemple :\n` +
      `• Comptable\n• Développeur web\n• Infirmier\n• Directeur commercial\n\n` +
      `*Quel est votre métier ?*`
    );
    return;
  }
  profile.poste = userMessage;
  await saveProfile(userPhone, profile);
  await sendWhatsApp(userPhone,
    `Super ! 👍 Poste recherché : *${userMessage}*.\n\n` +
    `Dans *quelle ville ou quel pays* cherchez-vous ?\n` +
    `_(Ex: Kinshasa, Dakar, Douala, Abidjan...)_`
  );
  await setStep(userPhone, 'ask_ville');
  return;
}

    // ÉTAPE VILLE
    if (step === 'ask_ville') {
      profile.ville = userMessage;
      await saveProfile(userPhone, profile);
      await sendWhatsApp(userPhone,
        `Parfait ! 📍 Zone : *${userMessage}*\n\n` +
        `Quel est votre *niveau d'expérience* ?\n\n` +
        `1️⃣ Débutant (0-2 ans)\n` +
        `2️⃣ Intermédiaire (2-5 ans)\n` +
        `3️⃣ Senior (5+ ans)\n` +
        `4️⃣ Stage / Apprentissage`
      );
      await setStep(userPhone, 'ask_niveau');
      return;
    }

    // ÉTAPE NIVEAU
    if (step === 'ask_niveau') {
      const niveaux = { '1': 'Débutant', '2': 'Intermédiaire', '3': 'Senior', '4': 'Stage' };
      profile.niveau = niveaux[userMessage] || userMessage;
      await saveProfile(userPhone, profile);
      await redisClient.sAdd('abonnes:tous', userPhone);
      await sendWhatsApp(userPhone,
        `Excellent ! 🎯 Profil enregistré :\n\n` +
        `👤 *Poste :* ${profile.poste}\n` +
        `📍 *Zone :* ${profile.ville}\n` +
        `📊 *Niveau :* ${profile.niveau}\n\n` +
        `✅ Vous êtes inscrit aux *alertes emploi TONJOB* !\n` +
        `Dès qu'une offre correspond à votre profil sur *tonjob.net*, vous recevrez une notification ici.\n\n` +
        `💬 Posez-moi vos questions sur votre recherche, votre CV ou vos entretiens !`
      );
      await setStep(userPhone, 'active');
      return;
    }

    // MODE ACTIF — Claude AI
    if (step === 'active') {
      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 800,
        system: `Tu es TONJOB AI, l'assistant officiel de TONJOB.net, plateforme d'emploi en Afrique francophone.
Profil utilisateur : Poste: ${profile.poste || 'non renseigné'}, Zone: ${profile.ville || 'non renseignée'}, Niveau: ${profile.niveau || 'non renseigné'}.
RÈGLES : Dirige TOUJOURS vers tonjob.net. Ne mentionne JAMAIS d'autres plateformes. Réponds en français, max 3 paragraphes courts.`,
        messages: [{ role: 'user', content: userMessage }]
      });
      await sendWhatsApp(userPhone, aiResponse.content[0].text);
      return;
    }

    // FALLBACK
    await setStep(userPhone, 'welcome');
    await sendWhatsApp(userPhone,
      `👋 Bonjour ! Je suis *TONJOB AI*.\nTapez *BONJOUR* pour commencer ! 🚀`
    );

  } catch (error) {
    console.error('Erreur:', JSON.stringify(error.response?.data || error.message));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TONJOB Webhook actif sur le port ${PORT}`));
