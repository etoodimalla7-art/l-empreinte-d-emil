import express from 'express';
import admin from 'firebase-admin';
import cryptoModule from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/*
|--------------------------------------------------------------------------
| L'EMPREINTE D'EMIL — BACKEND / SERVER
|--------------------------------------------------------------------------
| Express
| Supabase
| Firebase Realtime Database compatibility
| OneSignal Push Notifications
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app';

/*
|--------------------------------------------------------------------------
| SUPABASE
|--------------------------------------------------------------------------
*/

const SUPABASE_URL =
  String(process.env.SUPABASE_URL || '').trim();

const SUPABASE_SERVICE_ROLE_KEY =
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const SUPABASE_TABLE =
  String(process.env.SUPABASE_TABLE || 'store_data').trim();

/*
|--------------------------------------------------------------------------
| ONESIGNAL
|--------------------------------------------------------------------------
*/

const ONESIGNAL_URL =
  'https://api.onesignal.com/notifications?c=push';

const ONESIGNAL_APP_ID =
  String(process.env.ONESIGNAL_APP_ID || '').trim();

const ONESIGNAL_REST_API_KEY =
  String(process.env.ONESIGNAL_REST_API_KEY || '').trim();

/*
|--------------------------------------------------------------------------
| TEST SUBSCRIPTION
|--------------------------------------------------------------------------
|
| This must contain:
|
| 2115f28d-a830-4155-bd15-fadb80ff40ab
|
| This is the value returned by:
|
| OneSignal.User.PushSubscription.id
|
| DO NOT put OneSignal.User.onesignalId here.
|--------------------------------------------------------------------------
*/

const ONESIGNAL_TEST_SUBSCRIPTION_ID =
  String(
    process.env.ONESIGNAL_TEST_SUBSCRIPTION_ID || ''
  ).trim();

/*
|--------------------------------------------------------------------------
| FIREBASE PUSH EVENTS
|--------------------------------------------------------------------------
*/

const EVENTS_PATH =
  'storedData/pushEvents';

/*
|--------------------------------------------------------------------------
| UPLOAD
|--------------------------------------------------------------------------
*/

const MAX_UPLOAD_BYTES =
  2 * 1024 * 1024;

/*
|--------------------------------------------------------------------------
| UTILS
|--------------------------------------------------------------------------
*/

function requiredEnv(name) {
  const value =
    process.env[name];

  if (
    !value ||
    !String(value).trim()
  ) {
    throw new Error(
      `Variable d’environnement manquante : ${name}`
    );
  }

  return String(value).trim();
}

/*
|--------------------------------------------------------------------------
| FIREBASE PRIVATE KEY
|--------------------------------------------------------------------------
*/

