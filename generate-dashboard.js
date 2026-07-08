require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');

const { fetchFullHistory, sumMetrics } = require('./analytics');
const { getClient } = require('./db');

const ACCOUNTS = [
  { name: 'Cuenta A', id: process.env.ZERNIO_ACCOUNT_ID_A },
  { name: 'Cuenta B', id: process.env.ZERNIO_ACCOUNT_ID_B },
];

const OUTPUT_DIR = path.join(__dirname, 'dashboard');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'index.html');

async function getAnalyticsRows() {
  if (!ACCOUNTS.every((a) => a.id)) {
    throw new Error('Faltan ZERNIO_ACCOUNT_ID_A / ZERNIO_ACCOUNT_ID_B en el .env');
  }

  const rows = [];
  const totals = { views: 0, likes: 0, comments: 0, posts: 0 };

  for (const account of ACCOUNTS) {
    const posts = await fetchFullHistory(account.id);
    const sums = sumMetrics(posts);
    rows.push({ cuenta: account.name, ...sums });
    totals.views += sums.views;
    totals.likes += sums.likes;
    totals.comments += sums.comments;
    totals.posts += sums.posts;
  }

  rows.push({ cuenta: 'TOTAL', ...totals });
  return rows;
}

async function getSystemRuns() {
  const { data, error } = await getClient()
    .from('system_runs')
    .select('*')
    .order('fecha_corrida', { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`Error trayendo system_runs de Supabase: ${error.message}`);
  }
  return data || [];
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('es-AR');
}

function formatFecha(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function statusBadge(status) {
  const map = {
    success: { label: 'success', className: 'ok' },
    partial: { label: 'partial', className: 'warn' },
    failure: { label: 'failure', className: 'fail' },
  };
  const s = map[status] || { label: status || '-', className: 'unknown' };
  return `<span class="badge ${s.className}">${escapeHtml(s.label)}</span>`;
}

function buildAnalyticsTable(rows) {
  const body = rows
    .map(
      (r) => `<tr${r.cuenta === 'TOTAL' ? ' class="total-row"' : ''}>
        <td>${escapeHtml(r.cuenta)}</td>
        <td>${formatNumber(r.posts)}</td>
        <td>${formatNumber(r.views)}</td>
        <td>${formatNumber(r.likes)}</td>
        <td>${formatNumber(r.comments)}</td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <thead><tr><th>Cuenta</th><th>Posts</th><th>Views</th><th>Likes</th><th>Comments</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function buildRunsTable(runs) {
  if (runs.length === 0) {
    return '<p class="empty">Todavía no hay corridas registradas.</p>';
  }

  const body = runs
    .map(
      (r) => `<tr>
        <td>${formatFecha(r.fecha_corrida)}</td>
        <td>${formatNumber(r.duracion_segundos)}s</td>
        <td>${formatNumber(r.posts_ok)} / ${formatNumber(r.posts_error)}</td>
        <td>${formatNumber(r.fotos_cache)} / ${formatNumber(r.fotos_nuevas)}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="detalle">${r.detalle_error ? escapeHtml(r.detalle_error) : '-'}</td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <thead>
      <tr><th>Fecha</th><th>Duración</th><th>Posts OK/Error</th><th>Fotos cache/nuevas</th><th>Status</th><th>Detalle</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

function buildHtml({ analyticsRows, runs, generatedAt }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trendings TikTok — Estado del sistema</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 48px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f5f7;
    color: #1a1a1a;
  }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .timestamp { font-size: 0.85rem; opacity: 0.65; margin-bottom: 24px; }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    overflow-x: auto;
  }
  h2 { font-size: 1.1rem; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; white-space: nowrap; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e2e2e2; }
  th { background: #fafafa; font-weight: 600; }
  tr.total-row { font-weight: 700; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
  .badge.ok { background: #d7f5df; color: #1a7d3a; }
  .badge.warn { background: #fdf0c8; color: #8a6100; }
  .badge.fail { background: #fbdada; color: #a11d1d; }
  .badge.unknown { background: #e2e2e2; color: #555; }
  .detalle { max-width: 280px; white-space: normal; font-size: 0.8rem; opacity: 0.8; }
  .empty { opacity: 0.6; font-size: 0.9rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #121212; color: #e8e8e8; }
    .card { background: #1e1e1e; box-shadow: none; }
    th { background: #2a2a2a; color: #e8e8e8; }
    th, td { border-color: #333; }
    .badge.unknown { background: #333; color: #ccc; }
  }
</style>
</head>
<body>
  <h1>Trendings TikTok — Estado del sistema</h1>
  <div class="timestamp">Generado el ${escapeHtml(generatedAt)}</div>

  <div class="card">
    <h2>Analíticas</h2>
    ${buildAnalyticsTable(analyticsRows)}
  </div>

  <div class="card">
    <h2>Estado del bot (últimas ${runs.length} corridas)</h2>
    ${buildRunsTable(runs)}
  </div>
</body>
</html>`;
}

async function main() {
  console.log('Trayendo analíticas de Zernio...');
  const analyticsRows = await getAnalyticsRows();

  console.log('Trayendo últimas corridas de Supabase...');
  const runs = await getSystemRuns();

  const generatedAt = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    dateStyle: 'long',
    timeStyle: 'short',
  });

  const html = buildHtml({ analyticsRows, runs, generatedAt });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, html, 'utf8');

  console.log(`Dashboard generado en ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error generando el dashboard:', err.message);
    process.exit(1);
  });
}

module.exports = { getAnalyticsRows, getSystemRuns, buildHtml };
