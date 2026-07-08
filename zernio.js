require('dotenv').config({ quiet: true });

const { generateDailyCarousels } = require('./combos');
const { generateDailySchedule } = require('./scheduler');
const { fetchWithRetry, ZernioApiError } = require('./retry');
const { loadCache, saveCache } = require('./upload-cache');

const API_BASE = 'https://zernio.com/api/v1';
const TIMEZONE = 'America/Argentina/Buenos_Aires';

const ACCOUNT_IDS = {
  cuentaA: process.env.ZERNIO_ACCOUNT_ID_A,
  cuentaB: process.env.ZERNIO_ACCOUNT_ID_B,
};

// Copy fija de la marca, igual para las 2 cuentas.
const CAPTION = {
  content: 'ig: @trendings_indd',
  description:
    'Si te gustó el outfit, en nuestra web encontrás todas estas prendas y muchas más. ' +
    'Estamos sumando novedades todas las semanas para que encuentres tu próximo outfit. ' +
    'Link en la bio. #streetwear #ropa #modaargentina #outfit #indumentaria #estilo #fashion ' +
    '#streetstyle #argentina #outfits #ropahombre #modaurbana',
};

// Zernio no siempre logra bajar las fotos de Hooks/Fija directo desde Drive (falla
// consistentemente aunque el link sea público y funcione desde otro lado). Como
// workaround las subimos nosotros vía su flujo de URL presignada antes de armar el
// post; Ropa se deja con el link directo porque ese sí se procesa bien.
async function presignMedia(photo) {
  const presignRes = await fetch(`${API_BASE}/media/presign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filename: photo.name, contentType: photo.mimeType }),
  });
  if (!presignRes.ok) {
    const errBody = await presignRes.json().catch(() => ({}));
    throw new ZernioApiError(
      `Zernio presign error (${presignRes.status}): ${errBody.message || JSON.stringify(errBody)}`,
      presignRes.status
    );
  }
  return presignRes.json();
}

async function putFile(uploadUrl, fileBuffer, mimeType, photoName) {
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: fileBuffer,
  });
  if (!putRes.ok) {
    throw new ZernioApiError(`No se pudo subir ${photoName} a Zernio (${putRes.status})`, putRes.status);
  }
}

async function uploadToZernio(photo) {
  const presignData = await fetchWithRetry(() => presignMedia(photo), { label: `presign de ${photo.name}` });

  const fileRes = await fetch(photo.downloadUrl);
  if (!fileRes.ok) throw new Error(`No se pudo bajar ${photo.name} de Drive (${fileRes.status})`);
  const fileBuffer = await fileRes.arrayBuffer();

  await fetchWithRetry(() => putFile(presignData.uploadUrl, fileBuffer, photo.mimeType, photo.name), {
    label: `subiendo foto ${photo.name}`,
  });

  return presignData.publicUrl;
}

// Cachea por file id para no resubir la misma foto varias veces en la misma corrida
// (la fija es siempre la misma, y un hook puede repetirse entre los 20 carruseles),
// y además persiste en disco (upload-cache.js) para no resubirla entre corridas
// distintas del batch. Ver la limitación conocida documentada en upload-cache.js
// sobre fotos reemplazadas en Drive con el mismo file ID.
function makeUploadCache() {
  const memCache = new Map();
  const diskCache = loadCache(); // { driveFileId: zernioPublicUrl }, persistido de corridas anteriores
  let hits = 0;
  let misses = 0;

  const getUploadedUrl = async function getUploadedUrl(photo) {
    if (memCache.has(photo.id)) return memCache.get(photo.id);

    if (diskCache[photo.id]) {
      hits++;
      console.log(`[cache] ${photo.name}: servida desde cache, no se resube.`);
      const cachedPromise = Promise.resolve(diskCache[photo.id]);
      memCache.set(photo.id, cachedPromise);
      return cachedPromise;
    }

    misses++;
    console.log(`[cache] ${photo.name}: no está en cache, subiendo de cero...`);
    const uploadPromise = uploadToZernio(photo).then((url) => {
      diskCache[photo.id] = url;
      return url;
    });
    memCache.set(photo.id, uploadPromise);
    return uploadPromise;
  };

  getUploadedUrl.getStats = () => ({ hits, misses });
  getUploadedUrl.persist = () => saveCache(diskCache);

  return getUploadedUrl;
}

async function buildMediaItems(carousel, getUploadedUrl) {
  const [hookUrl, fijaUrl] = await Promise.all([
    getUploadedUrl(carousel.hook),
    getUploadedUrl(carousel.fija),
  ]);

  return [
    { type: 'image', url: hookUrl },
    { type: 'image', url: fijaUrl },
    ...carousel.ropa.map((photo) => ({ type: 'image', url: photo.downloadUrl })),
  ];
}

async function buildPost(carousel, scheduledFor, accountId, getUploadedUrl = makeUploadCache()) {
  return {
    content: CAPTION.content,
    mediaItems: await buildMediaItems(carousel, getUploadedUrl),
    platforms: [{ platform: 'tiktok', accountId }],
    tiktokSettings: {
      privacy_level: 'PUBLIC_TO_EVERYONE',
      allow_comment: true,
      media_type: 'photo',
      photo_cover_index: 0,
      auto_add_music: true,
      description: CAPTION.description,
      content_preview_confirmed: true,
      express_consent_given: true,
    },
    scheduledFor,
    timezone: TIMEZONE,
  };
}

async function buildAccountPosts(carousels, schedule, accountId, getUploadedUrl) {
  if (carousels.length !== schedule.length) {
    throw new Error(`Cantidad de carruseles (${carousels.length}) no coincide con horarios (${schedule.length})`);
  }
  return Promise.all(carousels.map((carousel, i) => buildPost(carousel, schedule[i], accountId, getUploadedUrl)));
}

// Arma los 20 payloads del día (10 cuenta A + 10 cuenta B) listos para POST /posts.
async function generateDailyPayloads(date = new Date()) {
  if (!ACCOUNT_IDS.cuentaA || !ACCOUNT_IDS.cuentaB) {
    throw new Error('Faltan ZERNIO_ACCOUNT_ID_A / ZERNIO_ACCOUNT_ID_B en el .env');
  }

  const [{ cuentaA: carouselsA, cuentaB: carouselsB }, schedule] = await Promise.all([
    generateDailyCarousels(),
    Promise.resolve(generateDailySchedule(date)),
  ]);

  const getUploadedUrl = makeUploadCache(); // compartido entre las 2 cuentas: la fija se sube una sola vez

  const [cuentaA, cuentaB] = await Promise.all([
    buildAccountPosts(carouselsA, schedule.cuentaA, ACCOUNT_IDS.cuentaA, getUploadedUrl),
    buildAccountPosts(carouselsB, schedule.cuentaB, ACCOUNT_IDS.cuentaB, getUploadedUrl),
  ]);

  getUploadedUrl.persist();
  const { hits, misses } = getUploadedUrl.getStats();
  console.log(`Fotos servidas desde cache: ${hits} | Fotos subidas nuevas: ${misses}`);

  return { cuentaA, cuentaB };
}

async function postToZernio(payload) {
  const res = await fetch(`${API_BASE}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ZernioApiError(`Zernio API error (${res.status}): ${data.message || JSON.stringify(data)}`, res.status);
  }
  return res.json();
}

// Publica un payload individual. No se llama sola desde generateDailyPayloads:
// programar los 20 posts reales requiere confirmación explícita antes de ejecutarse.
async function publishPost(payload) {
  return fetchWithRetry(() => postToZernio(payload), { label: `publicando post (${payload.scheduledFor})` });
}

module.exports = { generateDailyPayloads, publishPost, buildPost };

if (require.main === module) {
  generateDailyPayloads()
    .then(({ cuentaA, cuentaB }) => {
      console.log(`Payloads generados: ${cuentaA.length} cuenta A + ${cuentaB.length} cuenta B\n`);
      console.log('Ejemplo (cuenta A, post 1):');
      console.log(JSON.stringify(cuentaA[0], null, 2));
    })
    .catch((err) => {
      console.error('Error armando payloads:', err.message);
      process.exit(1);
    });
}
