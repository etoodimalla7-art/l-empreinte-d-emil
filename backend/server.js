import express from 'express';
import admin from 'firebase-admin';
import cryptoModule from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY =
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const SUPABASE_TABLE =
  String(process.env.SUPABASE_TABLE || 'store_data').trim();

const ONESIGNAL_APP_ID =
  String(process.env.ONESIGNAL_APP_ID || '').trim();

const ONESIGNAL_REST_API_KEY =
  String(process.env.ONESIGNAL_REST_API_KEY || '').trim();

const ONESIGNAL_URL =
  'https://api.onesignal.com/notifications';

const ONESIGNAL_SUBSCRIPTIONS_URL =
  `https://api.onesignal.com/apps/${ONESIGNAL_APP_ID}/subscriptions`;

const EVENTS_PATH = 'storedData/pushEvents';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;


/* =========================================================
   ENVIRONMENT HELPERS
========================================================= */

function requiredEnv(name) {
  const value = process.env[name];

  if (!value || !String(value).trim()) {
    throw new Error(`Variable d’environnement manquante : ${name}`);
  }

  return String(value).trim();
}


/* =========================================================
   FIREBASE
========================================================= */

function normalizePrivateKey(rawValue) {
  let key = String(rawValue || '')
    .replace(/^\uFEFF/, '')
    .trim();

  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      const parsed = JSON.parse(key);

      if (typeof parsed === 'string') {
        key = parsed;
      }
    } catch {
      key = key.slice(1, -1);
    }
  }

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

  if (
    beginIndex < 0 ||
    endIndex < 0 ||
    endIndex <= beginIndex
  ) {
    throw new Error(
      'Clé Firebase invalide : délimiteurs PEM absents ou mal ordonnés.'
    );
  }

  key = key
    .slice(beginIndex, endIndex + end.length)
    .trim();

  try {
    cryptoModule.createPrivateKey({
      key,
      format: 'pem',
      type: 'pkcs8'
    });
  } catch (error) {
    throw new Error(
      `Clé Firebase illisible ou tronquée : ${error.message}`
    );
  }

  return key;
}


