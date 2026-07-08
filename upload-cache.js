// Cache persistente en disco de fotos ya subidas a Zernio, para no volver a subir
// la misma foto (identificada por su file ID de Drive) en corridas distintas del
// batch. Forma del JSON: { [driveFileId]: zernioPublicUrl }.
//
// Limitación conocida: si en algún momento se borra o reemplaza una foto en Drive
// reusando el mismo file ID, esta cache va a seguir devolviendo la URL vieja de
// Zernio para ese ID hasta que se borre la entrada a mano (o se borre el archivo
// de cache entero). No se resuelve acá porque Drive no expone un hash/versión
// estable y liviano para detectar el reemplazo sin descargar el archivo.

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'zernio-upload-cache.json');

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};

  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`No se pudo leer ${CACHE_FILE} (${err.message}), arrancando con cache vacío.`);
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

module.exports = { loadCache, saveCache, CACHE_FILE };
