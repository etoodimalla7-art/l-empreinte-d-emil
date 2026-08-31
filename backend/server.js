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
| Firebase Realtime Database
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
|
| IMPORTANT:
| We use the current OneSignal API:
|
| POST https://api.onesignal.com/notifications
|
| NOT:
| https://api.onesignal.com/notifications?c=push
|
|--------------------------------------------------------------------------
*/

const ONESIGNAL_BASE_URL =
  'https://api.onesignal.com';

const ONESIGNAL_URL =
  `${ONESIGNAL_BASE_URL}/notifications`;

const ONESIGNAL_APP_ID =
  String(process.env.ONESIGNAL_APP_ID || '').trim();

const ONESIGNAL_REST_API_KEY =
  String(process.env.ONESIGNAL_REST_API_KEY || '').trim();

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
        typeof parsed === 'string'
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

function storeKeyFromPath(pathValue) {
  let decoded =
    String(pathValue || '');

  try {
    decoded =
      decodeURIComponent(
        decoded
      );
  } catch {
    // Valeur brute conservée.
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

/*
|--------------------------------------------------------------------------
| SET NESTED VALUE
|--------------------------------------------------------------------------
*/

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
    typeof root === 'object'
      ? structuredClone(root)
      : {};

  let cursor =
    next;

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
  ] =
    value;

  return next;
}

/*
|--------------------------------------------------------------------------
| GET NESTED VALUE
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| EMPTY STORE VALUE
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| NEUTRALIZE STORE VALUE
|--------------------------------------------------------------------------
*/

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
      .select(
        'value'
      )
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
            new Date().toISOString()
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
  return typeof value === 'string' &&
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
    typeof eventData.product === 'object'
    ? eventData.product
    : eventData;
}

/*
|--------------------------------------------------------------------------
| IMAGE URL
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
    const candidate
    of candidates
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
| SUBSCRIPTION IDS
|--------------------------------------------------------------------------
*/

