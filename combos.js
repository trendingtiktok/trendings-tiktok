const { listAllPools } = require('./drive');

const CAROUSELS_PER_ACCOUNT = 10;
const MIN_ROPA = 6;
const MAX_ROPA = 7;

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Mazo que reparte sin repetir hasta agotar el pool; al agotarse recién ahí reshufflea
// y vuelve a repartir (repite, pero en un orden nuevo cada vez que se agota el mazo).
function createDeck(pool) {
  let deck = shuffle(pool);

  function draw(exclude = new Set()) {
    const setAside = [];
    let picked = null;
    let safety = 0;
    while (picked === null) {
      if (deck.length === 0) deck = shuffle(pool);
      const candidate = deck.shift();
      if (!exclude.has(candidate.id)) {
        picked = candidate;
      } else {
        setAside.push(candidate);
      }
      safety++;
      if (safety > pool.length * 50) {
        throw new Error('El pool es más chico que la cantidad de fotos únicas requeridas dentro de un mismo carrusel');
      }
    }
    deck.push(...setAside);
    return picked;
  }

  return { draw };
}

function buildCarousel(hookDeck, fijaPhoto, ropaDeck) {
  const hook = hookDeck.draw();
  const ropaCount = randomInt(MIN_ROPA, MAX_ROPA);
  const used = new Set();
  const ropa = [];
  for (let i = 0; i < ropaCount; i++) {
    const photo = ropaDeck.draw(used);
    used.add(photo.id);
    ropa.push(photo);
  }
  return { hook, fija: fijaPhoto, ropa };
}

function summarize(carousels, field) {
  const ids = carousels.flatMap((c) => (Array.isArray(c[field]) ? c[field] : [c[field]]).map((p) => p.id));
  return {
    totalUsed: ids.length,
    uniqueUsed: new Set(ids).size,
    repeated: new Set(ids).size < ids.length,
  };
}

async function generateDailyCarousels(pools) {
  const { hooks, fija, ropa } = pools || (await listAllPools());

  if (!hooks.length) throw new Error('Pool de Hooks vacío');
  if (!fija.length) throw new Error('Pool de Fija vacío');
  if (!ropa.length) throw new Error('Pool de Ropa vacío');

  const fijaPhoto = fija[0];
  const hookDeck = createDeck(hooks);
  const ropaDeck = createDeck(ropa);

  const carousels = Array.from({ length: CAROUSELS_PER_ACCOUNT * 2 }, () =>
    buildCarousel(hookDeck, fijaPhoto, ropaDeck)
  );

  const cuentaA = carousels.slice(0, CAROUSELS_PER_ACCOUNT);
  const cuentaB = carousels.slice(CAROUSELS_PER_ACCOUNT);

  return {
    cuentaA,
    cuentaB,
    stats: {
      hooks: summarize(carousels, 'hook'),
      ropa: summarize(carousels, 'ropa'),
    },
  };
}

module.exports = { generateDailyCarousels };

if (require.main === module) {
  generateDailyCarousels()
    .then(({ cuentaA, cuentaB, stats }) => {
      console.log(`Generados ${cuentaA.length + cuentaB.length} carruseles (${cuentaA.length} cuenta A + ${cuentaB.length} cuenta B)\n`);

      console.log('Hooks:');
      console.log(`  usados: ${stats.hooks.totalUsed} | únicos: ${stats.hooks.uniqueUsed} | ¿hubo repetición?: ${stats.hooks.repeated ? 'sí' : 'no'}`);

      console.log('Ropa:');
      console.log(`  usadas: ${stats.ropa.totalUsed} | únicas: ${stats.ropa.uniqueUsed} | ¿hubo repetición?: ${stats.ropa.repeated ? 'sí' : 'no'}`);
    })
    .catch((err) => {
      console.error('Error generando carruseles:', err.message);
      process.exit(1);
    });
}
