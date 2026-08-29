import express from 'express';
import admin from 'firebase-admin';
import cryptoModule from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = 'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_TABLE = String(process.env.SUPABASE_TABLE || 'store_data').trim();
const ONESIGNAL_URL = 'https://onesignal.com/api/v1/notifications';
const EVENTS_PATH = 'storedData/pushEvents';
// Les images restent dans la Realtime Database sous forme de data URL compressée.
// La limite est volontairement prudente pour éviter de surdimensionner les écritures RTDB.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

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

function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

function storeKeyFromPath(pathValue) {
  let decoded = String(pathValue || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* conserver la valeur brute */ }
  const normalized = decoded.replace(/^\/+|\/+$/g, '').replace(/^storedData\//, '');
  const parts = normalized.split('/').filter(Boolean);
  return { key: parts.shift() || '', parts };
}

function setNestedValue(root, parts, value) {
  if (!parts.length) return value;
  const next = root && typeof root === 'object' ? structuredClone(root) : {};
  let cursor = next;
  parts.slice(0, -1).forEach(part => {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  });
  cursor[parts.at(-1)] = value;
  return next;
}

function getNestedValue(root, parts) {
  return parts.reduce((value, part) => value == null ? null : value[part], root);
}

function emptyStoreValue(pathValue) {
  const { key, parts } = storeKeyFromPath(pathValue);
  if (parts.length) return {};
  const collectionKeys = new Set([
    'products', 'categories', 'reviews', 'orders', 'transactions',
    'payments', 'lookbook', 'promoCodes', 'pushEvents', 'customers'
  ]);
  return collectionKeys.has(key) ? [] : {};
}

function neutralizeStoreValue(pathValue, value) {
  return value === null || value === undefined ? emptyStoreValue(pathValue) : value;
}

async function readStoreValue(pathValue) {
  const client = getSupabaseClient();
  if (!client) throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.');
  const { key, parts } = storeKeyFromPath(pathValue);
  if (!key) return {};
  const { data, error } = await client.from(SUPABASE_TABLE).select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  const storedValue = data?.value ?? null;
  return neutralizeStoreValue(pathValue, getNestedValue(storedValue, parts));
}

async function writeStoreValue(pathValue, value, mode = 'set') {
  const client = getSupabaseClient();
  if (!client) throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.');
  const { key, parts } = storeKeyFromPath(pathValue);
  if (!key) throw new Error('Clé de stockage obligatoire.');
  let nextValue = value;
  if (parts.length || mode === 'update') {
    const current = await readStoreValue(key);
    nextValue = parts.length ? setNestedValue(current, parts, value) : { ...(current && typeof current === 'object' ? current : {}), ...(value && typeof value === 'object' ? value : {}) };
  }
  const { data, error } = await client.from(SUPABASE_TABLE).upsert({ key, value: nextValue, updated_at: new Date().toISOString() }, { onConflict: 'key' }).select('key,value,updated_at').single();
  if (error) throw error;
  return data;
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
      productId: cleanText(eventData?.productId, cleanText(product?.id)),
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

function validateBase64Image(value) {
  const dataUrl = String(value || '').trim();
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=_-]+)$/i);
  if (!match) throw new Error('Image invalide : data URL JPEG, PNG ou WebP attendue.');
  const normalizedPayload = match[2].replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalizedPayload, 'base64');
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw new Error('Image trop volumineuse : maximum 2 Mo après compression.');
  return `data:${match[1].toLowerCase()};base64,${normalizedPayload}`;
}

