require('dotenv').config({ quiet: true });

const API_BASE = 'https://zernio.com/api/v1';
const PAGE_LIMIT = 100;
const WINDOW_DAYS = 366; // máximo permitido por Zernio en fromDate/toDate

const ACCOUNTS = [
  { name: 'Cuenta A', id: process.env.ZERNIO_ACCOUNT_ID_A },
  { name: 'Cuenta B', id: process.env.ZERNIO_ACCOUNT_ID_B },
];

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function fetchAnalyticsPage(accountId, fromDate, toDate, page) {
  const params = new URLSearchParams({
    accountId,
    fromDate: formatDate(fromDate),
    toDate: formatDate(toDate),
    limit: String(PAGE_LIMIT),
    page: String(page),
    sortBy: 'date',
    order: 'asc',
  });
  const res = await fetch(`${API_BASE}/analytics?${params}`, {
    headers: { Authorization: `Bearer ${process.env.ZERNIO_API_KEY}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Zernio analytics error (${res.status}): ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

// Trae todos los posts de una cuenta dentro de una ventana de fecha (<=366 días), paginando.
async function fetchAllPostsInWindow(accountId, fromDate, toDate) {
  const posts = [];
  let page = 1;
  for (;;) {
    const data = await fetchAnalyticsPage(accountId, fromDate, toDate, page);
    posts.push(...(data.posts || []));
    const pages = data.pagination?.pages ?? 1;
    if (page >= pages) break;
    page += 1;
  }
  return posts;
}

// Zernio limita cada request a 366 días de rango, así que para traer TODO el
// historico recorremos en ventanas de 366 días desde el lanzamiento de TikTok
// (2016) hasta hoy, sin asumir ninguna fecha de inicio de cuenta.
async function fetchFullHistory(accountId) {
  const today = new Date();
  const posts = [];
  let windowStart = new Date('2016-01-01T00:00:00Z');

  while (windowStart <= today) {
    const windowEnd = addDays(windowStart, WINDOW_DAYS - 1);
    const clampedEnd = windowEnd > today ? today : windowEnd;
    posts.push(...(await fetchAllPostsInWindow(accountId, windowStart, clampedEnd)));
    windowStart = addDays(clampedEnd, 1);
  }

  return posts;
}

function sumMetrics(posts) {
  return posts.reduce(
    (acc, post) => {
      const a = post.analytics || {};
      acc.views += a.views || 0;
      acc.likes += a.likes || 0;
      acc.comments += a.comments || 0;
      acc.posts += 1;
      return acc;
    },
    { views: 0, likes: 0, comments: 0, posts: 0 }
  );
}

function printTable(rows) {
  const headers = ['Cuenta', 'Posts', 'Views', 'Likes', 'Comments'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const printRow = (cells) => console.log(cells.map((c, i) => String(c).padEnd(widths[i])).join('  '));

  printRow(headers);
  printRow(widths.map((w) => '-'.repeat(w)));
  rows.forEach(printRow);
}

async function main() {
  if (!ACCOUNTS.every((a) => a.id)) {
    throw new Error('Faltan ZERNIO_ACCOUNT_ID_A / ZERNIO_ACCOUNT_ID_B en el .env');
  }

  const rows = [];
  const totals = { views: 0, likes: 0, comments: 0, posts: 0 };

  for (const account of ACCOUNTS) {
    const posts = await fetchFullHistory(account.id);
    const sums = sumMetrics(posts);
    rows.push([account.name, sums.posts, sums.views, sums.likes, sums.comments]);
    totals.views += sums.views;
    totals.likes += sums.likes;
    totals.comments += sums.comments;
    totals.posts += sums.posts;
  }

  rows.push(['TOTAL', totals.posts, totals.views, totals.likes, totals.comments]);
  printTable(rows);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error trayendo analytics:', err.message);
    process.exit(1);
  });
}

module.exports = { fetchFullHistory, sumMetrics };
