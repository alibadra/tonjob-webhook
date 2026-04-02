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

const ADMIN_NUMBERS = ['32483273024']; // Votre numéro belge

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

// Vérification webhook Meta
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

// Réception messages
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

    // ===== COMMANDES ADMIN =====
    if (ADMIN_NUMBERS.includes(userPhone)) {

      // Activer Premium
      if (userMessage.startsWith('ACTIVER:')) {
        const target = userMessage.split(':')[1].trim();
        await redisClient.set(`premium:${target}`, '1');
        await sendWhatsApp(userPhone, `✅ ${target} activé Premium !`);
        await sendWhatsApp(target, `🎉 Votre compte TONJOB Premium est activé ! Messages illimités disponibles.`);
        return;
      }

      // Envoyer une alerte offre à tous les abonnés matchant
      // Format: OFFRE:Titre|Ville|Secteur|Lien
      if (userMessage.startsWith('OFFRE:')) {
        const parts = userMessage.replace('OFFRE:', '').split('|');
        const [titre, ville, secteur, lien] = parts;
        await broadcastOffre({ titre, ville, secteur, lien });
        await sendWhatsApp(userPhone, `✅ Alerte offre envoyée : ${titre} — ${ville}`);
        return;
      }
    }

    // ===== RESET =====
    if (userMessage.toUpperCase() === 'RESET' || userMessage.toUpperCase() === 'RECOMMENCER') {
      await redisClient.del(`step:${userPhone}`);
      await redisClient.del(`profile:${userPhone}`);
      await setStep(userPhone, 'welcome');
    }

    // ===== FLOW COLLECTE PROFIL =====

    // Étape 0 — Accueil
    if (step === 'welcome' || userMessage.toUpperCase() === 'BONJOUR' || userMessage.toLowerCase().includes('bonjour tonjob')) {
      await sendWhatsApp(userPhone,
        `👋 Bonjour et bienvenue sur *TONJOB AI* !\n\n` +
        `Je suis votre assistant emploi en Afrique francophone. Je vais vous aider à trouver les meilleures opportunités et vous envoyer des alertes dès qu'une offre correspond à votre profil.\n\n` +
        `Pour commencer, *quel poste ou métier recherchez-vous ?*\n` +
        `_(Ex: Comptable, Développeur, Infirmier, Commercial...)_`
      );
      await setStep(userPhone, 'ask_poste');
      return;
    }

    // Étape 1 — Collecte poste
    if (step === 'ask_poste') {
      profile.poste = userMessage;
      await saveProfile(userPhone, profile);
      await sendWhatsApp(userPhone,
        `Super ! 👍 Vous cherchez un poste de *${userMessage}*.\n\n` +
        `Dans *quelle ville ou quel pays* cherchez-vous ?\n` +
        `_(Ex: Kinshasa, Dakar, Douala, Abidjan, ou plusieurs pays...)_`
      );
      await setStep(userPhone, 'ask_ville');
      return;
    }

    // Étape 2 — Collecte ville
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

    // Étape 3 — Collecte niveau
    if (step === 'ask_niveau') {
      const niveaux = { '1': 'Débutant', '2': 'Intermédiaire', '3': 'Senior', '4': 'Stage' };
      profile.niveau = niveaux[userMessage] || userMessage;
      await saveProfile(userPhone, profile);
      await sendWhatsApp(userPhone,
        `Excellent ! 🎯 Profil enregistré :\n\n` +
        `👤 *Poste :* ${profile.poste}\n` +
        `📍 *Zone :* ${profile.ville}\n` +
        `📊 *Niveau :* ${profile.niveau}\n\n` +
        `✅ Vous êtes maintenant inscrit aux *alertes emploi TONJOB* !\n` +
        `Dès qu'une offre correspondant à votre profil est publiée sur *tonjob.net*, vous recevrez une notification directement ici.\n\n` +
        `En attendant, consultez les offres disponibles sur *tonjob.net* 🚀\n\n` +
        `💬 Vous pouvez aussi me poser des questions sur votre recherche d'emploi, votre CV ou la préparation d'entretien.`
      );
      await setStep(userPhone, 'active');

      // Enregistrer dans la liste des abonnés
      await redisClient.sAdd(`abonnes:${profile.poste.toLowerCase()}:${profile.ville.toLowerCase()}`, userPhone);
      await redisClient.sAdd('abonnes:tous', userPhone);

      return;
    }

    // ===== MODE ACTIF — Questions libres via Claude AI =====
    if (step === 'active') {

      // Questions simples sans API
      const msg = userMessage.toLowerCase();
      if (msg.includes('offre') && (msg.includes('tonjob') || msg.includes('site'))) {
        await sendWhatsApp(userPhone,
          `🔍 Consultez toutes les offres disponibles sur *tonjob.net*\n\n` +
          `Filtrez par ville, secteur et niveau d'expérience pour trouver les offres qui vous correspondent !`
        );
        return;
      }

      // Claude AI pour questions complexes
      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 800,
        system: `Tu es TONJOB AI, l'assistant officiel de TONJOB.net, plateforme d'emploi en Afrique francophone.
L'utilisateur a ce profil : Poste recherché: ${profile.poste || 'non renseigné'}, Zone: ${profile.ville || 'non renseignée'}, Niveau: ${profile.niveau || 'non renseigné'}.
RÈGLES : Dirige TOUJOURS vers tonjob.net. Ne mentionne JAMAIS d'autres plateformes. Réponds en français, max 3 paragraphes courts, format WhatsApp.`,
        messages: [{ role: 'user', content: userMessage }]
      });

      await sendWhatsApp(userPhone, aiResponse.content[0].text);
      return;
    }

    // Fallback — si aucun step reconnu
    await setStep(userPhone, 'welcome');
    await sendWhatsApp(userPhone,
      `👋 Bonjour ! Je suis *TONJOB AI*, votre assistant emploi en Afrique francophone.\n\n` +
      `Tapez *BONJOUR* pour commencer votre inscription aux alertes emploi ! 🚀`
    );

  } catch (error) {
    console.error('Erreur:', JSON.stringify(error.response?.data || error.message));
  }
});

