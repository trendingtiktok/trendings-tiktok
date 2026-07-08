# Estado del pipeline — Trendings TikTok

## Mejoras

- **Retry con backoff exponencial en llamadas a Zernio** (`retry.js`, usado desde `zernio.js`):
  las 3 llamadas HTTP a Zernio (presign de media, PUT de archivo a URL presignada, y
  POST `/posts` de `publishPost`) reintentan automáticamente ante fallos transitorios
  (errores de red, status 429, status 5xx), con backoff de 1000ms → 2000ms entre los
  3 intentos totales. Los errores reales (400, 401, 403, 404 y demás 4xx que no sean
  429) cortan al primer intento sin reintentar, para no demorar el batch en errores
  que no se van a resolver solos. Cada reintento se loguea en consola indicando qué
  operación es (ej. `[subiendo foto X] Intento 1 falló (...), reintentando en 1000ms...`).
  `weekly-batch.js` no requirió cambios: sigue registrando el error final (tras
  agotar los reintentos) en el resumen de "Fallas" igual que antes.

- **Cache persistente en disco de fotos ya subidas a Zernio** (`upload-cache.js`, usado
  desde `makeUploadCache` en `zernio.js`): el hook y la foto fija de cada carrusel se
  suben a Zernio vía URL presignada (ver comentario en `zernio.js`), y antes esa subida
  solo se cacheaba en memoria durante una corrida — se resubía la misma foto en cada
  corrida nueva del batch. Ahora se persiste en `zernio-upload-cache.json` (raíz del
  proyecto, forma `{ driveFileId: zernioPublicUrl }`); antes de subir una foto se
  chequea primero ese archivo, y si el file ID de Drive ya está, se reusa la URL sin
  llamar a Zernio de nuevo. El archivo se reescribe al final de cada `generateDailyPayloads`.
  Si el JSON está corrupto o no existe todavía, arranca con cache vacío sin romper el
  batch (solo loguea un warning). Se loguea cada foto servida desde cache vs. subida de
  cero, y al final se imprime un resumen "Fotos servidas desde cache: X | Fotos subidas
  nuevas: Y". Limitación conocida (documentada en `upload-cache.js`): si se reemplaza una
  foto en Drive reusando el mismo file ID, la cache va a seguir devolviendo la URL vieja
  hasta que se borre la entrada o el archivo de cache a mano — no se resuelve automáticamente.
