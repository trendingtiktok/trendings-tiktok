const TIMEZONE_OFFSET = '-03:00'; // America/Argentina/Buenos_Aires, sin horario de verano

const WINDOW_START_MIN = 10 * 60; // 10:00 -> 600
const WINDOW_END_MIN = 23 * 60; // 23:00 -> 1380
const POSTS_PER_ACCOUNT = 10;
const MIN_GAP = 75;
const MAX_GAP = 105;
const MIN_CROSS_ACCOUNT_GAP = 15;
const ROUND_MINUTES = new Set([0, 15, 30, 45]);

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function hasRoundMinute(minutesFromMidnight) {
  return ROUND_MINUTES.has(minutesFromMidnight % 60);
}

// Genera los N horarios de una cuenta: gaps random 75-105 min, ninguno en :00/:15/:30/:45,
// todos dentro de [windowStart, windowEnd]. Usa rejection sampling porque el peor caso de
// gaps (todos en 105) no entra en la ventana de 13hs, así que se redibuja hasta que entre.
function generateAccountTimes() {
  const maxSpan = WINDOW_END_MIN - WINDOW_START_MIN;
  const maxAttempts = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const gaps = Array.from({ length: POSTS_PER_ACCOUNT - 1 }, () => randomInt(MIN_GAP, MAX_GAP));
    const span = gaps.reduce((a, b) => a + b, 0);
    if (span > maxSpan) continue;

    const slack = maxSpan - span;
    const startOffset = randomInt(0, slack);

    const times = [WINDOW_START_MIN + startOffset];
    for (const gap of gaps) times.push(times[times.length - 1] + gap);

    if (times.some(hasRoundMinute)) continue;

    return times;
  }

  throw new Error('No se pudo generar horarios para una cuenta dentro de los límites dados');
}

function crossAccountConflict(timesA, timesB) {
  return timesA.some((a) => timesB.some((b) => Math.abs(a - b) < MIN_CROSS_ACCOUNT_GAP));
}

function minutesToTimeString(minutesFromMidnight) {
  const hh = String(Math.floor(minutesFromMidnight / 60)).padStart(2, '0');
  const mm = String(minutesFromMidnight % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function toDateString(date) {
  if (typeof date === 'string') return date;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function minutesToISO(dateString, minutesFromMidnight) {
  return `${dateString}T${minutesToTimeString(minutesFromMidnight)}:00${TIMEZONE_OFFSET}`;
}

// Genera el schedule diario de las 2 cuentas: 10 horarios c/u, separación 75-105 min
// dentro de la misma cuenta, sin minutos redondos, y sin pisarse entre cuentas (min 15 min).
function generateDailySchedule(date = new Date()) {
  const dateString = toDateString(date);
  const maxAttempts = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const minutesA = generateAccountTimes();
    const minutesB = generateAccountTimes();

    if (crossAccountConflict(minutesA, minutesB)) continue;

    return {
      cuentaA: minutesA.map((m) => minutesToISO(dateString, m)),
      cuentaB: minutesB.map((m) => minutesToISO(dateString, m)),
    };
  }

  throw new Error('No se pudo generar un schedule válido sin conflictos entre cuentas');
}

module.exports = { generateDailySchedule };

if (require.main === module) {
  const schedule = generateDailySchedule(new Date());

  console.log('Cuenta A:');
  schedule.cuentaA.forEach((t) => console.log(' ', t));
  console.log('Cuenta B:');
  schedule.cuentaB.forEach((t) => console.log(' ', t));

  // Verificación de las reglas sobre el resultado generado
  const toMin = (iso) => {
    const [, time] = iso.split('T');
    const [hh, mm] = time.split(':').map(Number);
    return hh * 60 + mm;
  };

  const minA = schedule.cuentaA.map(toMin);
  const minB = schedule.cuentaB.map(toMin);

  const roundHits = [...schedule.cuentaA, ...schedule.cuentaB].filter((iso) => hasRoundMinute(toMin(iso)));
  const gapsA = minA.slice(1).map((m, i) => m - minA[i]);
  const gapsB = minB.slice(1).map((m, i) => m - minB[i]);
  const gapsOkA = gapsA.every((g) => g >= MIN_GAP && g <= MAX_GAP);
  const gapsOkB = gapsB.every((g) => g >= MIN_GAP && g <= MAX_GAP);
  const conflict = crossAccountConflict(minA, minB);

  console.log('\nChequeos:');
  console.log('  Minutos redondos encontrados:', roundHits.length === 0 ? 'OK (0)' : `FAIL (${roundHits.join(', ')})`);
  console.log('  Gaps cuenta A en [75,105]:', gapsOkA ? `OK (${gapsA.join(', ')})` : `FAIL (${gapsA.join(', ')})`);
  console.log('  Gaps cuenta B en [75,105]:', gapsOkB ? `OK (${gapsB.join(', ')})` : `FAIL (${gapsB.join(', ')})`);
  console.log('  Conflicto entre cuentas (<15min):', conflict ? 'FAIL' : 'OK');
}