function parseServiceAccountJson() {
  const raw = requiredEnv('FIREBASE_SERVICE_ACCOUNT_JSON');

  let json = raw;

  if (
    raw.startsWith('"') &&
    raw.endsWith('"')
  ) {
    try {
      json = JSON.parse(raw);
    } catch {
      // continue
    }
  }

  try {
    const account = JSON.parse(json);

    if (!account || typeof account !== 'object') {
      throw new Error('objet JSON attendu');
    }

    return account;

  } catch (error) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT_JSON invalide : ${error.message}`
    );
  }
}


function buildFirebaseCredential() {
  const account =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
      ? parseServiceAccountJson()
      : {
          project_id: requiredEnv('FIREBASE_PROJECT_ID'),
          client_email: requiredEnv('FIREBASE_CLIENT_EMAIL'),
          private_key: requiredEnv('FIREBASE_PRIVATE_KEY')
        };

  const projectId =
    String(
      account.project_id ||
      account.projectId ||
      ''
    ).trim();

  const clientEmail =
    String(
      account.client_email ||
      account.clientEmail ||
      ''
    ).trim();

  const privateKey =
    normalizePrivateKey(
      account.private_key ||
      account.privateKey
    );

  if (!projectId || !clientEmail) {
    throw new Error(
      'Le compte de service Firebase doit contenir project_id et client_email.'
    );
  }

  return admin.credential.cert({
    projectId,
    clientEmail,
    privateKey
  });
}


function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  return admin.initializeApp({
    credential: buildFirebaseCredential(),
    databaseURL: DATABASE_URL
  });
}


/* =========================================================
   SUPABASE
========================================================= */

function getSupabaseClient() {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}


/* =========================================================
   STORE HELPERS
========================================================= */

function storeKeyFromPath(pathValue) {
  let decoded = String(pathValue || '');

  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // conserver la valeur brute
  }

  const normalized =
    decoded
      .replace(/^\/+|\/+$/g, '')
      .replace(/^storedData\//, '');

  const parts =
    normalized
      .split('/')
      .filter(Boolean);

  return {
    key: parts.shift() || '',
    parts
  };
}


function setNestedValue(root, parts, value) {
  if (!parts.length) {
    return value;
  }

  const next =
    root && typeof root === 'object'
      ? structuredClone(root)
      : {};

  let cursor = next;

  parts.slice(0, -1).forEach(part => {
    if (
      !cursor[part] ||
      typeof cursor[part] !== 'object'
    ) {
      cursor[part] = {};
    }

    cursor = cursor[part];
  });

  cursor[parts.at(-1)] = value;

  return next;
}


function getNestedValue(root, parts) {
  return parts.reduce(
    (value, part) =>
      value == null ? null : value[part],
    root
  );
}


function emptyStoreValue(pathValue) {
  const {
    key,
    parts
  } = storeKeyFromPath(pathValue);

  if (parts.length) {
    return {};
  }

  const collectionKeys = new Set([
    'products',
    'categories',
    'reviews',
    'orders',
    'transactions',
    'payments',
    'lookbook',
    'promoCodes',
    'pushEvents',
    'customers'
  ]);

  return collectionKeys.has(key)
    ? []
    : {};
}


function neutralizeStoreValue(pathValue, value) {
  return value === null ||
    value === undefined
    ? emptyStoreValue(pathValue)
    : value;
}


async function readStoreValue(pathValue) {
  const client = getSupabaseClient();

  if (!client) {
    throw new Error(
      'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.'
    );
  }

  const {
    key,
    parts
  } = storeKeyFromPath(pathValue);

  if (!key) {
    return {};
  }

  const {
    data,
    error
  } = await client
    .from(SUPABASE_TABLE)
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const storedValue =
    data?.value ?? null;

  return neutralizeStoreValue(
    pathValue,
    getNestedValue(
      storedValue,
      parts
    )
  );
}


async function writeStoreValue(
  pathValue,
  value,
  mode = 'set'
) {
  const client = getSupabaseClient();

  if (!client) {
    throw new Error(
      'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.'
    );
  }

  const {
    key,
    parts
  } = storeKeyFromPath(pathValue);

  if (!key) {
    throw new Error(
      'Clé de stockage obligatoire.'
    );
  }

  let nextValue = value;

  if (
    parts.length ||
    mode === 'update'
  ) {
    const current =
      await readStoreValue(key);

    nextValue =
      parts.length
        ? setNestedValue(
            current,
            parts,
            value
          )
        : {
            ...(
              current &&
              typeof current === 'object'
                ? current
                : {}
            ),
            ...(
              value &&
              typeof value === 'object'
                ? value
                : {}
            )
          };
  }

  const {
    data,
    error
  } = await client
    .from(SUPABASE_TABLE)
    .upsert(
      {
        key,
        value: nextValue,
        updated_at:
          new Date().toISOString()
      },
      {
        onConflict: 'key'
      }
    )
    .select(
      'key,value,updated_at'
    )
    .single();

  if (error) {
    throw error;
  }

  return data;
}


/* =========================================================
   GENERAL HELPERS
========================================================= */

function cleanText(
  value,
  fallback = ''
) {
  return typeof value === 'string' &&
    value.trim()
    ? value.trim()
    : fallback;
}


function eventProduct(eventData) {
  return eventData?.product &&
    typeof eventData.product === 'object'
    ? eventData.product
    : eventData;
}


/* =========================================================
   ONESIGNAL
========================================================= */

function getOneSignalConfig() {
  if (!ONESIGNAL_APP_ID) {
    throw new Error(
      'ONESIGNAL_APP_ID est manquant sur Render.'
    );
  }

  if (!ONESIGNAL_REST_API_KEY) {
    throw new Error(
      'ONESIGNAL_REST_API_KEY est manquant sur Render.'
    );
  }

  return {
    appId: ONESIGNAL_APP_ID,
    apiKey: ONESIGNAL_REST_API_KEY
  };
}


function oneSignalHeaders() {
  getOneSignalConfig();

  return {
    'Authorization':
      `Key ${ONESIGNAL_REST_API_KEY}`,

    'Content-Type':
      'application/json'
  };
}


/*
 * Vérifie les subscriptions enregistrées
 * dans l'application OneSignal.
 */
async function getOneSignalSubscriptions() {
  getOneSignalConfig();

  const response =
    await fetch(
      ONESIGNAL_SUBSCRIPTIONS_URL,
      {
        method: 'GET',
        headers: oneSignalHeaders()
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        `OneSignal subscriptions HTTP ${response.status}`
      );

    error.details = data;

    throw error;
  }

  return data;
}


/*
 * Détermine si une subscription est réellement
 * utilisable pour le Push Web.
 */
function isUsablePushSubscription(subscription) {
  if (!subscription) {
    return false;
  }

  const subscribed =
    subscription.subscribed === true;

  const enabled =
    subscription.enabled !== false;

  const status =
    String(
      subscription.status || ''
    ).toLowerCase();

  const validStatus =
    !status ||
    status === 'subscribed' ||
    status === 'enabled';

  return (
    subscribed &&
    enabled &&
    validStatus
  );
}


async function getPushSubscriptionReport() {
  const data =
    await getOneSignalSubscriptions();

  const subscriptions =
    Array.isArray(data?.subscriptions)
      ? data.subscriptions
      : Array.isArray(data?.items)
        ? data.items
        : [];

  const usable =
    subscriptions.filter(
      isUsablePushSubscription
    );

  return {
    total: subscriptions.length,
    usable: usable.length,
    subscriptions
  };
}


/* =========================================================
   NOTIFICATION PAYLOAD
========================================================= */

function notificationPayload(eventData) {
  const product =
    eventProduct(eventData);

  const title =
    cleanText(
      eventData?.title,
      cleanText(
        product?.title,
        cleanText(
          product?.nameFR,
          cleanText(
            product?.name,
            'Nouvelle signature disponible'
          )
        )
      )
    );

  const body =
    cleanText(
      eventData?.body,
      cleanText(
        product?.body,
        `Découvrez ${title} chez L’Empreinte d’Emil.`
      )
    );

  const image =
    cleanText(
      eventData?.image,
      cleanText(
        product?.image,
        cleanText(
          product?.imageUrl,
          Array.isArray(product?.imgs)
            ? cleanText(
                product.imgs[0]
              )
            : ''
        )
      )
    );

  const url =
    cleanText(
      eventData?.url,
      'https://lempreinte-demil.onrender.com/'
    );

  const payload = {
    app_id:
      ONESIGNAL_APP_ID,

    target_channel:
      'push',

    included_segments:
      ['Subscribed Users'],

    headings: {
      en: title,
      fr: title
    },

    contents: {
      en: body,
      fr: body
    },

    url,

    data: {
      type: 'new-product',

      productId:
        cleanText(
          eventData?.productId,
          cleanText(product?.id)
        ),

      image:
        image || ''
    }
  };


  /*
   * OneSignal Web Push accepte ces champs
   * lorsque l'image est HTTPS.
   */
  if (
    image &&
    /^https:\/\//i.test(image)
  ) {
    payload.chrome_web_image =
      image;

    payload.chrome_web_icon =
      image;

    payload.big_picture =
      image;
  }

  return payload;
}


/* =========================================================
   SEND ONESIGNAL
========================================================= */

async function sendOneSignalNotification(
  eventData
) {
  getOneSignalConfig();

  const report =
    await getPushSubscriptionReport();

  console.log(
    '[OneSignal] Subscription report:',
    {
      total: report.total,
      usable: report.usable
    }
  );


  /*
   * IMPORTANT :
   *
   * On refuse d'envoyer une requête inutile
   * si OneSignal ne voit aucune subscription.
   */
  if (report.usable === 0) {
    const error =
      new Error(
        'OneSignal ne voit actuellement aucune subscription Push Web active. Autorisez les notifications sur le site puis rechargez la page.'
      );

    error.code =
      'NO_ACTIVE_PUSH_SUBSCRIPTION';

    error.details = {
      totalSubscriptions:
        report.total,

      usableSubscriptions:
        report.usable,

      appId:
        ONESIGNAL_APP_ID
    };

    throw error;
  }


  const payload =
    notificationPayload(
      eventData
    );

  console.log(
    '[OneSignal] Sending payload:',
    {
      app_id:
        payload.app_id,

      target_channel:
        payload.target_channel,

      included_segments:
        payload.included_segments,

      title:
        payload.headings?.en,

      url:
        payload.url
    }
  );


  const response =
    await fetch(
      ONESIGNAL_URL,
      {
        method: 'POST',

        headers:
          oneSignalHeaders(),

        body:
          JSON.stringify(
            payload
          )
      }
    );


  const responseText =
    await response.text();

  let responseData;

  try {
    responseData =
      responseText
        ? JSON.parse(responseText)
        : {};
  } catch {
    responseData = {
      raw:
        responseText
    };
  }


  if (!response.ok) {
    const error =
      new Error(
        `OneSignal HTTP ${response.status}`
      );

    error.details =
      responseData;

    throw error;
  }


  /*
   * OneSignal peut répondre 200 mais
   * ne créer aucun message.
   */
  const recipients =
    Number(
      responseData?.recipients || 0
    );

  const id =
    responseData?.id || null;


  if (!id && recipients === 0) {
    const error =
      new Error(
        'OneSignal a accepté la requête mais aucun message Push n’a été créé.'
      );

    error.code =
      'ONESIGNAL_ZERO_RECIPIENTS';

    error.details =
      responseData;

    throw error;
  }


  return {
    ...responseData,

    verifiedRecipients:
      recipients,

    verifiedMessageId:
      id
  };
}


/* =========================================================
   FIREBASE PUSH EVENTS
========================================================= */

async function claimEvent(eventRef) {
  const result =
    await eventRef.transaction(
      current => {
        if (
          !current ||
          current.processed === true ||
          current.processing === true
        ) {
          return;
        }

        return {
          ...current,

          processing:
            true,

          processingAt:
            admin.database
              .ServerValue
              .TIMESTAMP
        };
      }
    );

  return result.committed
    ? result.snapshot.val()
    : null;
}


async function processPushEvent(snapshot) {
  const eventRef =
    snapshot.ref;

  const eventId =
    snapshot.key;

  try {
    const eventData =
      await claimEvent(
        eventRef
      );

    if (!eventData) {
      console.log(
        `[Push] Événement ${eventId} déjà traité ou en cours, ignoré.`
      );

      return;
    }


    console.log(
      `[Push] Traitement de ${eventId}`,
      {
        title:
          eventData.title ||
          eventData.product?.title ||
          eventData.product?.nameFR,

        image:
          eventData.image ||
          eventData.product?.image ||
          eventData.product?.imageUrl ||
          null
      }
    );


    const oneSignalResult =
      await sendOneSignalNotification(
        eventData
      );


    await eventRef.update({
      processed:
        true,

      processing:
        false,

      processedAt:
        admin.database
          .ServerValue
          .TIMESTAMP,

      oneSignalNotificationId:
        oneSignalResult.id ||
        null,

      lastError:
        null
    });


    console.log(
      `[Push] Notification OneSignal envoyée pour ${eventId}`,
      oneSignalResult
    );

  } catch (error) {
    console.error(
      `[Push] Échec pour ${eventId}`,
      error?.details ||
      error
    );


    try {
      await eventRef.update({
        processing:
          false,

        processed:
          false,

        lastError:
          String(
            error?.message ||
            error
          ).slice(
            0,
            1000
          ),

        lastErrorAt:
          admin.database
            .ServerValue
            .TIMESTAMP
      });

    } catch (updateError) {
      console.error(
        `[Push] Impossible d’enregistrer l’erreur pour ${eventId}`,
        updateError
      );
    }
  }
}


function startPushEventListener(db) {
  const eventsRef =
    db.ref(EVENTS_PATH);

  eventsRef.on(
    'child_added',

    snapshot => {
      processPushEvent(
        snapshot
      ).catch(error => {
        console.error(
          `[Push] Erreur non interceptée pour ${snapshot.key}`,
          error
        );
      });
    },

    error => {
      console.error(
        `[Firebase] Listener ${EVENTS_PATH} interrompu`,
        error
      );
    }
  );


  console.log(
    `[Firebase] Listener actif sur ${EVENTS_PATH}`
  );
}


/* =========================================================
   IMAGE UPLOAD
========================================================= */

function validateBase64Image(value) {
  const dataUrl =
    String(value || '')
      .trim();

  const match =
    dataUrl.match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=_-]+)$/i
    );

  if (!match) {
    throw new Error(
      'Image invalide : data URL JPEG, PNG ou WebP attendue.'
    );
  }

  const normalizedPayload =
    match[2]
      .replace(/-/g, '+')
      .replace(/_/g, '/');

  const buffer =
    Buffer.from(
      normalizedPayload,
      'base64'
    );

  if (
    !buffer.length ||
    buffer.length >
      MAX_UPLOAD_BYTES
  ) {
    throw new Error(
      'Image trop volumineuse : maximum 2 Mo après compression.'
    );
  }

  return `data:${match[1].toLowerCase()};base64,${normalizedPayload}`;
}


/* =========================================================
   CORS
========================================================= */

function allowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  const configured =
    String(
      process.env.FRONTEND_ORIGINS || ''
    )
      .split(',')
      .map(
        value => value.trim()
      )
      .filter(Boolean);

  const allowed =
    new Set([
      'https://lempreinte-demil.onrender.com',

      'https://l-empreinte-d-emil-1.onrender.com',

      'http://localhost:3000',

      'http://localhost:5173',

      ...configured
    ]);

  return allowed.has(origin);
}


/* =========================================================
   EXPRESS SERVER
========================================================= */

function createServer() {
  const app =
    express();

  app.disable(
    'x-powered-by'
  );


  /*
   * CORS
   */
  app.use(
    (
      request,
      response,
      next
    ) => {
      const origin =
        request.headers.origin;

      if (
        origin &&
        !allowedOrigin(origin)
      ) {
        return response
          .status(403)
          .json({
            error:
              'Origin non autorisée.'
          });
      }

      if (origin) {
        response.setHeader(
          'Access-Control-Allow-Origin',
          origin
        );
      }

      response.setHeader(
        'Vary',
        'Origin'
      );

      response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Accept, Authorization, X-Upload-Token'
      );

      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      );

      if (
        request.method ===
        'OPTIONS'
      ) {
        return response
          .sendStatus(204);
      }

      next();
    }
  );


  app.use(
    express.json({
      limit: '12mb'
    })
  );


  /* =======================================================
     STORE
  ======================================================= */

  app.get(
    '/api/store',
    async (_request, response) => {
      try {
        const client =
          getSupabaseClient();

        if (!client) {
          return response
            .status(503)
            .json({
              error:
                'Supabase non configuré.'
            });
        }

        const {
          data,
          error
        } = await client
          .from(SUPABASE_TABLE)
          .select(
            'key,value,updated_at'
          );

        if (error) {
          throw error;
        }

        const rows =
          Array.isArray(data)
            ? data
            : [];

        const normalized =
          Object.fromEntries(
            rows
              .filter(
                row =>
                  row &&
                  row.key
              )
              .map(
                row => [
                  row.key,
                  row.value ??
                    emptyStoreValue(
                      row.key
                    )
                ]
              )
          );

        return response.json({
          ok: true,
          data:
            normalized
        });

      } catch (error) {
        console.error(
          '[Supabase] Lecture globale impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Lecture Supabase impossible.'
          });
      }
    }
  );


  app.patch(
    '/api/store',
    async (
      request,
      response
    ) => {
      try {
        const updates =
          request.body?.value ||
          request.body?.data ||
          {};

        if (
          !updates ||
          typeof updates !==
            'object' ||
          Array.isArray(
            updates
          )
        ) {
          return response
            .status(400)
            .json({
              error:
                'Objet de mise à jour attendu.'
            });
        }

        const rows =
          await Promise.all(
            Object.entries(
              updates
            ).map(
              ([key, value]) =>
                writeStoreValue(
                  key,
                  value,
                  'set'
                )
            )
          );

        return response.json({
          ok: true,
          rows
        });

      } catch (error) {
        console.error(
          '[Supabase] Mise à jour globale impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Mise à jour Supabase impossible.'
          });
      }
    }
  );


  app.get(
    '/api/store-node',
    async (
      request,
      response
    ) => {
      try {
        const path =
          request.query.path ||
          '';

        const value =
          await readStoreValue(
            path
          );

        return response.json({
          ok: true,
          path,
          value:
            neutralizeStoreValue(
              path,
              value
            )
        });

      } catch (error) {
        console.error(
          '[Supabase] Lecture de chemin impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Lecture Supabase impossible.'
          });
      }
    }
  );


  const handleStoreNodeWrite =
    async (
      request,
      response,
      mode
    ) => {
      try {
        const path =
          request.query.path ||
          '';

        const row =
          await writeStoreValue(
            path,
            request.body?.value,
            mode
          );

        return response.json({
          ok: true,
          path,
          value:
            row.value,
          updated_at:
            row.updated_at
        });

      } catch (error) {
        console.error(
          '[Supabase] Écriture de chemin impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Écriture Supabase impossible.'
          });
      }
    };


  app.put(
    '/api/store-node',
    (
      request,
      response
    ) =>
      handleStoreNodeWrite(
        request,
        response,
        'set'
      )
  );


  app.patch(
    '/api/store-node',
    (
      request,
      response
    ) =>
      handleStoreNodeWrite(
        request,
        response,
        'update'
      )
  );


  app.delete(
    '/api/store-node',
    async (
      request,
      response
    ) => {
      try {
        const client =
          getSupabaseClient();

        if (!client) {
          return response
            .status(503)
            .json({
              error:
                'Supabase non configuré.'
            });
        }

        const {
          key
        } =
          storeKeyFromPath(
            request.query.path ||
              ''
          );

        const {
          error
        } = await client
          .from(SUPABASE_TABLE)
          .delete()
          .eq(
            'key',
            key
          );

        if (error) {
          throw error;
        }

        return response.json({
          ok: true
        });

      } catch (error) {
        console.error(
          '[Supabase] Suppression de chemin impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Suppression Supabase impossible.'
          });
      }
    }
  );


  /* =======================================================
     STORE BY KEY
  ======================================================= */

  app.get(
    '/api/store/:key',
    async (
      request,
      response
    ) => {
      try {
        const value =
          await readStoreValue(
            request.params.key
          );

        return response.json({
          ok: true,
          key:
            request.params.key,
          value:
            neutralizeStoreValue(
              request.params.key,
              value
            )
        });

      } catch (error) {
        console.error(
          '[Supabase] Lecture impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Lecture Supabase impossible.'
          });
      }
    }
  );


  app.put(
    '/api/store/:key',
    async (
      request,
      response
    ) => {
      try {
        const row =
          await writeStoreValue(
            request.params.key,
            request.body?.value,
            'set'
          );

        return response.json({
          ok: true,
          ...row
        });

      } catch (error) {
        console.error(
          '[Supabase] Écriture impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Écriture Supabase impossible.'
          });
      }
    }
  );


  app.patch(
    '/api/store/:key',
    async (
      request,
      response
    ) => {
      try {
        const row =
          await writeStoreValue(
            request.params.key,
            request.body?.value ||
              {},
            'update'
          );

        return response.json({
          ok: true,
          ...row
        });

      } catch (error) {
        console.error(
          '[Supabase] Mise à jour impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Mise à jour Supabase impossible.'
          });
      }
    }
  );


  app.delete(
    '/api/store/:key',
    async (
      request,
      response
    ) => {
      try {
        const client =
          getSupabaseClient();

        if (!client) {
          return response
            .status(503)
            .json({
              error:
                'Supabase non configuré.'
            });
        }

        const {
          error
        } = await client
          .from(SUPABASE_TABLE)
          .delete()
          .eq(
            'key',
            storeKeyFromPath(
              request.params.key
            ).key
          );

        if (error) {
          throw error;
        }

        return response.json({
          ok: true
        });

      } catch (error) {
        console.error(
          '[Supabase] Suppression impossible :',
          error
        );

        return response
          .status(500)
          .json({
            error:
              error?.message ||
              'Suppression Supabase impossible.'
          });
      }
    }
  );


  /* =======================================================
     ONESIGNAL DIAGNOSTICS
  ======================================================= */

  app.get(
    '/api/notifications/status',
    async (
      _request,
      response
    ) => {
      try {
        const report =
          await getPushSubscriptionReport();

        return response.json({
          ok: true,

          appIdConfigured:
            Boolean(
              ONESIGNAL_APP_ID
            ),

          apiKeyConfigured:
            Boolean(
              ONESIGNAL_REST_API_KEY
            ),

          totalSubscriptions:
            report.total,

          activeSubscriptions:
            report.usable,

          subscriptions:
            report.subscriptions.map(
              subscription => ({
                id:
                  subscription.id ||
                  null,

                subscribed:
                  subscription.subscribed ===
                  true,

                enabled:
                  subscription.enabled !==
                  false,

                type:
                  subscription.type ||
                  null,

                platform:
                  subscription.platform ||
                  null,

                status:
                  subscription.status ||
                  null
              })
            )
        });

      } catch (error) {
        console.error(
          '[OneSignal] Status impossible :',
          error?.details ||
          error
        );

        return response
          .status(502)
          .json({
            ok: false,
            error:
              error?.message ||
              'Impossible de lire les subscriptions OneSignal.',
            details:
              error?.details ||
              null
          });
      }
    }
  );


  /* =======================================================
     SEND PRODUCT NOTIFICATION
  ======================================================= */

  app.post(
    '/api/notifications/product',
    async (
      request,
      response
    ) => {
      try {
        const result =
          await sendOneSignalNotification(
            request.body || {}
          );

        return response
          .status(202)
          .json({
            ok: true,
            handled: true,
            data:
              result
          });

      } catch (error) {
        console.error(
          '[OneSignal] Notification produit impossible :',
          error?.details ||
          error
        );

        return response
          .status(502)
          .json({
            ok: false,

            handled:
              false,

            code:
              error?.code ||
              'ONESIGNAL_ERROR',

            error:
              error?.message ||
              'Notification impossible.',

            details:
              error?.details ||
              null
          });
      }
    }
  );


  /* =======================================================
     PUSH EVENTS
  ======================================================= */

  app.post(
    '/api/push-events',
    async (
      request,
      response
    ) => {
      try {
        const result =
          await sendOneSignalNotification(
            request.body || {}
          );

        return response
          .status(202)
          .json({
            ok: true,
            handled: true,
            data:
              result
          });

      } catch (error) {
        console.error(
          '[OneSignal] Événement push impossible :',
          error?.details ||
          error
        );

        return response
          .status(502)
          .json({
            ok: false,

            handled:
              false,

            code:
              error?.code ||
              'ONESIGNAL_ERROR',

            error:
              error?.message ||
              'Notification impossible.',

            details:
              error?.details ||
              null
          });
      }
    }
  );


  /* =======================================================
     IMAGE UPLOAD
  ======================================================= */

  app.post(
    '/api/upload',
    async (
      request,
      response
    ) => {
      try {
        const {
          dataUrl,
          folder
        } =
          request.body || {};

        if (!dataUrl) {
          return response
            .status(400)
            .json({
              error:
                'dataUrl obligatoire.'
            });
        }

        if (
          folder !==
            'products' &&
          folder !==
            'reviews'
        ) {
          return response
            .status(400)
            .json({
              error:
                'Dossier invalide.'
            });
        }

        const expectedToken =
          String(
            process.env.UPLOAD_TOKEN ||
              ''
          ).trim();

        if (
          expectedToken &&
          request.get(
            'X-Upload-Token'
          ) !== expectedToken
        ) {
          return response
            .status(401)
            .json({
              error:
                'Upload non autorisé.'
            });
        }

        const normalizedDataUrl =
          validateBase64Image(
            dataUrl
          );

        return response
          .status(201)
          .json({
            ok: true,

            url:
              normalizedDataUrl,

            imageUrl:
              normalizedDataUrl,

            dataUrl:
              normalizedDataUrl,

            path:
              folder,

            contentType:
              'image'
          });

      } catch (error) {
        console.error(
          '[Upload] Échec validation Base64 :',
          error
        );

        return response
          .status(400)
          .json({
            error:
              error?.message ||
              'Upload impossible.'
          });
      }
    }
  );


  /* =======================================================
     HEALTH
  ======================================================= */

  app.get(
    '/health',
    async (
      _request,
      response
    ) => {
      let oneSignalStatus = {
        configured:
          Boolean(
            ONESIGNAL_APP_ID &&
            ONESIGNAL_REST_API_KEY
          ),

        activeSubscriptions:
          null
      };

      try {
        if (
          oneSignalStatus.configured
        ) {
          const report =
            await getPushSubscriptionReport();

          oneSignalStatus =
            {
              configured:
                true,

              activeSubscriptions:
                report.usable,

              totalSubscriptions:
                report.total,

              api:
                ONESIGNAL_URL
            };
        }
      } catch (error) {
        oneSignalStatus =
          {
            configured:
              true,

            activeSubscriptions:
              null,

            error:
              error?.message ||
              'OneSignal status unavailable'
          };
      }


      return response
        .status(200)
        .json({
          ok: true,

          service:
            'emil-supabase-push-worker',

          dataProvider:
            getSupabaseClient()
              ? 'supabase'
              : 'not-configured',

          legacyFirebasePushPath:
            EVENTS_PATH,

          oneSignal:
            oneSignalStatus,

          timestamp:
            new Date().toISOString()
        });
    }
  );


  /* =======================================================
     ROOT
  ======================================================= */

  app.get(
    '/',
    (
      _request,
      response
    ) =>
      response
        .status(200)
        .send(
          'L’Empreinte d’Emil push service is running.'
        )
  );


  return app;
}


/* =========================================================
   START SERVER
========================================================= */

async function main() {
  const app =
    createServer();


  /*
   * Supabase = source principale
   */
  if (
    getSupabaseClient()
  ) {
    console.log(
      `[Supabase] Mode principal actif sur la table ${SUPABASE_TABLE}; Firebase historique désactivé.`
    );

    if (
      ONESIGNAL_APP_ID &&
      ONESIGNAL_REST_API_KEY
    ) {
      console.log(
        `[OneSignal] Configuration détectée pour App ID ${ONESIGNAL_APP_ID}`
      );

      try {
        const report =
          await getPushSubscriptionReport();

        console.log(
          `[OneSignal] ${report.usable}/${report.total} subscription(s) Push utilisable(s).`
        );

      } catch (error) {
        console.warn(
          '[OneSignal] Impossible de vérifier les subscriptions au démarrage :',
          error?.details ||
          error
        );
      }
    }

  } else {

    /*
     * Compatibilité Firebase historique
     */
    const firebaseApp =
      initFirebaseAdmin();

    const db =
      admin.database(
        firebaseApp
      );

    await db
      .ref('.info/connected')
      .once('value')
      .catch(
        error => {
          console.warn(
            '[Firebase] Vérification initiale indisponible, le listener sera tout de même démarré.',
            error.message
          );
        }
      );

    startPushEventListener(
      db
    );
  }


  app.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `[HTTP] Serveur Express à l’écoute sur le port ${PORT}`
      );

      console.log(
        `[HTTP] Port: ${PORT}`
      );

      console.log(
        `[HTTP] OneSignal: ${
          ONESIGNAL_APP_ID
            ? 'configured'
            : 'missing'
        }`
      );
    }
  );
}


main()
  .catch(
    error => {
      console.error(
        '[Startup] Démarrage impossible',
        error
      );

      process.exit(1);
    }
  );


export {
  createServer,
  notificationPayload,
  processPushEvent,
  sendOneSignalNotification
};
