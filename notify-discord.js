// Manda un resumen del batch semanal a Discord vía webhook.
// Se llama desde el workflow de GitHub Actions al final de la corrida,
// tanto si salió todo bien como si algo falló.

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function sendDiscordMessage(content) {
  if (!WEBHOOK_URL) {
    console.error('Falta DISCORD_WEBHOOK_URL, no se pudo mandar el aviso a Discord.');
    return;
  }

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    console.error(`Error mandando aviso a Discord (${res.status}): ${await res.text()}`);
  }
}

// status: 'success' o 'failure' (viene del resultado del step anterior en el workflow)
async function main() {
  const status = process.argv[2] || 'unknown';
  const runUrl = process.env.GITHUB_RUN_URL || '';
  const fecha = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  let content;
  if (status === 'success') {
    content = `✅ **Weekly batch OK** — ${fecha}\nSe programó la semana sin errores.\n${runUrl}`;
  } else {
    content = `🚨 **Weekly batch FALLÓ** — ${fecha}\nRevisá el log completo acá:\n${runUrl}`;
  }

  await sendDiscordMessage(content);
}

main().catch((err) => {
  console.error('Error en notify-discord.js:', err.message);
  process.exit(1); // no queremos que un fallo del aviso rompa el resto del workflow más de lo necesario, pero sí que se note en el log
});