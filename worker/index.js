// Worker du site : sert les pages statiques (assets) et la route POST /api/cahiers.
// /api/cahiers reçoit l'e-mail saisi dans le pop-up de la page Cahiers et crée le contact dans Brevo ;
// une automatisation Brevo (« contact ajouté à la liste ») envoie ensuite l'e-mail avec le lien de la ressource.
// Le lien de la ressource n'existe que dans cet e-mail : ni ce fichier ni le site ne le connaissent.
//
// Réglages côté Cloudflare (Workers > mgcoaching > Settings > Variables and Secrets) :
//   BREVO_API_KEY            secret, clé API Brevo (jamais dans le dépôt)
// Réglage dans wrangler.jsonc : BREVO_NEWSLETTER_LIST_ID (0 = pas encore de liste Newsletter).
import ressources from '../cahiers/ressources.json';

const ORIGINE = 'https://mgcoaching.io';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/cahiers') return cahiers(request, env);
    return env.ASSETS.fetch(request);
  }
};

function reponse(status, donnees) {
  return new Response(JSON.stringify(donnees), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function cahiers(request, env) {
  if (request.method !== 'POST') return reponse(405, { erreur: 'methode' });
  // Seul le site lui-même peut appeler la route (pas d'en-tête CORS : les autres origines sont refusées)
  if (request.headers.get('Origin') !== ORIGINE) return reponse(403, { erreur: 'origine' });

  // 5 demandes par minute et par adresse IP (binding LIMITE_CAHIERS de wrangler.jsonc)
  if (env.LIMITE_CAHIERS) {
    const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
    const { success } = await env.LIMITE_CAHIERS.limit({ key: ip });
    if (!success) return reponse(429, { erreur: 'trop-de-demandes' });
  }

  let corps;
  try {
    if (Number(request.headers.get('Content-Length') || 0) > 2000) throw new Error('trop long');
    corps = await request.json();
  } catch {
    return reponse(400, { erreur: 'corps' });
  }
  const email = typeof corps.email === 'string' ? corps.email.trim().toLowerCase() : '';
  const newsletter = corps.newsletter === true;
  if (corps.honeypot) return reponse(400, { erreur: 'honeypot' });
  if (!EMAIL.test(email) || email.length > 254) return reponse(400, { erreur: 'email' });
  const ressource = ressources.find(r => r.id === corps.resourceId);
  if (!ressource) return reponse(400, { erreur: 'ressource' });

  const listeNewsletter = Number(env.BREVO_NEWSLETTER_LIST_ID) || 0;
  if (!env.BREVO_API_KEY || !ressource.brevoListId || (newsletter && !listeNewsletter)) {
    console.error('Configuration Brevo incomplète', { ressource: ressource.id, cle: !!env.BREVO_API_KEY, listeNewsletter });
    return reponse(500, { erreur: 'configuration' });
  }

  // Preuve du consentement : ressource d'origine, date, et case newsletter.
  // Les attributs newsletter ne sont écrits que si la case est cochée, pour ne jamais effacer un consentement donné plus tôt.
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const attributs = { CAHIER: ressource.id, DATE_CAHIER: aujourdhui };
  const listes = [ressource.brevoListId];
  if (newsletter) {
    attributs.NL_CONSENTEMENT = aujourdhui;
    attributs.NL_SOURCE = 'Cahier ' + ressource.id;
    listes.push(listeNewsletter);
  }

  try {
    const brevo = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, attributes: attributs, listIds: listes, updateEnabled: true })
    });
    if (!brevo.ok) {
      console.error('Brevo a refusé la demande', brevo.status, await brevo.text());
      return reponse(500, { erreur: 'brevo' });
    }
  } catch (e) {
    console.error('Brevo injoignable', e);
    return reponse(500, { erreur: 'brevo' });
  }
  return reponse(200, { ok: true });
}
