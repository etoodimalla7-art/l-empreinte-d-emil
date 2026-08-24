const admin = require('firebase-admin');

function getFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    });
  }
  return admin.initializeApp({ credential });
}

function getDb() {
  return getFirebaseAdmin().firestore();
}

function requireCronSecret(req) {
  const configured = process.env.CRON_SECRET;
  if (!configured) throw new Error('CRON_SECRET non configuré.');
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-cron-secret'];
  if (!supplied || supplied !== configured) {
    const error = new Error('Non autorisé.');
    error.statusCode = 401;
    throw error;
  }
}

function productName(product) {
  return product.name || product.nameFR || product.title || product.titleFR || 'Nouveau produit';
}
function productDescription(product) {
  return product.description || product.descriptionFR || product.desc || 'Une nouvelle pièce d’exception vient d’arriver dans notre collection.';
}
function productImage(product) {
  return product.image || product.imageUrl || product.img || (Array.isArray(product.imgs) ? product.imgs[0] : '') || null;
}
function siteUrl() {
  return (process.env.SITE_URL || 'https://lempreinte-demil.onrender.com').replace(/\/$/, '');
}

async function sendOneSignal({ title, message, image, url, data = {} }) {
  const apiKey = process.env.ONESIGNAL_API_KEY;
  const appId = process.env.ONESIGNAL_APP_ID;
  if (!apiKey || !appId) throw new Error('ONESIGNAL_API_KEY et ONESIGNAL_APP_ID doivent être configurés.');
  const payload = {
    app_id: appId,
    target_channel: 'push',
    included_segments: ['All Subscribers'],
    headings: { fr: title, en: title },
    contents: { fr: message, en: message },
    url,
    data
  };
  if (image) {
    payload.big_picture = image;
    payload.chrome_web_image = image;
    payload.ios_attachments = { product_image: image };
  }
  const response = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OneSignal ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

module.exports = { getDb, requireCronSecret, productName, productDescription, productImage, siteUrl, sendOneSignal };
