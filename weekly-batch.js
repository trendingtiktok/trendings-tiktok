require('dotenv').config({ quiet: true });

const { generateDailyPayloads, publishPost } = require('./zernio');
const { guardarHistorialPosts, guardarSystemRun } = require('./db');

const API_BASE = 'https://zernio.com/api/v1';
const DAYS_AHEAD = 7;
const ACCOUNT_IDS = [process.env.ZERNIO_ACCOUNT_ID_A, process.env.ZERNIO_ACCOUNT_ID_B];
const ARG_OFFSET_MS = 3 * 60 * 60 * 1000; // America/Argentina/Buenos_Aires, fijo UTC-3

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Devuelve el scheduledFor más lejano entre los posts todavía "scheduled" de una
// cuenta, paginando toda la lista (no confiar en que la API los devuelva ordenados).
async function getLastScheduledDate(accountId) {
  let page = 1;
  let maxDate = null;

  while (true) {
    const params = new URLSearchParams({ accountId, status: 'scheduled', limit: '100', page: String(page) });
    const res = await fetch(`${API_BASE}/posts?${params}`, {
      headers: { Authorization: `Bearer ${process.env.ZERNIO_API_KEY}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Zernio API error (${res.status}) listando posts de ${accountId}: ${data.message || JSON.stringify(data)}`);
    }

    const posts = data.posts || data.data || [];
    for (const p of posts) {
      const d = new Date(p.scheduledFor);
      if (!maxDate || d > maxDate) maxDate = d;
    }

    if (posts.length < 100) break;
    page++;
  }

  return maxDate;
}

// Convierte un instante UTC al día calendario en America/Argentina/Buenos_Aires
// (offset fijo, sin horario de verano) y arma un Date local con ese Y-M-D, para
// poder seguir usando addDays/formatDate (que operan en hora local de la máquina).
function toArgCalendarDate(utcDate) {
  const shifted = new Date(utcDate.getTime() - ARG_OFFSET_MS);
  return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

// Punto de partida del batch: el día siguiente al último post ya programado (el más
// lejano entre las 2 cuentas). Si no hay ninguno programado, arranca desde hoy
// (o sea, el batch va a generar "desde mañana" como caso base).
async function getBatchStartDate() {
  const lastDates = await Promise.all(ACCOUNT_IDS.map(getLastScheduledDate));
  const known = lastDates.filter(Boolean);
  if (known.length === 0) return new Date();

  const latestUtc = known.reduce((a, b) => (a > b ? a : b));
  return toArgCalendarDate(latestUtc);
}

// Devuelve el historial (para Supabase) de los posts que se programaron ok en esta
// cuenta. carousels[i] tiene los objetos { id, name, mimeType, downloadUrl } de Drive
// para el hook/fija/ropa del post posts[i] (mismo índice que sale de generateDailyPayloads).
async function publishAccountPosts(posts, carousels, accountLabel, dayLabel, results) {
  const historial = [];
  for (let i = 0; i < posts.length; i++) {
    try {
      await publishPost(posts[i]);
      results.push({ day: dayLabel, account: accountLabel, index: i + 1, status: 'ok' });

      const carousel = carousels[i];
      historial.push({
        fecha: dayLabel,
        cuenta: accountLabel,
        scheduledFor: posts[i].scheduledFor,
        hookId: carousel.hook.id,
        fijaId: carousel.fija.id,
        ropaIds: carousel.ropa.map((photo) => photo.id),
        caption: posts[i].tiktokSettings.description,
      });
    } catch (err) {
      results.push({
        day: dayLabel,
        account: accountLabel,
        index: i + 1,
        status: 'error',
        error: err.message,
        scheduledFor: posts[i].scheduledFor,
        mediaUrls: posts[i].mediaItems.map((m) => m.url),
      });
    }
  }
  return historial;
}

function printSummary(results) {
  console.log('\n=== Resumen semanal ===');

  const days = [...new Set(results.map((r) => r.day))];
  let totalOk = 0;
  let totalFail = 0;

  for (const day of days) {
    const dayResults = results.filter((r) => r.day === day);
    const accounts = ['cuentaA', 'cuentaB'];
    const parts = accounts.map((acc) => {
      const accResults = dayResults.filter((r) => r.account === acc);
      const ok = accResults.filter((r) => r.status === 'ok').length;
      return `${acc}: ${ok}/${accResults.length}`;
    });
    console.log(`${day} -> ${parts.join(' | ')}`);
    totalOk += dayResults.filter((r) => r.status === 'ok').length;
    totalFail += dayResults.filter((r) => r.status === 'error').length;
  }

  console.log(`\nTotal programados OK: ${totalOk}`);
  console.log(`Total fallidos: ${totalFail}`);

  const failures = results.filter((r) => r.status === 'error');
  if (failures.length > 0) {
    console.log('\nFallas:');
    failures.forEach((f) => {
      console.log(`  ${f.day} ${f.account} post #${f.index} (scheduledFor: ${f.scheduledFor || 'n/a'}): ${f.error}`);
      if (f.mediaUrls) {
        f.mediaUrls.forEach((url, i) => console.log(`    [${i}] ${url}`));
      }
    });
  }
}

// Arma un resumen corto (para detalle_error) de los posts que fallaron, sin volcar
// el detalle completo de cada uno (eso ya se ve en printSummary/logs de la corrida).
function summarizeErrors(results) {
  const failures = results.filter((r) => r.status === 'error');
  if (failures.length === 0) return null;

  const preview = failures
    .slice(0, 5)
    .map((f) => `${f.day} ${f.account} #${f.index}: ${f.error}`)
    .join(' | ');
  const rest = failures.length > 5 ? ` (+${failures.length - 5} más)` : '';
  return `${preview}${rest}`;
}

async function main() {
  const startTime = Date.now();
  const results = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let fatalError = null;

  try {
    const startDate = await getBatchStartDate();
    console.log(`Arrancando el día después de ${formatDate(startDate)} (último post ya programado, o hoy si no había ninguno)`);

    for (let i = 1; i <= DAYS_AHEAD; i++) {
      const date = addDays(startDate, i);
      const dayLabel = formatDate(date);
      console.log(`\n=== Generando y programando ${dayLabel} ===`);

      let payloads;
      try {
        payloads = await generateDailyPayloads(date);
      } catch (err) {
        console.error(`  Error generando payloads para ${dayLabel}: ${err.message}`);
        for (const account of ['cuentaA', 'cuentaB']) {
          for (let i2 = 1; i2 <= 10; i2++) {
            results.push({ day: dayLabel, account, index: i2, status: 'error', error: `generación falló: ${err.message}` });
          }
        }
        continue;
      }

      cacheHits += payloads.cacheStats.hits;
      cacheMisses += payloads.cacheStats.misses;

      const historialA = await publishAccountPosts(payloads.cuentaA, payloads.carouselsA, 'cuentaA', dayLabel, results);
      const historialB = await publishAccountPosts(payloads.cuentaB, payloads.carouselsB, 'cuentaB', dayLabel, results);

      const okCount = results.filter((r) => r.day === dayLabel && r.status === 'ok').length;
      console.log(`  Programados OK: ${okCount}/20`);

      // Guarda en Supabase solo los posts que se programaron ok. guardarHistorialPosts
      // ya se traga sus propios errores (ver db.js); el try/catch de acá es una capa
      // extra para que ni siquiera un fallo inesperado corte el resto del batch.
      try {
        await guardarHistorialPosts([...historialA, ...historialB]);
      } catch (err) {
        console.error(`  Error inesperado guardando historial de ${dayLabel} en Supabase (no afecta el batch): ${err.message}`);
      }
    }
  } catch (err) {
    fatalError = err;
    console.error(`Error inesperado en el batch semanal: ${err.message}`);
  }

  printSummary(results);

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  const postsOk = results.filter((r) => r.status === 'ok').length;
  const postsError = results.filter((r) => r.status === 'error').length;

  let status = 'success';
  let detalleError = null;
  if (fatalError) {
    status = 'failure';
    detalleError = fatalError.message;
  } else if (postsError > 0) {
    status = 'partial';
    detalleError = summarizeErrors(results);
  }

  // Igual que con el historial: guardarSystemRun ya se traga sus propios errores
  // (ver db.js), el try/catch de acá es una capa extra de seguridad.
  try {
    await guardarSystemRun({
      duracionSegundos: durationSeconds,
      postsOk,
      postsError,
      fotosCache: cacheHits,
      fotosNuevas: cacheMisses,
      status,
      detalleError,
    });
  } catch (err) {
    console.error(`Error inesperado guardando system_run en Supabase (no afecta el batch): ${err.message}`);
  }

  if (fatalError || postsError > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Error inesperado en el batch semanal:', err.message);
  process.exit(1);
});