function getSubscriptionIds(
  eventData = {}
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

  if (
    ids.length === 0 &&
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
  eventData = {}
) {
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
  | TARGET SUBSCRIPTION
  |--------------------------------------------------------------------------
  */

  const subscriptionIds =
    getSubscriptionIds(
      eventData
    );

  const payload = {
    app_id:
      requiredEnv(
        'ONESIGNAL_APP_ID'
      ),

    target_channel:
      'push',

    headings: {
      fr:
        title,

      en:
        title
    },

    contents: {
      fr:
        body,

      en:
        body
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
    }
  };

  /*
  |--------------------------------------------------------------------------
  | IMAGE
  |--------------------------------------------------------------------------
  */

  if (image) {
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
  | IMPORTANT:
  | OneSignal does NOT allow us to combine targeting methods.
  |
  | Specific subscription:
  | include_subscription_ids
  |
  | Otherwise:
  | included_segments
  |
  |--------------------------------------------------------------------------
  */

  if (
    subscriptionIds.length > 0
  ) {
    payload.include_subscription_ids =
      subscriptionIds;
  } else {
    payload.included_segments = [
      'Subscribed Users'
    ];
  }

  return payload;
}

/*
|--------------------------------------------------------------------------
| ONESIGNAL REQUEST HELPER
|--------------------------------------------------------------------------
*/

async function oneSignalRequest(
  url,
  options = {}
) {
  const apiKey =
    requiredEnv(
      'ONESIGNAL_REST_API_KEY'
    );

  const response =
    await fetch(
      url,
      {
        ...options,

        headers: {
          Authorization:
            `Key ${apiKey}`,

          'Content-Type':
            'application/json',

          Accept:
            'application/json',

          ...(options.headers || {})
        }
      }
    );

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

  if (
    !response.ok
  ) {
    const error =
      new Error(
        `OneSignal HTTP ${response.status}: ${
          responseData?.errors
            ? JSON.stringify(
                responseData.errors
              )
            : responseText
        }`
      );

    error.status =
      response.status;

    error.details =
      responseData;

    throw error;
  }

  return {
    response,
    data:
      responseData
  };
}

/*
|--------------------------------------------------------------------------
| CHECK ONESIGNAL SUBSCRIPTION
|--------------------------------------------------------------------------
|
| This fixes:
|
| "Failed to parse app_id from request"
|
| We explicitly use:
|
| /apps/{APP_ID}/subscriptions/{SUBSCRIPTION_ID}/user/identity
|
| Then:
|
| /apps/{APP_ID}/users/by/onesignal_id/{ONESIGNAL_ID}
|
|--------------------------------------------------------------------------
*/

async function getOneSignalSubscription(
  subscriptionId
) {
  const appId =
    requiredEnv(
      'ONESIGNAL_APP_ID'
    );

  const cleanSubscriptionId =
    String(
      subscriptionId || ''
    ).trim();

  if (
    !cleanSubscriptionId
  ) {
    const error =
      new Error(
        'Subscription ID manquant.'
      );

    error.code =
      'MISSING_SUBSCRIPTION_ID';

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | STEP 1 — FIND USER IDENTITY
  |--------------------------------------------------------------------------
  */

  const identityUrl =
    `${ONESIGNAL_BASE_URL}/apps/${encodeURIComponent(
      appId
    )}/subscriptions/${encodeURIComponent(
      cleanSubscriptionId
    )}/user/identity`;

  console.log(
    '[OneSignal] Vérification subscription:',
    cleanSubscriptionId
  );

  const identityResult =
    await oneSignalRequest(
      identityUrl,
      {
        method:
          'GET'
      }
    );

  const identity =
    identityResult.data
      ?.identity ||
    {};

  const oneSignalId =
    cleanText(
      identity.onesignal_id
    );

  if (
    !oneSignalId
  ) {
    const error =
      new Error(
        'OneSignal a trouvé la subscription mais aucun OneSignal ID utilisateur.'
      );

    error.code =
      'ONESIGNAL_ID_NOT_FOUND';

    error.details =
      identityResult.data;

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | STEP 2 — GET USER
  |--------------------------------------------------------------------------
  */

  const userUrl =
    `${ONESIGNAL_BASE_URL}/apps/${encodeURIComponent(
      appId
    )}/users/by/onesignal_id/${encodeURIComponent(
      oneSignalId
    )}`;

  const userResult =
    await oneSignalRequest(
      userUrl,
      {
        method:
          'GET'
      }
    );

  const user =
    userResult.data ||
    {};

  const subscriptions =
    Array.isArray(
      user.subscriptions
    )
      ? user.subscriptions
      : [];

  const subscription =
    subscriptions.find(
      item =>
        String(
          item?.id || ''
        ) ===
        cleanSubscriptionId
    );

  if (
    !subscription
  ) {
    const error =
      new Error(
        'Subscription introuvable dans les subscriptions de cet utilisateur.'
      );

    error.code =
      'SUBSCRIPTION_NOT_FOUND';

    error.details = {
      subscriptionId:
        cleanSubscriptionId,

      oneSignalId,

      subscriptions
    };

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | NORMALIZED RESULT
  |--------------------------------------------------------------------------
  */

  const enabled =
    subscription.enabled === true;

  const notificationTypes =
    subscription.notification_types;

  const subscribed =
    enabled &&
    (
      notificationTypes ===
        undefined ||
      notificationTypes ===
        null ||
      Number(
        notificationTypes
      ) >= 0
    );

  return {
    ok:
      true,

    subscribed,

    enabled,

    subscriptionId:
      cleanSubscriptionId,

    oneSignalId,

    type:
      subscription.type ||
      null,

    token:
      subscription.token ||
      null,

    notificationTypes:
      notificationTypes ??
      null,

    appId:
      subscription.app_id ||
      appId,

    deviceModel:
      subscription.device_model ||
      null,

    deviceOS:
      subscription.device_os ||
      null,

    sdk:
      subscription.sdk ||
      null,

    country:
      user.properties?.country ||
      null,

    language:
      user.properties?.language ||
      null,

    user
  };
}

/*
|--------------------------------------------------------------------------
| SEND ONESIGNAL NOTIFICATION
|--------------------------------------------------------------------------
*/

async function sendOneSignalNotification(
  eventData = {}
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
      eventData
    );

  /*
  |--------------------------------------------------------------------------
  | TARGET VALIDATION
  |--------------------------------------------------------------------------
  */

  const hasSubscriptionTarget =
    Array.isArray(
      payload.include_subscription_ids
    ) &&
    payload.include_subscription_ids.length >
      0;

  const hasSegmentTarget =
    Array.isArray(
      payload.included_segments
    ) &&
    payload.included_segments.length >
      0;

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
    '[OneSignal] Envoi notification',
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
  | SEND
  |--------------------------------------------------------------------------
  */

  const result =
    await oneSignalRequest(
      ONESIGNAL_URL,
      {
        method:
          'POST',

        body:
          JSON.stringify(
            payload
          )
      }
    );

  const responseData =
    result.data;

  console.log(
    '[OneSignal] Réponse API:',
    responseData
  );

  /*
  |--------------------------------------------------------------------------
  | IMPORTANT:
  |
  | OneSignal can return HTTP 200 with no ID.
  |
  | According to OneSignal documentation, this means
  | the request was valid but no message was created,
  | commonly because the target contains no valid
  | subscription.
  |
  |--------------------------------------------------------------------------
  */

  if (
    !responseData?.id
  ) {
    const error =
      new Error(
        `OneSignal n'a créé aucun message. Réponse: ${JSON.stringify(
          responseData
        )}`
      );

    error.status =
      result.response.status;

    error.code =
      'ONESIGNAL_MESSAGE_NOT_CREATED';

    error.details =
      responseData;

    console.error(
      '[OneSignal] Aucun message créé:',
      {
        status:
          result.response.status,

        response:
          responseData,

        target:
          payload.include_subscription_ids ||
          payload.included_segments
      }
    );

    throw error;
  }

  /*
  |--------------------------------------------------------------------------
  | SUCCESS
  |--------------------------------------------------------------------------
  */

  console.log(
    '[OneSignal] Message créé avec succès:',
    responseData.id
  );

  return responseData;
}

/*
|--------------------------------------------------------------------------
| FIREBASE PUSH EVENTS — CLAIM
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

/*
|--------------------------------------------------------------------------
| FIREBASE PUSH EVENT PROCESSOR
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
        result.id,

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
| IMAGE VALIDATION
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
| SERVER
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
  | BODY
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
            new Date().toISOString()
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

        push_api:
          ONESIGNAL_URL,

        message:
          configured
            ? 'OneSignal est correctement configuré.'
            : 'OneSignal n’est pas correctement configuré.',

        timestamp:
          new Date().toISOString()
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | ONESIGNAL SUBSCRIPTION CHECK
  |--------------------------------------------------------------------------
  |
  | THIS IS THE IMPORTANT NEW ENDPOINT.
  |
  | GET:
  |
  | /api/notifications/subscription/:subscriptionId
  |
  |--------------------------------------------------------------------------
  */

  app.get(
    '/api/notifications/subscription/:subscriptionId',

    async (
      request,
      response
    ) => {
      try {
        const subscriptionId =
          String(
            request.params
              .subscriptionId ||
              ''
          ).trim();

        if (
          !subscriptionId
        ) {
          return response
            .status(400)
            .json({
              ok:
                false,

              error:
                'Subscription ID obligatoire.'
            });
        }

        const result =
          await getOneSignalSubscription(
            subscriptionId
          );

        return response
          .status(200)
          .json(
            result
          );
      } catch (
        error
      ) {
        console.error(
          '[OneSignal] Subscription check failed:',
          error?.details ||
            error
        );

        const status =
          Number(
            error?.status
          ) >= 400 &&
          Number(
            error?.status
          ) < 600
            ? Number(
                error.status
              )
            : 502;

        return response
          .status(status)
          .json({
            ok:
              false,

            subscribed:
              false,

            error:
              error?.message ||
              'Impossible de vérifier la subscription OneSignal.',

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
  | STORE GLOBAL GET
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
                'Clé obligatoire.'
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
  | STORE BY KEY GET
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
  | STORE BY KEY PUT
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
  | STORE BY KEY PATCH
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
  | STORE BY KEY DELETE
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
  | PUSH NOTIFICATION — PRODUCT
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
          request.body ||
          {};

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

            message:
              'Notification créée avec succès par OneSignal.',

            notificationId:
              result.id,

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
          .status(502)
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
  | PUSH EVENTS DIRECT
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

            notificationId:
              result.id,

            data:
              result
          });
      } catch (
        error
      ) {
        console.error(
          '[OneSignal] Événement push impossible:',
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
          request.body ||
          {};

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
          '[Upload] Échec validation Base64:',
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
      request,
      response
    ) => {
      response
        .status(404)
        .json({
          ok:
            false,

          error:
            'Route introuvable.',

          path:
            request.originalUrl
        });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | GLOBAL ERROR HANDLER
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
        '[Express] Erreur globale:',
        error
      );

      response
        .status(
          Number(
            error?.status
          ) || 500
        )
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
              '[Firebase] Vérification initiale indisponible:',
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
        '[Firebase] Worker historique non démarré:',
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
            '[Firebase] Vérification initiale indisponible:',
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
        `[OneSignal] API: ${ONESIGNAL_URL}`
      );

      console.log(
        `[OneSignal] App ID configuré: ${Boolean(
          ONESIGNAL_APP_ID
        )}`
      );

      console.log(
        `[OneSignal] REST API Key configurée: ${Boolean(
          ONESIGNAL_REST_API_KEY
        )}`
      );

      console.log(
        `[OneSignal] Test Subscription configurée: ${Boolean(
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
      '[Startup] Démarrage impossible:',
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
  sendOneSignalNotification,
  getOneSignalSubscription
};