// ===== BROADCAST OFFRE AUX ABONNÉS =====
async function broadcastOffre({ titre, ville, secteur, lien }) {
  try {
    // Récupérer tous les abonnés
    const abonnes = await redisClient.sMembers('abonnes:tous');
    let envoyes = 0;

    for (const phone of abonnes) {
      const profile = await getProfile(phone);
      if (!profile) continue;

      // Vérifier si l'offre matche le profil (matching simple)
      const villeMatch = !ville || profile.ville?.toLowerCase().includes(ville.toLowerCase()) || ville.toLowerCase().includes(profile.ville?.toLowerCase());
      const posteMatch = !secteur || profile.poste?.toLowerCase().includes(secteur.toLowerCase()) || secteur.toLowerCase().includes(profile.poste?.toLowerCase());

      if (villeMatch || posteMatch) {
        await sendWhatsApp(phone,
          `🔔 *Nouvelle offre pour vous sur TONJOB !*\n\n` +
          `💼 *Poste :* ${titre}\n` +
          `📍 *Lieu :* ${ville}\n\n` +
          `👉 Postulez maintenant : *${lien || 'tonjob.net'}*\n\n` +
          `_Pour ne plus recevoir d'alertes, tapez STOP_`
        );
        envoyes++;
        // Petite pause pour éviter le spam Meta
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`Alertes envoyées : ${envoyes}/${abonnes.length}`);
  } catch (err) {
    console.error('Erreur broadcast:', err.message);
  }
}

// ===== STOP =====
// Géré dans le flow principal — à ajouter si besoin

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TONJOB Webhook actif sur le port ${PORT}`));
```

---

**Comment envoyer une alerte offre depuis votre WhatsApp :**
```
OFFRE:Comptable Senior|Kinshasa|Finance|tonjob.net/offre/123