function allowedOrigin(origin) {
  if (!origin) return true;
  const configured = String(process.env.FRONTEND_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const allowed = new Set([
    'https://lempreinte-demil.onrender.com',
    'https://l-empreinte-d-emil-1.onrender.com',
    'http://localhost:3000',
    'http://localhost:5173',
    ...configured
  ]);
  return allowed.has(origin);
}

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigin(origin)) return response.status(403).json({ error: 'Origin non autorisée.' });
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Upload-Token');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/store', async (_request, response) => {
    try {
      const client = getSupabaseClient();
      if (!client) return response.status(503).json({ error: 'Supabase non configuré.' });
      const { data, error } = await client.from(SUPABASE_TABLE).select('key,value,updated_at');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const normalized = Object.fromEntries(rows.filter(row => row && row.key).map(row => [row.key, row.value ?? emptyStoreValue(row.key)]));
      return response.json({ ok: true, data: normalized });
    } catch (error) {
      console.error('[Supabase] Lecture globale impossible :', error);
      return response.status(500).json({ error: error?.message || 'Lecture Supabase impossible.' });
    }
  });

  app.patch('/api/store', async (request, response) => {
    try {
      const updates = request.body?.value || request.body?.data || {};
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return response.status(400).json({ error: 'Objet de mise à jour attendu.' });
      const rows = await Promise.all(Object.entries(updates).map(([key, value]) => writeStoreValue(key, value, 'set')));
      return response.json({ ok: true, rows });
    } catch (error) {
      console.error('[Supabase] Mise à jour globale impossible :', error);
      return response.status(500).json({ error: error?.message || 'Mise à jour Supabase impossible.' });
    }
  });

  app.get('/api/store-node', async (request, response) => {
    try {
      const value = await readStoreValue(request.query.path || '');
      return response.json({ ok: true, path: request.query.path || '', value: neutralizeStoreValue(request.query.path || '', value) });
    } catch (error) {
      console.error('[Supabase] Lecture de chemin impossible :', error);
      return response.status(500).json({ error: error?.message || 'Lecture Supabase impossible.' });
    }
  });

  const handleStoreNodeWrite = async (request, response, mode) => {
    try {
      const row = await writeStoreValue(request.query.path || '', request.body?.value, mode);
      return response.json({ ok: true, path: request.query.path || '', value: row.value, updated_at: row.updated_at });
    } catch (error) {
      console.error('[Supabase] Écriture de chemin impossible :', error);
      return response.status(500).json({ error: error?.message || 'Écriture Supabase impossible.' });
    }
  };
  app.put('/api/store-node', (request, response) => handleStoreNodeWrite(request, response, 'set'));
  app.patch('/api/store-node', (request, response) => handleStoreNodeWrite(request, response, 'update'));
  app.delete('/api/store-node', async (request, response) => {
    try {
      const client = getSupabaseClient();
      if (!client) return response.status(503).json({ error: 'Supabase non configuré.' });
      const { key } = storeKeyFromPath(request.query.path || '');
      const { error } = await client.from(SUPABASE_TABLE).delete().eq('key', key);
      if (error) throw error;
      return response.json({ ok: true });
    } catch (error) {
      console.error('[Supabase] Suppression de chemin impossible :', error);
      return response.status(500).json({ error: error?.message || 'Suppression Supabase impossible.' });
    }
  });

  app.get('/api/store/:key', async (request, response) => {
    try {
      const value = await readStoreValue(request.params.key);
      return response.json({ ok: true, key: request.params.key, value: neutralizeStoreValue(request.params.key, value) });
    } catch (error) {
      console.error('[Supabase] Lecture impossible :', error);
      return response.status(500).json({ error: error?.message || 'Lecture Supabase impossible.' });
    }
  });

  app.put('/api/store/:key', async (request, response) => {
    try {
      const row = await writeStoreValue(request.params.key, request.body?.value, 'set');
      return response.json({ ok: true, ...row });
    } catch (error) {
      console.error('[Supabase] Écriture impossible :', error);
      return response.status(500).json({ error: error?.message || 'Écriture Supabase impossible.' });
    }
  });

  app.patch('/api/store/:key', async (request, response) => {
    try {
      const row = await writeStoreValue(request.params.key, request.body?.value || {}, 'update');
      return response.json({ ok: true, ...row });
    } catch (error) {
      console.error('[Supabase] Mise à jour impossible :', error);
      return response.status(500).json({ error: error?.message || 'Mise à jour Supabase impossible.' });
    }
  });

  app.delete('/api/store/:key', async (request, response) => {
    try {
      const client = getSupabaseClient();
      if (!client) return response.status(503).json({ error: 'Supabase non configuré.' });
      const { error } = await client.from(SUPABASE_TABLE).delete().eq('key', storeKeyFromPath(request.params.key).key);
      if (error) throw error;
      return response.json({ ok: true });
    } catch (error) {
      console.error('[Supabase] Suppression impossible :', error);
      return response.status(500).json({ error: error?.message || 'Suppression Supabase impossible.' });
    }
  });

  app.post('/api/notifications/product', async (request, response) => {
    try {
      const result = await sendOneSignalNotification(request.body || {});
      return response.status(202).json({ ok: true, handled: true, data: result });
    } catch (error) {
      console.error('[OneSignal] Notification produit impossible :', error?.details || error);
      return response.status(502).json({ ok: false, handled: false, error: error?.message || 'Notification impossible.' });
    }
  });

  app.post('/api/push-events', async (request, response) => {
    try {
      const result = await sendOneSignalNotification(request.body || {});
      return response.status(202).json({ ok: true, handled: true, data: result });
    } catch (error) {
      console.error('[OneSignal] Événement push impossible :', error?.details || error);
      return response.status(502).json({ ok: false, handled: false, error: error?.message || 'Notification impossible.' });
    }
  });

  app.post('/api/upload', async (request, response) => {
    try {
      const { dataUrl, folder } = request.body || {};
      if (!dataUrl) return response.status(400).json({ error: 'dataUrl obligatoire.' });
      if (folder !== 'products' && folder !== 'reviews') return response.status(400).json({ error: 'Dossier invalide.' });
      // Protection optionnelle : activez UPLOAD_TOKEN sur Render pour exiger ce secret côté serveur.
      const expectedToken = String(process.env.UPLOAD_TOKEN || '').trim();
      if (expectedToken && request.get('X-Upload-Token') !== expectedToken) {
        return response.status(401).json({ error: 'Upload non autorisé.' });
      }
      const normalizedDataUrl = validateBase64Image(dataUrl);
      // Aucun stockage objet : la data URL validée est retournée au frontend et sera
      // enregistrée avec le produit ou l’avis dans la Realtime Database.
      return response.status(201).json({ ok: true, url: normalizedDataUrl, imageUrl: normalizedDataUrl, dataUrl: normalizedDataUrl, path: folder, contentType: 'image' });
    } catch (error) {
      console.error('[Upload] Échec validation Base64 :', error);
      return response.status(400).json({ error: error?.message || 'Upload impossible.' });
    }
  });

  app.get('/health', (_request, response) => response.status(200).json({
    ok: true,
    service: 'emil-supabase-push-worker',
    dataProvider: getSupabaseClient() ? 'supabase' : 'not-configured',
    legacyFirebasePushPath: EVENTS_PATH,
    timestamp: new Date().toISOString()
  }));

  app.get('/', (_request, response) => response.status(200).send('L’Empreinte d’Emil push service is running.'));
  return app;
}

async function main() {
  const app = createServer();
  if (getSupabaseClient()) {
    console.log(`[Supabase] Mode principal actif sur la table ${SUPABASE_TABLE}; Firebase historique désactivé.`);
  } else {
    const firebaseApp = initFirebaseAdmin();
    const db = admin.database(firebaseApp);
    // Compatibilité historique : le worker Firebase reste disponible si Supabase n’est pas configuré.
    await db.ref('.info/connected').once('value').catch(error => {
      console.warn('[Firebase] Vérification initiale indisponible, le listener sera tout de même démarré.', error.message);
    });
    startPushEventListener(db);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Serveur Express à l’écoute sur le port ${PORT}`);
  });
}

main().catch(error => {
  console.error('[Startup] Démarrage impossible', error);
  process.exit(1);
});

export { createServer, notificationPayload, processPushEvent };
