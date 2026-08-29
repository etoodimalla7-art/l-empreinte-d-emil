import express from 'express';
import admin from 'firebase-admin';
import cryptoModule from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app';

const SUPABASE_URL =
  String(process.env.SUPABASE_URL || '').trim();

const SUPABASE_SERVICE_ROLE_KEY =
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const SUPABASE_TABLE =
  String(process.env.SUPABASE_TABLE || 'store_data').trim();

/*
 * IMPORTANT:
 * Current OneSignal REST API.
 */
const ONESIGNAL_URL =
  'https://api.onesignal.com/notifications';

const ONESIGNAL_EVENTS_PATH =
  'https://api.onesignal.com/notifications';

const EVENTS_PATH =
  'storedData/pushEvents';

/*
 * Maximum image size accepted by the /api/upload endpoint.
 */
const MAX_UPLOAD_BYTES =
  2 * 1024 * 1024;

/*
 * OneSignal network timeout.
 */
const ONESIGNAL_TIMEOUT_MS =
  15000;


/* =========================================================
   ENVIRONMENT HELPERS
========================================================= */

function requiredEnv(name) {
  const value = process.env[name];

  if (!value || !String(value).trim()) {
    throw new Error(
      `Variable d’environnement manquante : ${name}`
    );
  }

  return String(value).trim();
}


/* =========================================================
   FIREBASE PRIVATE KEY
========================================================= */

