require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');

let client = null;

function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) {
      throw new Error('Faltan SUPABASE_URL / SUPABASE_SECRET_KEY en el .env');
    }
    client = createClient(url, key);
  }
  return client;
}

// Guarda el historial de posts ya programados en la tabla posts_publicados.
// Nunca debe cortar el batch semanal: cualquier error (credenciales faltantes,
// tabla caída, columna inválida, etc.) se loguea acá y se devuelve como resultado,
// no se propaga como excepción.
async function guardarHistorialPosts(posts) {
  if (!posts || posts.length === 0) return { ok: true, inserted: 0 };

  try {
    const rows = posts.map((p) => ({
      fecha: p.fecha,
      cuenta: p.cuenta,
      hora_programada: p.scheduledFor,
      hook_id: p.hookId,
      fija_id: p.fijaId,
      ropa_ids: p.ropaIds,
      caption: p.caption,
    }));

    const { error } = await getClient().from('posts_publicados').insert(rows);
    if (error) {
      console.error('[db] Error guardando historial en Supabase:', error.message);
      return { ok: false, inserted: 0, error: error.message };
    }

    console.log(`[db] Historial guardado en Supabase: ${rows.length} posts.`);
    return { ok: true, inserted: rows.length };
  } catch (err) {
    console.error('[db] Error inesperado guardando historial en Supabase:', err.message);
    return { ok: false, inserted: 0, error: err.message };
  }
}

// Guarda un registro de una corrida del batch semanal en la tabla system_runs (para
// el dashboard de estado). Mismo patrón que guardarHistorialPosts: nunca corta el
// proceso que la llama, cualquier error se loguea y se devuelve, no se propaga.
async function guardarSystemRun(run) {
  try {
    const row = {
      duracion_segundos: run.duracionSegundos,
      posts_ok: run.postsOk,
      posts_error: run.postsError,
      fotos_cache: run.fotosCache,
      fotos_nuevas: run.fotosNuevas,
      status: run.status,
      detalle_error: run.detalleError ?? null,
    };

    const { error } = await getClient().from('system_runs').insert([row]);
    if (error) {
      console.error('[db] Error guardando system_run en Supabase:', error.message);
      return { ok: false, error: error.message };
    }

    console.log('[db] Registro de corrida guardado en system_runs.');
    return { ok: true };
  } catch (err) {
    console.error('[db] Error inesperado guardando system_run en Supabase:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getClient, guardarHistorialPosts, guardarSystemRun };
