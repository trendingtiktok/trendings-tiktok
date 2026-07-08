require('dotenv').config({ quiet: true });

const { generateDailyPayloads, publishPost } = require('./zernio');

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

async function publishAccountPosts(posts, accountLabel, dayLabel, results) {
  for (let i = 0; i < posts.length; i++) {
    try {
      await publishPost(posts[i]);
      results.push({ day: dayLabel, account: accountLabel, index: i + 1, status: 'ok' });
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

async function main() {
  const results = [];

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

    await publishAccountPosts(payloads.cuentaA, 'cuentaA', dayLabel, results);
    await publishAccountPosts(payloads.cuentaB, 'cuentaB', dayLabel, results);

    const okCount = results.filter((r) => r.day === dayLabel && r.status === 'ok').length;
    console.log(`  Programados OK: ${okCount}/20`);
  }

  printSummary(results);

  if (results.some((r) => r.status === 'error')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Error inesperado en el batch semanal:', err.message);
  process.exit(1);
});