function normalizePrivateKey(rawValue) {
  let key =
    String(rawValue || '')
      .replace(/^\uFEFF/, '')
      .trim();

  if (
    key.startsWith('"') &&
    key.endsWith('"')
  ) {
    try {
      const parsed =
        JSON.parse(key);

      if (
        typeof parsed ===
        'string'
      ) {
        key = parsed;
      }
    } catch {
      key =
        key.slice(1, -1);
    }
  }

  key =
    key
      .replace(
        /\\+r\\+n/g,
        '\n'
      )
      .replace(
        /\\+n/g,
        '\n'
      )
      .replace(
        /\\+r/g,
        '\n'
      )
      .replace(
        /[\t ]+$/gm,
        ''
      )
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

/*
|--------------------------------------------------------------------------
| FIREBASE SERVICE ACCOUNT JSON
|--------------------------------------------------------------------------
*/

function parseServiceAccountJson() {
  const raw =
    requiredEnv(
      'FIREBASE_SERVICE_ACCOUNT_JSON'
    );

  let json =
    raw;

  if (
    raw.startsWith('"') &&
    raw.endsWith('"')
  ) {
    try {
      json =
        JSON.parse(raw);
    } catch {
      // Parsing direct ci-dessous.
    }
  }

  try {
    const account =
      JSON.parse(json);

    if (
      !account ||
      typeof account !==
        'object'
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

/*
|--------------------------------------------------------------------------
| FIREBASE CREDENTIAL
|--------------------------------------------------------------------------
*/

function buildFirebaseCredential() {
  const account =
    process.env
      .FIREBASE_SERVICE_ACCOUNT_JSON
      ?.trim()
      ? parseServiceAccountJson()
      : {
          project_id:
            requiredEnv(
              'FIREBASE_PROJECT_ID'
            ),

          client_email:
            requiredEnv(
              'FIREBASE_CLIENT_EMAIL'
            ),

          private_key:
            requiredEnv(
              'FIREBASE_PRIVATE_KEY'
            )
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

  if (
    !projectId ||
    !clientEmail
  ) {
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

/*
|--------------------------------------------------------------------------
| FIREBASE ADMIN
|--------------------------------------------------------------------------
*/

function initFirebaseAdmin() {
  if (
    admin.apps.length
  ) {
    return admin.app();
  }

  return admin.initializeApp({
    credential:
      buildFirebaseCredential(),

    databaseURL:
      DATABASE_URL
  });
}

/*
|--------------------------------------------------------------------------
| SUPABASE CLIENT
|--------------------------------------------------------------------------
*/

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
        persistSession:
          false,

        autoRefreshToken:
          false
      }
    }
  );
}

/*
|--------------------------------------------------------------------------
| STORE PATH HELPERS
|--------------------------------------------------------------------------
*/

function storeKeyFromPath(
  pathValue
) {
  let decoded =
    String(
      pathValue || ''
    );

  try {
    decoded =
      decodeURIComponent(
        decoded
      );
  } catch {
    // Garder la valeur brute.
  }

  const normalized =
    decoded
      .replace(
        /^\/+|\/+$/g,
        ''
      )
      .replace(
        /^storedData\//,
        ''
      );

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
  if (
    !parts.length
  ) {
    return value;
  }

  const next =
    root &&
    typeof root ===
      'object'
      ? structuredClone(root)
      : {};

  let cursor =
    next;

  parts
    .slice(0, -1)
    .forEach(
      part => {
        if (
          !cursor[part] ||
          typeof cursor[part] !==
            'object'
        ) {
          cursor[part] = {};
        }

        cursor =
          cursor[part];
      }
    );

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
    (
      value,
      part
    ) =>
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

  if (
    parts.length
  ) {
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

  return collectionKeys.has(
    key
  )
    ? []
    : {};
}

function neutralizeStoreValue(
  pathValue,
  value
) {
  return value === null ||
    value === undefined
    ? emptyStoreValue(
        pathValue
      )
    : value;
}

/*
|--------------------------------------------------------------------------
| SUPABASE READ
|--------------------------------------------------------------------------
*/

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
      .from(
        SUPABASE_TABLE
      )
      .select('value')
      .eq(
        'key',
        key
      )
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

/*
|--------------------------------------------------------------------------
| SUPABASE WRITE
|--------------------------------------------------------------------------
*/

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
      await readStoreValue(
        key
      );

    if (
      parts.length
    ) {
      nextValue =
        setNestedValue(
          current,
          parts,
          value
        );
    } else {
      nextValue = {
        ...(
          current &&
          typeof current ===
            'object'
            ? current
            : {}
        ),

        ...(
          value &&
          typeof value ===
            'object'
            ? value
            : {}
        )
      };
    }
  }

  const {
    data,
    error
  } =
    await client
      .from(
        SUPABASE_TABLE
      )
      .upsert(
        {
          key,

          value:
            nextValue,

          updated_at:
            new Date()
              .toISOString()
        },
        {
          onConflict:
            'key'
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

/*
|--------------------------------------------------------------------------
| TEXT
|--------------------------------------------------------------------------
*/

function cleanText(
  value,
  fallback = ''
) {
  return typeof value ===
    'string' &&
    value.trim()
    ? value.trim()
    : fallback;
}

/*
|--------------------------------------------------------------------------
| PRODUCT
|--------------------------------------------------------------------------
*/

function eventProduct(
  eventData
) {
  return eventData?.product &&
    typeof eventData.product ===
      'object'
    ? eventData.product
    : eventData;
}

/*
|--------------------------------------------------------------------------
| IMAGE
|--------------------------------------------------------------------------
*/

function getNotificationImage(
  eventData
) {
  const product =
    eventProduct(
      eventData
    );

  const candidates = [
    eventData?.image,
    eventData?.imageUrl,
    product?.image,
    product?.imageUrl,

    Array.isArray(
      product?.imgs
    )
      ? product.imgs[0]
      : ''
  ];

  for (
    const candidate of
      candidates
  ) {
    const value =
      cleanText(
        candidate
      );

    if (
      value &&
      /^https?:\/\//i.test(
        value
      )
    ) {
      return value;
    }
  }

  return '';
}

/*
|--------------------------------------------------------------------------
| ONESIGNAL SUBSCRIPTION IDS
|--------------------------------------------------------------------------
|
| Priority:
|
| 1. subscriptionIds
| 2. subscription_ids
| 3. subscriptionId
| 4. subscription_id
|
| IMPORTANT:
| We DO NOT use OneSignal.User.onesignalId here.
|
|--------------------------------------------------------------------------
*/

function getSubscriptionIds(
  eventData = {},
  allowTestFallback = false
) {
  const ids =
    [];

  const add =
    value => {
      if (
        typeof value !==
          'string'
      ) {
        return;
      }

      const cleaned =
        value.trim();

      if (!cleaned) {
        return;
      }

      if (
        !ids.includes(
          cleaned
        )
      ) {
        ids.push(
          cleaned
        );
      }
    };

  if (
    Array.isArray(
      eventData.subscriptionIds
    )
  ) {
    eventData.subscriptionIds
      .forEach(add);
  }

  if (
    Array.isArray(
      eventData.subscription_ids
    )
  ) {
    eventData.subscription_ids
      .forEach(add);
  }

  add(
    eventData.subscriptionId
  );

  add(
    eventData.subscription_id
  );

  /*
  |--------------------------------------------------------------------------
  | TEST FALLBACK
  |--------------------------------------------------------------------------
  |
  | Only the dedicated TEST endpoint can use this fallback.
  |
  */

  if (
    ids.length === 0 &&
    allowTestFallback &&
    ONESIGNAL_TEST_SUBSCRIPTION_ID
  ) {
    add(
      ONESIGNAL_TEST_SUBSCRIPTION_ID
    );
  }

  return ids;
}

/*
|--------------------------------------------------------------------------
| ONESIGNAL PAYLOAD
|--------------------------------------------------------------------------
*/

function notificationPayload(
  eventData = {},
  options = {}
) {
  const {
    allowTestFallback = false
  } =
    options;

  const product =
    eventProduct(
      eventData
    );

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
    getNotificationImage(
      eventData
    );

  const url =
    cleanText(
      eventData?.url,

      'https://l-empreinte-d-emil-1.onrender.com/'
    );

  /*
  |--------------------------------------------------------------------------
  | SUBSCRIPTION TARGETS
  |--------------------------------------------------------------------------
  */

  const subscriptionIds =
    getSubscriptionIds(
      eventData,
      allowTestFallback
    );

  /*
  |--------------------------------------------------------------------------
  | BASE PAYLOAD
  |--------------------------------------------------------------------------
  */

  const payload = {
    app_id:
      requiredEnv(
        'ONESIGNAL_APP_ID'
      ),

    target_channel:
      'push',

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
      type:
        'new-product',

      productId:
        cleanText(
          eventData?.productId,

          cleanText(
            product?.id
          )
        ),

      image:
        image || ''
    },

    /*
    |--------------------------------------------------------------------------
    | Idempotency
    |--------------------------------------------------------------------------
    |
    | Prevent accidental duplicate sends when the same request is retried.
    |
    */

    idempotency_key:
      cleanText(
        eventData?.idempotencyKey,
        cryptoModule.randomUUID()
      )
  };

  /*
  |--------------------------------------------------------------------------
  | IMAGE
  |--------------------------------------------------------------------------
  */

  if (
    image &&
    /^https?:\/\//i.test(
      image
    )
  ) {
    payload.big_picture =
      image;

    payload.chrome_web_image =
      image;

    payload.large_icon =
      image;
  }

  /*
  |--------------------------------------------------------------------------
  | TARGETING
  |--------------------------------------------------------------------------
  |
  | OneSignal allows ONE targeting method per message.
  |
  | Specific subscription:
  | include_subscription_ids
  |
  | Broadcast:
  | included_segments
  |
  |--------------------------------------------------------------------------
  */

  if (
    subscriptionIds.length > 0
  ) {
    payload.include_subscription_ids =
      subscriptionIds;

    console.log(
      '[OneSignal] Targeting specific subscriptions:',
      subscriptionIds
    );
  } else {
    /*
    |--------------------------------------------------------------------------
    | BROADCAST TO SUBSCRIBED USERS
    |--------------------------------------------------------------------------
    |
    | "Subscribed Users" is preferable to "All" because we only want users
    | who actually have a subscribed push channel.
    |
    */

    payload.included_segments =
      [
        'Subscribed Users'
      ];

    console.log(
      '[OneSignal] Targeting segment: Subscribed Users'
    );
  }

  /*
  |--------------------------------------------------------------------------
  | DEBUG
  |--------------------------------------------------------------------------
  */

  console.log(
    '[OneSignal] Final payload:',
    JSON.stringify(
      payload,
      null,
      2
    )
  );

  return payload;
}

/*
|--------------------------------------------------------------------------
| SEND ONESIGNAL NOTIFICATION
|--------------------------------------------------------------------------
*/

async function sendOneSignalNotification(
  eventData = {},
  options = {}
) {
  const appId =
    requiredEnv(
      'ONESIGNAL_APP_ID'
    );

  const apiKey =
    requiredEnv(
      'ONESIGNAL_REST_API_KEY'
    );

  const payload =
    notificationPayload(
      eventData,
      options
    );

  /*
  |--------------------------------------------------------------------------
  | CHECK TARGET
  |--------------------------------------------------------------------------
  */

  const hasSubscriptionTarget =
    Array.isArray(
      payload.include_subscription_ids
    ) &&
    payload
      .include_subscription_ids
      .length > 0;

  const hasSegmentTarget =
    Array.isArray(
      payload.included_segments
    ) &&
    payload
      .included_segments
      .length > 0;

  if (
    !hasSubscriptionTarget &&
    !hasSegmentTarget
  ) {
    const error =
      new Error(
        'Aucun destinataire OneSignal.'
      );

    error.code =
      'NO_ONESIGNAL_TARGET';

    throw error;
  }

  console.log(
    '[OneSignal] Sending notification...',
    {
      appId,

      target:
        payload.include_subscription_ids ||
        payload.included_segments,

      title:
        payload.headings?.fr,

      body:
        payload.contents?.fr
    }
  );

  /*
  |--------------------------------------------------------------------------
  | API REQUEST
  |--------------------------------------------------------------------------
  */

  let response;

  try {
    response =
      await fetch(
        ONESIGNAL_URL,
        {
          method:
            'POST',

          headers: {
            Authorization:
              `Key ${apiKey}`,

            'Content-Type':
              'application/json',

            Accept:
              'application/json'
          },

          body:
            JSON.stringify(
              payload
            )
        }
      );
  } catch (networkError) {
    const error =
      new Error(
        `Impossible de contacter OneSignal : ${networkError.message}`
      );

    error.code =
      'ONESIGNAL_NETWORK_ERROR';

    error.cause =
      networkError;

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | READ RESPONSE
  |--------------------------------------------------------------------------
  */

  const responseText =
    await response.text();

  let responseData =
    {};

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

  console.log(
    '[OneSignal] HTTP status:',
    response.status
  );

  console.log(
    '[OneSignal] Response:',
    JSON.stringify(
      responseData,
      null,
      2
    )
  );

  /*
  |--------------------------------------------------------------------------
  | HTTP ERROR
  |--------------------------------------------------------------------------
  */

  if (
    !response.ok
  ) {
    const errorDetails =
      responseData?.errors ??
      responseData?.error ??
      responseData?.message ??
      responseText;

    const error =
      new Error(
        `OneSignal HTTP ${response.status}: ${JSON.stringify(
          errorDetails
        )}`
      );

    error.status =
      response.status;

    error.details =
      responseData;

    console.error(
      '[OneSignal] API ERROR:',
      {
        status:
          response.status,

        details:
          responseData
      }
    );

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | IMPORTANT: HTTP 200 BUT NO MESSAGE ID
  |--------------------------------------------------------------------------
  |
  | OneSignal documents that a valid HTTP 200 response can still contain
  | no "id" when no valid subscriptions exist in the target audience.
  |
  |--------------------------------------------------------------------------
  */

  if (
    !responseData?.id
  ) {
    const errors =
      responseData?.errors ??
      responseData?.error ??
      null;

    const error =
      new Error(
        `OneSignal n'a créé aucun message. ${
          errors
            ? `Détails: ${JSON.stringify(errors)}`
            : 'Aucun abonnement Push valide trouvé pour la cible.'
        }`
      );

    error.code =
      'ONESIGNAL_NO_MESSAGE_ID';

    error.status =
      response.status;

    error.details =
      responseData;

    console.error(
      '[OneSignal] NO MESSAGE CREATED:',
      JSON.stringify(
        responseData,
        null,
        2
      )
    );

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | SUCCESS
  |--------------------------------------------------------------------------
  */

  console.log(
    '[OneSignal] SUCCESS - message created:',
    responseData.id
  );

  return responseData;
}

/*
|--------------------------------------------------------------------------
| FIREBASE PUSH EVENT CLAIM
|--------------------------------------------------------------------------
*/

async function claimEvent(
  eventRef
) {
  const result =
    await eventRef.transaction(
      current => {
        if (
          !current ||
          current.processed ===
            true ||
          current.processing ===
            true
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

/*
|--------------------------------------------------------------------------
| PROCESS FIREBASE PUSH EVENT
|--------------------------------------------------------------------------
*/

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
        `[Push] Événement ${eventId} déjà traité ou en cours.`
      );

      return;
    }

    console.log(
      `[Push] Traitement ${eventId}`
    );

    const result =
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
        result.id || null,

      lastError:
        null
    });

    console.log(
      `[Push] Notification envoyée pour ${eventId}`
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
    } catch (
      updateError
    ) {
      console.error(
        '[Push] Impossible d’enregistrer l’erreur',
        updateError
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| FIREBASE PUSH EVENT LISTENER
|--------------------------------------------------------------------------
*/

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
      ).catch(
        error => {
          console.error(
            `[Push] Erreur non interceptée pour ${snapshot.key}`,
            error
          );
        }
      );
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

/*
|--------------------------------------------------------------------------
| BASE64 IMAGE VALIDATION
|--------------------------------------------------------------------------
*/

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
      .replace(
        /-/g,
        '+'
      )
      .replace(
        /_/g,
        '/'
      );

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

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| EXPRESS SERVER
|--------------------------------------------------------------------------
*/

function createServer() {
  const app =
    express();

  app.disable(
    'x-powered-by'
  );

  /*
  |--------------------------------------------------------------------------
  | CORS
  |--------------------------------------------------------------------------
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
        !allowedOrigin(
          origin
        )
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

  /*
  |--------------------------------------------------------------------------
  | JSON BODY
  |--------------------------------------------------------------------------
  */

  app.use(
    express.json({
      limit:
        '12mb'
    })
  );

  /*
  |--------------------------------------------------------------------------
  | HEALTH
  |--------------------------------------------------------------------------
  */

  app.get(
    '/health',
    (
      _request,
      response
    ) => {
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
              : 'not-configured',

          legacyFirebasePushPath:
            EVENTS_PATH,

          oneSignal: {
            configured:
              Boolean(
                ONESIGNAL_APP_ID &&
                ONESIGNAL_REST_API_KEY
              ),

            app_id_configured:
              Boolean(
                ONESIGNAL_APP_ID
              ),

            api:
              ONESIGNAL_URL,

            test_subscription_configured:
              Boolean(
                ONESIGNAL_TEST_SUBSCRIPTION_ID
              )
          },

          timestamp:
            new Date()
              .toISOString()
        });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | ONESIGNAL STATUS
  |--------------------------------------------------------------------------
  */

  app.get(
    '/api/notifications/status',
    (
      _request,
      response
    ) => {
      const configured =
        Boolean(
          ONESIGNAL_APP_ID &&
          ONESIGNAL_REST_API_KEY
        );

      response.json({
        ok:
          configured,

        configured,

        app_id_configured:
          Boolean(
            ONESIGNAL_APP_ID
          ),

        api_key_configured:
          Boolean(
            ONESIGNAL_REST_API_KEY
          ),

        test_subscription_configured:
          Boolean(
            ONESIGNAL_TEST_SUBSCRIPTION_ID
          ),

        test_subscription_id:
          ONESIGNAL_TEST_SUBSCRIPTION_ID
            ? 'configured'
            : null,

        push_api:
          ONESIGNAL_URL,

        message:
          configured
            ? 'OneSignal est correctement configuré. Le serveur peut envoyer des notifications Push.'
            : 'OneSignal n’est pas correctement configuré. Vérifiez ONESIGNAL_APP_ID et ONESIGNAL_REST_API_KEY.',

        timestamp:
          new Date()
            .toISOString()
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | DEDICATED ONESIGNAL TEST
  |--------------------------------------------------------------------------
  |
  | THIS ENDPOINT IS IMPORTANT FOR YOUR CURRENT TEST.
  |
  | It always targets:
  |
  | ONESIGNAL_TEST_SUBSCRIPTION_ID
  |
  | Therefore your current browser Subscription ID:
  |
  | 2115f28d-a830-4155-bd15-fadb80ff40ab
  |
  |--------------------------------------------------------------------------
  */

  app.post(
    '/api/notifications/test',
    async (
      request,
      response
    ) => {
      try {
        if (
          !ONESIGNAL_TEST_SUBSCRIPTION_ID
        ) {
          return response
            .status(503)
            .json({
              ok:
                false,

              error:
                'ONESIGNAL_TEST_SUBSCRIPTION_ID n’est pas configuré dans Render.'
            });
        }

        const body =
          request.body || {};

        const testData = {
          ...body,

          title:
            cleanText(
              body.title,
              'Test L’Empreinte d’Emil'
            ),

          body:
            cleanText(
              body.body,
              'Ceci est un test de notification Push.'
            ),

          subscriptionId:
            ONESIGNAL_TEST_SUBSCRIPTION_ID
        };

        const result =
          await sendOneSignalNotification(
            testData
          );

        return response
          .status(202)
          .json({
            ok:
              true,

            handled:
              true,

            test:
              true,

            subscription_id:
              ONESIGNAL_TEST_SUBSCRIPTION_ID,

            data:
              result
          });
      } catch (
        error
      ) {
        console.error(
          '[Push TEST] Send failed:',
          error?.details ||
            error
        );

        return response
          .status(
            error?.status >= 400 &&
            error?.status < 600
              ? error.status
              : 502
          )
          .json({
            ok:
              false,

            handled:
              false,

            test:
              true,

            error:
              error?.message ||
              'Notification test impossible.',

            code:
              error?.code ||
              null,

            details:
              error?.details ||
              null
          });
      }
    }
  );

  /*
  |--------------------------------------------------------------------------
  | STORE GLOBAL
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE GLOBAL PATCH
  |--------------------------------------------------------------------------
  */

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
          ok:
            true,

          rows
        });
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE NODE GET
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE NODE WRITE
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE NODE DELETE
  |--------------------------------------------------------------------------
  */

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

        if (!key) {
          return response
            .status(400)
            .json({
              error:
                'Clé de stockage manquante.'
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
              key
            );

        if (error) {
          throw error;
        }

        return response.json({
          ok:
            true
        });
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE BY KEY
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE PUT
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE PATCH
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | STORE DELETE
  |--------------------------------------------------------------------------
  */

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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | NORMAL PRODUCT PUSH
  |--------------------------------------------------------------------------
  |
  | If a subscriptionId is supplied:
  |     send to that subscription.
  |
  | Otherwise:
  |     send to "Subscribed Users".
  |
  |--------------------------------------------------------------------------
  */

  app.post(
    '/api/notifications/product',
    async (
      request,
      response
    ) => {
      try {
        const body =
          request.body || {};

        const result =
          await sendOneSignalNotification(
            body
          );

        return response
          .status(202)
          .json({
            ok:
              true,

            handled:
              true,

            data:
              result
          });
      } catch (
        error
      ) {
        console.error(
          '[Push API] Send failed:',
          error?.details ||
            error
        );

        return response
          .status(
            error?.status >= 400 &&
            error?.status < 600
              ? error.status
              : 502
          )
          .json({
            ok:
              false,

            handled:
              false,

            error:
              error?.message ||
              'Notification impossible.',

            code:
              error?.code ||
              null,

            details:
              error?.details ||
              null
          });
      }
    }
  );

  /*
  |--------------------------------------------------------------------------
  | LEGACY PUSH EVENTS ENDPOINT
  |--------------------------------------------------------------------------
  */

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
          .status(202)
          .json({
            ok:
              true,

            handled:
              true,

            data:
              result
          });
      } catch (
        error
      ) {
        console.error(
          '[OneSignal] Événement push impossible :',
          error?.details ||
            error
        );

        return response
          .status(
            error?.status >= 400 &&
            error?.status < 600
              ? error.status
              : 502
          )
          .json({
            ok:
              false,

            handled:
              false,

            error:
              error?.message ||
              'Notification impossible.',

            code:
              error?.code ||
              null,

            details:
              error?.details ||
              null
          });
      }
    }
  );

  /*
  |--------------------------------------------------------------------------
  | UPLOAD
  |--------------------------------------------------------------------------
  */

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
            process.env
              .UPLOAD_TOKEN ||
              ''
          ).trim();

        if (
          expectedToken &&
          request.get(
            'X-Upload-Token'
          ) !==
            expectedToken
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
      } catch (
        error
      ) {
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

  /*
  |--------------------------------------------------------------------------
  | ROOT
  |--------------------------------------------------------------------------
  */

  app.get(
    '/',
    (
      _request,
      response
    ) => {
      response
        .status(200)
        .send(
          'L’Empreinte d’Emil push service is running.'
        );
    }
  );

  /*
  |--------------------------------------------------------------------------
  | 404
  |--------------------------------------------------------------------------
  */

  app.use(
    (
      _request,
      response
    ) => {
      response
        .status(404)
        .json({
          ok:
            false,

          error:
            'Route non trouvée.'
        });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | ERROR HANDLER
  |--------------------------------------------------------------------------
  */

  app.use(
    (
      error,
      _request,
      response,
      _next
    ) => {
      console.error(
        '[Express] Unhandled error:',
        error
      );

      if (
        response.headersSent
      ) {
        return;
      }

      response
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ||
            'Erreur serveur.'
        });
    }
  );

  return app;
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  const app =
    createServer();

  /*
  |--------------------------------------------------------------------------
  | SUPABASE MODE
  |--------------------------------------------------------------------------
  */

  if (
    getSupabaseClient()
  ) {
    console.log(
      `[Supabase] Mode principal actif sur la table ${SUPABASE_TABLE}.`
    );

    /*
    |--------------------------------------------------------------------------
    | FIREBASE HISTORICAL PUSH WORKER
    |--------------------------------------------------------------------------
    */

    try {
      const firebaseApp =
        initFirebaseAdmin();

      const db =
        admin.database(
          firebaseApp
        );

      await db
        .ref(
          '.info/connected'
        )
        .once(
          'value'
        )
        .catch(
          error => {
            console.warn(
              '[Firebase] Vérification initiale indisponible :',
              error.message
            );
          }
        );

      startPushEventListener(
        db
      );
    } catch (
      error
    ) {
      console.warn(
        '[Firebase] Worker historique non démarré :',
        error.message
      );
    }
  } else {
    /*
    |--------------------------------------------------------------------------
    | FIREBASE ONLY FALLBACK
    |--------------------------------------------------------------------------
    */

    console.log(
      '[Supabase] Supabase non configuré. Mode Firebase historique.'
    );

    const firebaseApp =
      initFirebaseAdmin();

    const db =
      admin.database(
        firebaseApp
      );

    await db
      .ref(
        '.info/connected'
      )
      .once(
        'value'
      )
      .catch(
        error => {
          console.warn(
            '[Firebase] Vérification initiale indisponible :',
            error.message
          );
        }
      );

    startPushEventListener(
      db
    );
  }

  /*
  |--------------------------------------------------------------------------
  | START HTTP SERVER
  |--------------------------------------------------------------------------
  */

  app.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `[HTTP] Serveur Express à l’écoute sur le port ${PORT}`
      );

      console.log(
        `[OneSignal] API : ${ONESIGNAL_URL}`
      );

      console.log(
        `[OneSignal] App ID configuré : ${Boolean(
          ONESIGNAL_APP_ID
        )}`
      );

      console.log(
        `[OneSignal] REST API Key configurée : ${Boolean(
          ONESIGNAL_REST_API_KEY
        )}`
      );

      console.log(
        `[OneSignal] Test Subscription configuré : ${Boolean(
          ONESIGNAL_TEST_SUBSCRIPTION_ID
        )}`
      );
    }
  );
}

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

main().catch(
  error => {
    console.error(
      '[Startup] Démarrage impossible',
      error
    );

    process.exit(1);
  }
);

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

export {
  createServer,
  notificationPayload,
  processPushEvent,
  sendOneSignalNotification
};
