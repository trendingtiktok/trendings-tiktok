// Reintenta llamadas HTTP a Zernio con backoff exponencial. Solo pensado para
// fallos transitorios (red, 429, 5xx); los errores 4xx "reales" cortan al toque.

class ZernioApiError extends Error {
  constructor(message, status, retryAfterSeconds = null) {
    super(message);
    this.name = 'ZernioApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // con MAX_ATTEMPTS=3 solo se usan los primeros 2 (2 esperas entre 3 intentos)

function isRetryable(err) {
  if (err instanceof ZernioApiError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false; // 400/401/403/404 y demás 4xx: no reintentar
  }
  return true; // fetch tiró antes de tener response (timeout, ECONNRESET, etc.)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Si el error trae retryAfterSeconds (Zernio lo manda en 429), ese valor manda
// por sobre el backoff fijo -- nunca esperamos menos de lo que Zernio pide.
function resolveDelay(err, attempt) {
  const baseDelay = RETRY_DELAYS_MS[attempt - 1];
  if (err instanceof ZernioApiError && err.retryAfterSeconds) {
    const requiredMs = err.retryAfterSeconds * 1000;
    return Math.max(baseDelay, requiredMs);
  }
  return baseDelay;
}

// fn: función async sin argumentos que hace la llamada real (fetch + chequeo de res.ok).
// options.label: texto para identificar la operación en los logs de reintento.
async function fetchWithRetry(fn, { label = 'operación' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      const delay = resolveDelay(err, attempt);
      console.log(`[${label}] Intento ${attempt} falló (${err.message}), reintentando en ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry, ZernioApiError };