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

- **Historial de posts publicados en Supabase** (`db.js`, tabla `posts_publicados`, usado
  desde `weekly-batch.js`): después de programar los posts de un día para cuentaA y
  cuentaB, se guarda un registro por cada post que quedó `status: 'ok'` (los que fallaron
  no se guardan). `generateDailyPayloads` (en `zernio.js`) ahora devuelve también
  `carouselsA`/`carouselsB` — los carruseles originales con los objetos de foto completos
  ({ id, name, mimeType, downloadUrl } de Drive) alineados por índice con `cuentaA`/`cuentaB` —
  porque los payloads ya armados para Zernio solo tienen las URLs subidas, no los IDs de
  Drive. `weekly-batch.js` cruza esos carruseles con los payloads para armar cada fila:
  hookId/fijaId/ropaIds salen de `carousel.hook.id` / `carousel.fija.id` / `carousel.ropa[].id`,
  y caption se guarda como `tiktokSettings.description` (el texto completo con hashtags que
  efectivamente se ve en TikTok, no el `content` corto). `guardarHistorialPosts` nunca corta
  el batch: cualquier error de Supabase (credenciales faltantes, tabla caída, etc.) se loguea
  y se traga en `db.js`, y además el llamado desde `weekly-batch.js` está en su propio
  try/catch por las dudas. Se agregaron `SUPABASE_URL` y `SUPABASE_SECRET_KEY` como env vars
  del step "Correr weekly-batch.js" en el workflow de GitHub Actions (ya estaban cargados
  como secrets, pero no se los pasaba al step).

- **Dashboard de estado publicado en GitHub Pages** (`generate-dashboard.js`, tabla
  `system_runs` en Supabase, workflow `.github/workflows/dashboard.yml`): al final de
  `main()` en `weekly-batch.js` (haya terminado bien o con un error fatal) se guarda un
  registro de la corrida vía `guardarSystemRun` (nueva función en `db.js`, mismo patrón
  que `guardarHistorialPosts`: nunca tira excepción, solo loguea si falla). Se mide
  duración total con `Date.now()`, se cuentan posts ok/error del array `results`, y se
  acumulan las stats de cache de fotos de cada día (`generateDailyPayloads` ahora también
  devuelve `cacheStats: { hits, misses }` junto con `carouselsA/carouselsB`). El status
  queda en `success` si no hubo ningún post con error, `partial` si hubo mezcla ok/error,
  o `failure` si un error cortó el proceso antes de terminar (ej. falla en
  `getBatchStartDate`) — en ese caso `detalle_error` guarda el mensaje del error fatal;
  en `partial` guarda un resumen corto (hasta 5 fallas) armado por `summarizeErrors`.
  `generate-dashboard.js` es un script aparte (no corre como parte del batch semanal) que
  reusa `fetchFullHistory`/`sumMetrics` de `analytics.js` para traer los totales de
  views/likes/comments por cuenta, trae las últimas 10 filas de `system_runs` vía
  `getClient()` de `db.js`, y arma `dashboard/index.html` (HTML standalone, sin
  dependencias externas, con dark mode vía `prefers-color-scheme`). El workflow
  `dashboard.yml` corre 1 vez por día (11:00 UTC = 8:00 Argentina) más
  `workflow_dispatch`, y publica la carpeta `dashboard/` a GitHub Pages con
  `actions/upload-pages-artifact` + `actions/deploy-pages` (permisos `pages: write` /
  `id-token: write` en el job). `dashboard/` está en `.gitignore`: se regenera en cada
  corrida del workflow, no se commitea el HTML. Requiere haber habilitado GitHub Pages
  con Source = "GitHub Actions" en Settings del repo (paso manual, una sola vez).