function normalizePrivateKey(rawValue) {
  let key = String(rawValue || '')
    .replace(/^\uFEFF/, '')
    .trim();

  /*
   * Accept JSON-string formatted private keys.
   */
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

  /*
   * Convert escaped line breaks to real line breaks.
   */
  key = key
    .replace(/\\+r\\+n/g, '\n')
    .replace(/\\+n/g, '\n')
    .replace(/\\+r/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .trim();

  const begin =
    '-----BEGIN PRIVATE KEY-----';

  const end =
    '-----END PRIVATE KEY-----';

  const beginIndex =
    key.indexOf(begin);

  const endIndex =
    key.indexOf(end);

  if (
    beginIndex < 0 ||
    endIndex < 0 ||
    endIndex <= beginIndex
  ) {
    throw new Error(
      'Clé Firebase invalide : délimiteurs PEM absents ou mal ordonnés.'
    );
  }

  key =
    key
      .slice(
        beginIndex,
        endIndex + end.length
      )
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


/* =========================================================
   FIREBASE SERVICE ACCOUNT
========================================================= */

function parseServiceAccountJson() {
  const raw =
    requiredEnv('FIREBASE_SERVICE_ACCOUNT_JSON');

  let json = raw;

  if (
    raw.startsWith('"') &&
    raw.endsWith('"')
  ) {
    try {
      json = JSON.parse(raw);
    } catch {
      /* Continue with raw JSON */
    }
  }

  try {
    const account =
      JSON.parse(json);

    if (
      !account ||
      typeof account !== 'object'
    ) {
      throw new Error(
        'objet JSON attendu'
      );
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
          project_id:
            requiredEnv('FIREBASE_PROJECT_ID'),

          client_email:
            requiredEnv('FIREBASE_CLIENT_EMAIL'),

          private_key:
            requiredEnv('FIREBASE_PRIVATE_KEY')
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
    credential:
      buildFirebaseCredential(),

    databaseURL:
      DATABASE_URL
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
  let decoded =
    String(pathValue || '');

  try {
    decoded =
      decodeURIComponent(decoded);
  } catch {
    /* Keep raw value */
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
    key:
      parts.shift() || '',

    parts
  };
}


function setNestedValue(
  root,
  parts,
  value
) {
  if (!parts.length) {
    return value;
  }

  const next =
    root &&
    typeof root === 'object'
      ? structuredClone(root)
      : {};

  let cursor = next;

  parts
    .slice(0, -1)
    .forEach(part => {
      if (
        !cursor[part] ||
        typeof cursor[part] !== 'object'
      ) {
        cursor[part] = {};
      }

      cursor =
        cursor[part];
    });

  cursor[
    parts.at(-1)
  ] = value;

  return next;
}


function getNestedValue(
  root,
  parts
) {
  return parts.reduce(
    (value, part) =>
      value == null
        ? null
        : value[part],
    root
  );
}


function emptyStoreValue(
  pathValue
) {
  const {
    key,
    parts
  } =
    storeKeyFromPath(
      pathValue
    );

  if (parts.length) {
    return {};
  }

  const collectionKeys =
    new Set([
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


function neutralizeStoreValue(
  pathValue,
  value
) {
  return value === null ||
    value === undefined
    ? emptyStoreValue(pathValue)
    : value;
}


async function readStoreValue(
  pathValue
) {
  const client =
    getSupabaseClient();

  if (!client) {
    throw new Error(
      'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.'
    );
  }

  const {
    key,
    parts
  } =
    storeKeyFromPath(
      pathValue
    );

  if (!key) {
    return {};
  }

  const {
    data,
    error
  } =
    await client
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
  const client =
    getSupabaseClient();

  if (!client) {
    throw new Error(
      'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.'
    );
  }

  const {
    key,
    parts
  } =
    storeKeyFromPath(
      pathValue
    );

  if (!key) {
    throw new Error(
      'Clé de stockage obligatoire.'
    );
  }

  let nextValue =
    value;

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
            ...(current &&
            typeof current === 'object'
              ? current
              : {}),

            ...(value &&
            typeof value === 'object'
              ? value
              : {})
          };
  }

  const {
    data,
    error
  } =
    await client
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
   TEXT / PRODUCT HELPERS
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


function eventProduct(
  eventData
) {
  return eventData?.product &&
    typeof eventData.product === 'object'
    ? eventData.product
    : eventData;
}


/* =========================================================
   URL VALIDATION
========================================================= */

function isHttpsUrl(
  value
) {
  if (!value) {
    return false;
  }

  try {
    const parsed =
      new URL(value);

    return (
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}


/*
 * OneSignal images need to be remotely accessible.
 * Data URLs from Firebase are therefore NOT sent as
 * notification images.
 */
function normalizeNotificationImage(
  value
) {
  const image =
    cleanText(value);

  if (!image) {
    return '';
  }

  if (!isHttpsUrl(image)) {
    console.warn(
      '[OneSignal] Image ignorée car elle n’est pas HTTPS.'
    );

    return '';
  }

  return image;
}


function normalizeNotificationUrl(
  value
) {
  const fallback =
    'https://lempreinte-demil.onrender.com/';

  const url =
    cleanText(
      value,
      fallback
    );

  if (
    isHttpsUrl(url)
  ) {
    return url;
  }

  console.warn(
    '[OneSignal] URL invalide, utilisation de l’URL principale.'
  );

  return fallback;
}


/* =========================================================
   ONESIGNAL PAYLOAD
========================================================= */

function notificationPayload(
  eventData
) {
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

  const rawImage =
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

  const image =
    normalizeNotificationImage(
      rawImage
    );

  const url =
    normalizeNotificationUrl(
      eventData?.url
    );

  const subscriptionId =
    cleanText(
      eventData?.subscriptionId,
      cleanText(
        eventData?.subscription_id
      )
    );

  /*
   * IMPORTANT:
   *
   * include_subscription_ids cannot be combined
   * with included_segments.
   */
  const payload = {
    app_id:
      requiredEnv(
        'ONESIGNAL_APP_ID'
      ),

    target_channel:
      'push',

    headings: {
      fr: title,
      en: title
    },

    contents: {
      fr: body,
      en: body
    },

    url,

    custom_data: {
      type: 'new-product',

      productId:
        cleanText(
          eventData?.productId,
          cleanText(
            product?.id
          )
        ),

      image:
        image || ''
    }
  };

  /*
   * If the frontend knows the exact browser
   * subscription, send directly to that browser.
   */
  if (subscriptionId) {
    payload.include_subscription_ids = [
      subscriptionId
    ];
  } else {
    /*
     * Otherwise send to all active Push subscribers.
     */
    payload.included_segments = [
      'Subscribed Users'
    ];
  }

  /*
   * Only add image properties when the image
   * is a valid HTTPS URL.
   */
  if (image) {
    payload.big_picture =
      image;

    payload.chrome_web_image =
      image;

    payload.chrome_web_icon =
      image;
  }

  return payload;
}


/* =========================================================
   FETCH WITH TIMEOUT
========================================================= */

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = ONESIGNAL_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}


/* =========================================================
   SEND ONESIGNAL
========================================================= */

async function sendOneSignalNotification(
  eventData
) {
  const payload =
    notificationPayload(
      eventData
    );

  console.log(
    '[OneSignal] Sending notification:',
    {
      target:
        payload.include_subscription_ids
          ? 'specific subscription'
          : 'Subscribed Users',

      title:
        payload.headings?.fr,

      hasImage:
        Boolean(
          payload.chrome_web_image
        )
    }
  );

  const response =
    await fetchWithTimeout(
      ONESIGNAL_URL,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Key ${requiredEnv(
              'ONESIGNAL_REST_API_KEY'
            )}`,

          'Content-Type':
            'application/json',

          Accept:
            'application/json'
        },

        body:
          JSON.stringify(
            payload
          )
      },

      ONESIGNAL_TIMEOUT_MS
    );

  const responseText =
    await response.text();

  let responseData;

  try {
    responseData =
      responseText
        ? JSON.parse(
            responseText
          )
        : {};
  } catch {
    responseData = {
      raw:
        responseText
    };
  }

  /*
   * OneSignal may return HTTP 200 but without
   * a message ID when no valid subscriptions
   * exist.
   */
  if (!response.ok) {
    const error =
      new Error(
        `OneSignal HTTP ${response.status}`
      );

    error.details =
      responseData;

    throw error;
  }

  if (!responseData?.id) {
    const error =
      new Error(
        'OneSignal n’a créé aucun message. Aucun abonnement Push valide n’a probablement été trouvé.'
      );

    error.details =
      responseData;

    throw error;
  }

  console.log(
    '[OneSignal] Message created successfully:',
    responseData.id
  );

  return responseData;
}


/* =========================================================
   ONESIGNAL DELIVERY STATUS
========================================================= */

async function getOneSignalMessageStatus(
  messageId
) {
  const appId =
    requiredEnv(
      'ONESIGNAL_APP_ID'
    );

  const url =
    `${ONESIGNAL_EVENTS_PATH}/${encodeURIComponent(
      messageId
    )}?app_id=${encodeURIComponent(
      appId
    )}`;

  const response =
    await fetchWithTimeout(
      url,
      {
        method: 'GET',

        headers: {
          Authorization:
            `Key ${requiredEnv(
              'ONESIGNAL_REST_API_KEY'
            )}`,

          Accept:
            'application/json'
        }
      },

      10000
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
        `OneSignal status HTTP ${response.status}`
      );

    error.details =
      data;

    throw error;
  }

  return data;
}


/* =========================================================
   FIREBASE PUSH EVENT CLAIMING
========================================================= */

async function claimEvent(
  eventRef
) {
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
            admin.database.ServerValue.TIMESTAMP
        };
      }
    );

  return result.committed
    ? result.snapshot.val()
    : null;
}


async function processPushEvent(
  snapshot
) {
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
        admin.database.ServerValue.TIMESTAMP,

      oneSignalNotificationId:
        oneSignalResult.id ||
        null,

      lastError:
        null
    });

    console.log(
      `[Push] Notification OneSignal créée pour ${eventId}:`,
      oneSignalResult.id
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
          admin.database.ServerValue.TIMESTAMP
      });
    } catch (updateError) {
      console.error(
        `[Push] Impossible d’enregistrer l’erreur pour ${eventId}`,
        updateError
      );
    }
  }
}


/* =========================================================
   FIREBASE PUSH LISTENER
========================================================= */

function startPushEventListener(
  db
) {
  const eventsRef =
    db.ref(
      EVENTS_PATH
    );

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
   IMAGE UPLOAD VALIDATION
========================================================= */

function validateBase64Image(
  value
) {
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

function allowedOrigin(
  origin
) {
  if (!origin) {
    return true;
  }

  const configured =
    String(
      process.env.FRONTEND_ORIGINS ||
      ''
    )
      .split(',')
      .map(
        value =>
          value.trim()
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

  return allowed.has(
    origin
  );
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


  /* =======================================================
     CORS
  ======================================================= */

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
        return response.sendStatus(
          204
        );
      }

      next();
    }
  );


  /* =======================================================
     JSON
  ======================================================= */

  app.use(
    express.json({
      limit: '12mb'
    })
  );


  /* =======================================================
     ONESIGNAL SERVICE WORKER
  ======================================================= */

  app.get(
    '/OneSignalSDKWorker.js',
    (_request, response) => {
      response
        .status(200)
        .type('application/javascript')
        .set(
          'Cache-Control',
          'public, max-age=3600'
        )
        .send(
          'importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");'
        );
    }
  );


  /* =======================================================
     STORE - FULL
  ======================================================= */

  app.get(
    '/api/store',
    async (
      _request,
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
          data,
          error
        } =
          await client
            .from(
              SUPABASE_TABLE
            )
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
          ok:
            true,

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


  /* =======================================================
     STORE - PATCH FULL
  ======================================================= */

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
          Array.isArray(updates)
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
              ([
                key,
                value
              ]) =>
                writeStoreValue(
                  key,
                  value,
                  'set'
                )
            )
          );

        return response.json({
          ok:
            true,

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


  /* =======================================================
     STORE NODE - GET
  ======================================================= */

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
          ok:
            true,

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


  /* =======================================================
     STORE NODE - WRITE
  ======================================================= */

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
          ok:
            true,

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


  /* =======================================================
     STORE NODE - DELETE
  ======================================================= */

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
        } =
          await client
            .from(
              SUPABASE_TABLE
            )
            .delete()
            .eq(
              'key',
              key
            );

        if (error) {
          throw error;
        }

        return response.json({
          ok:
            true
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
     STORE KEY - GET
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
          ok:
            true,

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


  /* =======================================================
     STORE KEY - PUT
  ======================================================= */

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
          ok:
            true,

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


  /* =======================================================
     STORE KEY - PATCH
  ======================================================= */

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
          ok:
            true,

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


  /* =======================================================
     STORE KEY - DELETE
  ======================================================= */

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
        } =
          await client
            .from(
              SUPABASE_TABLE
            )
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
          ok:
            true
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
     ADMIN PUSH NOTIFICATION
  ======================================================= */

  app.post(
    '/api/notifications/product',
    async (
      request,
      response
    ) => {
      try {
        const body =
          request.body || {};

        console.log(
          '[Admin Push] Request received:',
          {
            title:
              body.title,

            hasBody:
              Boolean(
                body.body
              ),

            hasImage:
              Boolean(
                body.image
              ),

            url:
              body.url,

            subscriptionId:
              body.subscriptionId
                ? 'provided'
                : 'not provided'
          }
        );

        const result =
          await sendOneSignalNotification(
            body
          );

        /*
         * DO NOT return success unless OneSignal
         * actually returned a message ID.
         */
        return response
          .status(200)
          .json({
            ok:
              true,

            handled:
              true,

            messageId:
              result.id,

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
            ok:
              false,

            handled:
              false,

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
            request.body ||
              {}
          );

        return response
          .status(200)
          .json({
            ok:
              true,

            handled:
              true,

            messageId:
              result.id,

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
            ok:
              false,

            handled:
              false,

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
     ONESIGNAL DELIVERY STATUS
  ======================================================= */

  app.get(
    '/api/notifications/status/:messageId',
    async (
      request,
      response
    ) => {
      try {
        const messageId =
          String(
            request.params.messageId ||
              ''
          ).trim();

        if (!messageId) {
          return response
            .status(400)
            .json({
              ok:
                false,

              error:
                'messageId manquant.'
            });
        }

        const status =
          await getOneSignalMessageStatus(
            messageId
          );

        return response.json({
          ok:
            true,

          status
        });
      } catch (error) {
        console.error(
          '[OneSignal] Impossible de récupérer le statut :',
          error?.details ||
            error
        );

        return response
          .status(502)
          .json({
            ok:
              false,

            error:
              error?.message ||
              'Statut OneSignal indisponible.',

            details:
              error?.details ||
              null
          });
      }
    }
  );


  /* =======================================================
     UPLOAD
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
          folder !== 'products' &&
          folder !== 'reviews'
        ) {
          return response
            .status(400)
            .json({
              error:
                'Dossier invalide.'
            });
        }

        /*
         * Optional upload protection.
         */
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

        /*
         * No object storage.
         * The validated data URL is returned
         * to the frontend.
         */
        return response
          .status(201)
          .json({
            ok:
              true,

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
    (_request, response) =>
      response
        .status(200)
        .json({
          ok:
            true,

          service:
            'emil-supabase-push-worker',

          dataProvider:
            getSupabaseClient()
              ? 'supabase'
              : 'firebase',

          legacyFirebasePushPath:
            EVENTS_PATH,

          oneSignal:
            {
              configured:
                Boolean(
                  process.env.ONESIGNAL_APP_ID &&
                  process.env.ONESIGNAL_REST_API_KEY
                ),

              api:
                ONESIGNAL_URL
            },

          timestamp:
            new Date().toISOString()
        })
  );


  /* =======================================================
     ROOT
  ======================================================= */

  app.get(
    '/',
    (_request, response) =>
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
   * Supabase remains the primary store
   * exactly as in your original architecture.
   */
  if (getSupabaseClient()) {
    console.log(
      `[Supabase] Mode principal actif sur la table ${SUPABASE_TABLE}; Firebase historique désactivé.`
    );
  } else {
    /*
     * Legacy Firebase fallback.
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
      .catch(error => {
        console.warn(
          '[Firebase] Vérification initiale indisponible, le listener sera tout de même démarré.',
          error.message
        );
      });

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
        `[OneSignal] API: ${ONESIGNAL_URL}`
      );

      console.log(
        `[OneSignal] Configured: ${
          Boolean(
            process.env.ONESIGNAL_APP_ID &&
            process.env.ONESIGNAL_REST_API_KEY
          )
        }`
      );

      console.log(
        '[OneSignal] Service worker: /OneSignalSDKWorker.js'
      );
    }
  );
}


/* =========================================================
   STARTUP ERROR HANDLING
========================================================= */

main().catch(
  error => {
    console.error(
      '[Startup] Démarrage impossible',
      error
    );

    process.exit(1);
  }
);


/* =========================================================
   EXPORTS
========================================================= */

export {
  createServer,
  notificationPayload,
  processPushEvent,
  sendOneSignalNotification,
  getOneSignalMessageStatus
};
