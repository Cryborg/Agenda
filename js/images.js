// Images des événements. Chaque image est une pièce jointe de l'événement :
// { fileId, title, mimeType, fileUrl?, iconLink? }. Le contenu vient du store
// (Google Drive, ou IndexedDB en mode local) et une copie reste dans ce
// navigateur (IndexedDB) pour s'afficher vite, et hors ligne.

const DB = 'agenda-images';
const OS = 'blobs';
const MAX_SIDE = 2560;
const MAX_BYTES = 1.5 * 1024 * 1024;

export const isImage = (att) => /^image\//.test(att?.mimeType || '');

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(OS, mode);
    const req = fn(t.objectStore(OS));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getBlob = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const putBlob = (key, blob) => tx('readwrite', (s) => s.put(blob, key));

// Supprime les images locales (clés « local:… ») qui ne sont plus référencées
export async function pruneLocal(keep) {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys(IDBKeyRange.bound('local:', 'local:￿')));
    const gone = keys.filter((k) => !keep.has(k));
    if (gone.length) await tx('readwrite', (s) => gone.forEach((k) => s.delete(k)));
  } catch {
    /* rien */
  }
}

// URL affichable d'une image, en mémoire pour la session
const urls = new Map();
const pending = new Map();

export function imageUrl(store, att) {
  const id = att.fileId;
  if (urls.has(id)) return Promise.resolve(urls.get(id));
  if (!pending.has(id)) {
    const p = (async () => {
      let blob = await getBlob(id);
      if (!blob) {
        blob = await store.fetchImage(att);
        putBlob(id, blob).catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      return url;
    })().finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return pending.get(id);
}

// Réduit les grandes photos avant l'envoi (téléphone : souvent 4000 px et 5 Mo)
export async function prepareImage(file) {
  const type = file.type || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return file;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= MAX_BYTES) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  // Le PNG garde sa transparence, le reste passe en JPEG
  const outType = type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, outType, 0.85));
  if (!blob || blob.size >= file.size) return file;
  const name = outType === 'image/jpeg' ? file.name.replace(/\.\w+$/, '') + '.jpg' : file.name;
  return new File([blob], name, { type: outType });
}
