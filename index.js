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
    const msg = userMessage.toLowerCase();
    const profile = await getProfile(userPhone) || {};
    const step = await getStep(userPhone);

    console.log(`[${userPhone}] step=${step} msg=${userMessage}`);

    // ===== COMMANDES ADMIN =====
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

    // ===== STOP =====
    if (userMessage.toUpperCase() === 'STOP') {
      await redisClient.sRem('abonnes:tous', userPhone);
      await sendWhatsApp(userPhone,
        `✅ Vous avez été désinscrit des alertes emploi TONJOB.\n\nTapez *BONJOUR* pour vous réinscrire à tout moment.`
      );
      return;
    }

    // ===== RESET =====
    if (userMessage.toUpperCase() === 'RESET') {
      await redisClient.del(`step:${userPhone}`);
      await redisClient.del(`profile:${userPhone}`);
      await redisClient.sRem('abonnes:tous', userPhone);
      await sendWhatsApp(userPhone, `✅ Profil réinitialisé. Tapez *BONJOUR* pour recommencer.`);
      return;
    }

    // ===== UTILISATEUR DÉJÀ ENREGISTRÉ =====
    // Si profil complet → aller directement en mode actif
    if (profile.poste && profile.ville && step !== 'ask_poste' && step !== 'ask_ville') {
      await setStep(userPhone, 'active');

      // ===== RÉPONSES FIXES (sans Claude) =====

      // Lettre de motivation
      if (msg.includes('lettre') || msg.includes('motivation')) {
        await sendWhatsApp(userPhone,
          `📝 *Lettre de motivation*\n\n` +
          `Retrouvez nos modèles et conseils pour rédiger une lettre percutante sur :\n` +
          `👉 *tonjob.net/blog*\n\n` +
          `Conseils adaptés au marché africain, exemples concrets et erreurs à éviter.`
        );
        return;
      }

      // CV
      if (msg.includes(' cv') || msg.startsWith('cv') || msg.includes('curriculum') || msg.includes('améliorer mon cv') || msg.includes('rédiger mon cv')) {
        await sendWhatsApp(userPhone,
          `📄 *Conseils CV*\n\n` +
          `Nos guides pour créer un CV qui attire les recruteurs :\n` +
          `👉 *tonjob.net/blog*\n\n` +
          `Structure, mise en page, mots-clés — tout ce qu'il faut pour vous démarquer.`
        );
        return;
      }

      // Entretien
      if (msg.includes('entretien') || msg.includes('interview') || msg.includes('préparer')) {
        await sendWhatsApp(userPhone,
          `🎯 *Préparation entretien*\n\n` +
          `Consultez nos conseils pour réussir vos entretiens :\n` +
          `👉 *tonjob.net/blog*\n\n` +
          `Questions fréquentes, attitudes gagnantes, tenues vestimentaires et erreurs à éviter.`
        );
        return;
      }

      // Pas d'offre pour une ville
      if ((msg.includes('pas d\'offre') || msg.includes('pas d offre') || msg.includes('aucune offre') || msg.includes('offre') || msg.includes('emploi')) && (msg.includes('ville') || msg.includes('pour') || msg.includes('à') || msg.includes('au') || msg.includes('en '))) {
        await sendWhatsApp(userPhone,
          `🔍 *Offres d'emploi*\n\n` +
          `Consultez toutes les offres disponibles sur :\n` +
          `👉 *tonjob.net*\n\n` +
          `Les offres sont mises à jour quotidiennement. Si votre ville n'apparaît pas encore, c'est que nous n'avons pas encore d'offres dans cette zone pour le moment — mais vous recevrez une alerte dès qu'une offre correspond à votre profil ! 🔔`
        );
        return;
      }

      // Offres pour un métier
      if (msg.includes('offre') || msg.includes('poste') || msg.includes('recrutement') || msg.includes('emploi')) {
        await sendWhatsApp(userPhone,
          `💼 *Offres d'emploi*\n\n` +
          `Retrouvez toutes les offres correspondant à votre profil sur :\n` +
          `👉 *tonjob.net*\n\n` +
          `Filtrez par métier, ville et secteur pour affiner votre recherche.`
        );
        return;
      }

      // Lien qui ne marche plus
      if (msg.includes('lien') || msg.includes('lien ne marche') || msg.includes('ne fonctionne') || msg.includes('expiré') || msg.includes('erreur') || msg.includes('postuler')) {
        await sendWhatsApp(userPhone,
          `⏰ *Offre expirée*\n\n` +
          `Si le lien de candidature ne fonctionne plus, c'est probablement que le délai de candidature a expiré ou que le poste a été pourvu.\n\n` +
          `Consultez les offres encore actives sur :\n` +
          `👉 *tonjob.net*\n\n` +
          `De nouvelles offres sont publiées chaque jour !`
        );
        return;
      }

      // Salaire
      if (msg.includes('salaire') || msg.includes('rémunération') || msg.includes('combien') || msg.includes('paye')) {
        await sendWhatsApp(userPhone,
          `💰 *Salaires*\n\n` +
          `Les salaires varient selon le poste, l'entreprise, la ville et l'expérience.\n\n` +
          `Consultez les offres sur *tonjob.net* — beaucoup précisent la fourchette salariale. Notre blog propose aussi des guides sur les salaires par secteur :\n` +
          `👉 *tonjob.net/blog*`
        );
        return;
      }

      // Bonjour / re-bonjour
      if (msg.includes('bonjour') || msg.includes('bonsoir') || msg.includes('salut') || msg.includes('hello')) {
        await sendWhatsApp(userPhone,
          `👋 Bon retour *${profile.poste ? `— je me souviens que vous cherchez un poste de ${profile.poste} à ${profile.ville}` : ''}* !\n\n` +
          `Comment puis-je vous aider aujourd'hui ?\n\n` +
          `• 🔍 Offres d'emploi → *tonjob.net*\n` +
          `• 📝 Conseils CV & lettre → *tonjob.net/blog*\n` +
          `• 🎯 Préparer un entretien\n` +
          `• 🔔 Vous êtes inscrit aux alertes emploi`
        );
        return;
      }

      // Merci
      if (msg.includes('merci') || msg.includes('thank')) {
        await sendWhatsApp(userPhone,
          `😊 Avec plaisir ! Bonne chance dans votre recherche d'emploi.\n\n` +
          `N'hésitez pas à revenir si vous avez d'autres questions. Je vous enverrai une alerte dès qu'une offre correspond à votre profil sur *tonjob.net* ! 🍀`
        );
        return;
      }

      // ===== CLAUDE AI pour questions complexes =====
      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 800,
        system: `Tu es TONJOB AI, l'assistant officiel de TONJOB.net.

CE QUI EXISTE VRAIMENT SUR TONJOB.NET :
- Des offres d'emploi consultables et filtrables par pays, ville et secteur
- Un blog avec conseils CV, lettres de motivation et préparation entretien : tonjob.net/blog

CE QUI N'EXISTE PAS (ne jamais mentionner) :
- Création de profil ou compte candidat sur le site
- Modèles de CV téléchargeables sur le site
- Candidature en ligne directe depuis le site

RÈGLES STRICTES :
- Pour les offres d'emploi → tonjob.net
- Pour les conseils CV, lettres, entretiens → tonjob.net/blog
- Ne jamais inventer des fonctionnalités qui n'existent pas
- Ne jamais mentionner d'autres plateformes concurrentes
- Réponds en français, max 3 paragraphes courts, format WhatsApp

Profil utilisateur : Poste: ${profile.poste || 'non renseigné'}, Zone: ${profile.ville || 'non renseignée'}.`,
        messages: [{ role: 'user', content: userMessage }]
      });
      await sendWhatsApp(userPhone, aiResponse.content[0].text);
      return;
    }

    // ===== FLOW INSCRIPTION (nouveaux utilisateurs) =====

    // Étape welcome
    if (step === 'welcome' || msg.includes('bonjour') || msg.includes('salut') || msg.includes('hello') || msg.includes('bonsoir')) {
      await sendWhatsApp(userPhone,
        `👋 Bonjour et bienvenue sur *TONJOB AI* !\n\n` +
        `Je suis votre assistant emploi en Afrique francophone. Je vais vous inscrire aux *alertes emploi* pour vous notifier dès qu'une offre correspond à votre profil.\n\n` +
        `*Quel poste ou métier recherchez-vous ?*\n` +
        `_(Ex: Comptable, Développeur, Infirmier, Commercial...)_`
      );
      await setStep(userPhone, 'ask_poste');
      return;
    }

    // Étape poste
    if (step === 'ask_poste') {
      const msgLower = userMessage.toLowerCase();
      if (
        msgLower.includes('je cherche') ||
        msgLower.includes('bonjour') ||
        msgLower.includes('emploi') ||
        userMessage.length < 3
      ) {
        await sendWhatsApp(userPhone,
          `😊 J'ai besoin du *nom exact du poste ou métier* que vous recherchez.\n\n` +
          `Par exemple : *Comptable*, *Développeur web*, *Infirmier*, *Directeur commercial*\n\n` +
          `*Quel est votre métier ?*`
        );
        return;
      }
      profile.poste = userMessage;
      await saveProfile(userPhone, profile);
      await sendWhatsApp(userPhone,
        `Super ! 👍 Poste recherché : *${userMessage}*\n\n` +
        `Dans *quelle ville ou quel pays* cherchez-vous ?\n` +
        `_(Ex: Kinshasa, Dakar, Douala, Abidjan, RDC, Sénégal...)_`
      );
      await setStep(userPhone, 'ask_ville');
      return;
    }

    // Étape ville
    if (step === 'ask_ville') {
      profile.ville = userMessage;
      await saveProfile(userPhone, profile);
      await redisClient.sAdd('abonnes:tous', userPhone);
      await setStep(userPhone, 'active');
      await sendWhatsApp(userPhone,
        `Parfait ! 🎯 Profil enregistré :\n\n` +
        `💼 *Poste :* ${profile.poste}\n` +
        `📍 *Zone :* ${profile.ville}\n\n` +
        `✅ Vous êtes inscrit aux *alertes emploi TONJOB* !\n` +
        `Dès qu'une offre correspond à votre profil sur *tonjob.net*, vous recevrez une notification ici.\n\n` +
        `En attendant, consultez les offres disponibles sur *tonjob.net* 🚀\n\n` +
        `💬 Posez-moi vos questions : CV, lettre de motivation, entretien...`
      );
      return;
    }

    // Fallback
    await setStep(userPhone, 'welcome');
    await sendWhatsApp(userPhone,
      `👋 Bonjour ! Je suis *TONJOB AI*, votre assistant emploi.\nTapez *BONJOUR* pour commencer ! 🚀`
    );

  } catch (error) {
    console.error('Erreur:', JSON.stringify(error.response?.data || error.message));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TONJOB Webhook actif sur le port ${PORT}`));
