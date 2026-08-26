import express from 'express';
import admin from 'firebase-admin';
import cryptoModule from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = 'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app';
const ONESIGNAL_URL = 'https://onesignal.com/api/v1/notifications';
const EVENTS_PATH = 'storedData/pushEvents';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Variable d’environnement manquante : ${name}`);
  }
  return String(value).trim();
}

function normalizePrivateKey(rawValue) {
  let key = String(rawValue || '').replace(/^\uFEFF/, '').trim();

  // Accepte une valeur copiée comme chaîne JSON, avec des retours \\n littéraux.
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      const parsed = JSON.parse(key);
      if (typeof parsed === 'string') key = parsed;
    } catch {
      key = key.slice(1, -1);
    }
  }

  // Accepte de vrais retours de ligne et un ou plusieurs antislashs suivis de n.
  key = key
    .replace(/\\+r\\+n/g, '\n')
    .replace(/\\+n/g, '\n')
    .replace(/\\+r/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .trim();

  const begin = '-----BEGIN PRIVATE KEY-----';
  const end = '-----END PRIVATE KEY-----';
  const beginIndex = key.indexOf(begin);
  const endIndex = key.indexOf(end);
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
    throw new Error('Clé Firebase invalide : délimiteurs PEM absents ou mal ordonnés.');
  }

  key = key.slice(beginIndex, endIndex + end.length).trim();
  try {
    cryptoModule.createPrivateKey({ key, format: 'pem', type: 'pkcs8' });
  } catch (error) {
    throw new Error(`Clé Firebase illisible ou tronquée : ${error.message}`);
  }
  return key;
}

function parseServiceAccountJson() {
  const raw = requiredEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  let json = raw;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { json = JSON.parse(raw); } catch { /* tentative de parsing direct */ }
  }
  try {
    const account = JSON.parse(json);
    if (!account || typeof account !== 'object') throw new Error('objet JSON attendu');
    return account;
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON invalide : ${error.message}`);
  }
}

function buildFirebaseCredential() {
  const account = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
    ? parseServiceAccountJson()
    : {
        project_id: requiredEnv('FIREBASE_PROJECT_ID'),
        client_email: requiredEnv('FIREBASE_CLIENT_EMAIL'),
        private_key: requiredEnv('FIREBASE_PRIVATE_KEY')
      };

  const projectId = String(account.project_id || account.projectId || '').trim();
  const clientEmail = String(account.client_email || account.clientEmail || '').trim();
  const privateKey = normalizePrivateKey(account.private_key || account.privateKey);
  if (!projectId || !clientEmail) {
    throw new Error('Le compte de service Firebase doit contenir project_id et client_email.');
  }

  return admin.credential.cert({ projectId, clientEmail, privateKey });
}

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  return admin.initializeApp({
    credential: buildFirebaseCredential(),
    databaseURL: DATABASE_URL
  });
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function eventProduct(eventData) {
  return eventData?.product && typeof eventData.product === 'object' ? eventData.product : eventData;
}

function notificationPayload(eventData) {
  const product = eventProduct(eventData);
  const title = cleanText(eventData?.title, cleanText(product?.title, cleanText(product?.nameFR, cleanText(product?.name, 'Nouvelle signature disponible'))));
  const body = cleanText(eventData?.body, cleanText(product?.body, `Découvrez ${title} chez L’Empreinte d’Emil.`));
  const image = cleanText(eventData?.image, cleanText(product?.image, cleanText(product?.imageUrl, Array.isArray(product?.imgs) ? cleanText(product.imgs[0]) : '')));
  const url = cleanText(eventData?.url, 'https://lempreinte-demil.onrender.com/');

  return {
    app_id: requiredEnv('ONESIGNAL_APP_ID'),
    included_segments: ['All'],
    headings: { fr: title, en: title },
    contents: { fr: body, en: body },
    big_picture: image || '',
    chrome_web_image: image || '',
    large_icon: image || '',
    url,
    data: {
      type: 'new-product',
      productId: cleanText(product?.id),
      image: image || ''
    }
  };
}

async function sendOneSignalNotification(eventData) {
  const payload = notificationPayload(eventData);
  const response = await fetch(ONESIGNAL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${requiredEnv('ONESIGNAL_REST_API_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();
  let responseData;
  try { responseData = responseText ? JSON.parse(responseText) : {}; } catch { responseData = { raw: responseText }; }
  if (!response.ok) {
    const error = new Error(`OneSignal HTTP ${response.status}`);
    error.details = responseData;
    throw error;
  }
  return responseData;
}

async function claimEvent(eventRef) {
  const result = await eventRef.transaction(current => {
    if (!current || current.processed === true || current.processing === true) return;
    return {
      ...current,
      processing: true,
      processingAt: admin.database.ServerValue.TIMESTAMP
    };
  });
  return result.committed ? result.snapshot.val() : null;
}

async function processPushEvent(snapshot) {
  const eventRef = snapshot.ref;
  const eventId = snapshot.key;
  try {
    const eventData = await claimEvent(eventRef);
    if (!eventData) {
      console.log(`[Push] Événement ${eventId} déjà traité ou en cours, ignoré.`);
      return;
    }

    console.log(`[Push] Traitement de ${eventId}`, {
      title: eventData.title || eventData.product?.title || eventData.product?.nameFR,
      image: eventData.image || eventData.product?.image || eventData.product?.imageUrl || null
    });

    const oneSignalResult = await sendOneSignalNotification(eventData);
    await eventRef.update({
      processed: true,
      processing: false,
      processedAt: admin.database.ServerValue.TIMESTAMP,
      oneSignalNotificationId: oneSignalResult.id || null,
      lastError: null
    });
    console.log(`[Push] Notification OneSignal envoyée pour ${eventId}`, oneSignalResult);
  } catch (error) {
    console.error(`[Push] Échec pour ${eventId}`, error?.details || error);
    try {
      await eventRef.update({
        processing: false,
        processed: false,
        lastError: String(error?.message || error).slice(0, 1000),
        lastErrorAt: admin.database.ServerValue.TIMESTAMP
      });
    } catch (updateError) {
      console.error(`[Push] Impossible d’enregistrer l’erreur pour ${eventId}`, updateError);
    }
  }
}

function startPushEventListener(db) {
  const eventsRef = db.ref(EVENTS_PATH);
  eventsRef.on('child_added', snapshot => {
    processPushEvent(snapshot).catch(error => {
      console.error(`[Push] Erreur non interceptée pour ${snapshot.key}`, error);
    });
  }, error => {
    console.error(`[Firebase] Listener ${EVENTS_PATH} interrompu`, error);
  });
  console.log(`[Firebase] Listener actif sur ${EVENTS_PATH}`);
}

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_request, response) => response.status(200).json({
    ok: true,
    service: 'emil-push-worker',
    firebasePath: EVENTS_PATH,
    timestamp: new Date().toISOString()
  }));

  app.get('/', (_request, response) => response.status(200).send('L’Empreinte d’Emil push service is running.'));
  return app;
}

async function main() {
  const firebaseApp = initFirebaseAdmin();
  const db = admin.database(firebaseApp);
  // Vérification immédiate de la configuration Firebase sans exposer de données.
  await db.ref('.info/connected').once('value').catch(error => {
    console.warn('[Firebase] Vérification initiale indisponible, le listener sera tout de même démarré.', error.message);
  });
  startPushEventListener(db);

  const app = createServer();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Serveur Express à l’écoute sur le port ${PORT}`);
  });
}

main().catch(error => {
  console.error('[Startup] Démarrage impossible', error);
  process.exit(1);
});

export { createServer, notificationPayload, processPushEvent };
