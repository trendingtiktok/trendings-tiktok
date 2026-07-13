require('dotenv').config({ quiet: true });

const API_KEY = process.env.DRIVE_API_KEY;

const FOLDERS = {
  hooks: '19RJkF52bCN3Osec-wtaA1D8ubSyxIsmp',
  fija: '1IptjN5KG51DJkAHAny8NVVxJMfyh11Cf',
  ropa: '1mOCZ9wANEbwON_hOdHbtcw_-OIQF5vEC',
};

// Convierte un file ID de Drive a link de descarga directa (el que espera Zernio).
function toDirectDownloadLink(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Lista los archivos de imagen de una carpeta de Drive (paginando si hace falta).
async function listFolderFiles(folderId) {
  const files = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: '1000',
      key: API_KEY,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(`Drive API error (folder ${folderId}): ${data.error?.message || res.statusText}`);
    }

    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  // Zernio solo acepta JPEG/PNG — filtra afuera HEIC/HEIF (fotos de iPhone) antes
  // de que lleguen al presign, donde Zernio las rechaza con 400.
  return files
    .filter((f) => ['image/jpeg', 'image/png'].includes(f.mimeType))
    .map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      downloadUrl: toDirectDownloadLink(f.id),
    }));
}

// Lista las 3 carpetas del pipeline (hooks, fija, ropa) en paralelo.
async function listAllPools() {
  const [hooks, fija, ropa] = await Promise.all([
    listFolderFiles(FOLDERS.hooks),
    listFolderFiles(FOLDERS.fija),
    listFolderFiles(FOLDERS.ropa),
  ]);
  return { hooks, fija, ropa };
}

module.exports = { listFolderFiles, listAllPools, toDirectDownloadLink, FOLDERS };

if (require.main === module) {
  listAllPools()
    .then(({ hooks, fija, ropa }) => {
      console.log(`Hooks: ${hooks.length} archivos`);
      console.log(`Fija:  ${fija.length} archivos`);
      console.log(`Ropa:  ${ropa.length} archivos`);
    })
    .catch((err) => {
      console.error('Error listando carpetas de Drive:', err.message);
      process.exit(1);
    });
}