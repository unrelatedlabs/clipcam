'use strict';

const MAX_PHOTOS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const THUMB_SIZE = 240;

const $ = (id) => document.getElementById(id);
const video = $('video');
const shutter = $('shutter');
const flipBtn = $('flipBtn');
const recentBtn = $('recentBtn');
const lastThumb = $('lastThumb');
const countEl = $('count');
const sheet = $('sheet');
const grid = $('grid');
const emptyEl = $('empty');
const camMsg = $('camMsg');
const camMsgText = $('camMsgText');
const fileInput = $('fileInput');
const flash = $('flash');
const toastEl = $('toast');

// ---------- Storage (IndexedDB) ----------

const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('clipcam', 1);
  req.onupgradeneeded = () => {
    const store = req.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    store.createIndex('ts', 'ts');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(mode, fn) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction('photos', mode);
    const result = fn(t.objectStore('photos'));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const addPhoto = (rec) => tx('readwrite', (s) => s.add(rec));
const deletePhoto = (id) => tx('readwrite', (s) => s.delete(id));
const clearPhotos = () => tx('readwrite', (s) => s.clear());
const getPhoto = (id) => tx('readonly', (s) => s.get(id));

// Newest first.
async function listPhotos() {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.ts - a.ts);
}

async function prune() {
  const all = await listPhotos();
  const cutoff = Date.now() - MAX_AGE_MS;
  const doomed = all.filter((p, i) => i >= MAX_PHOTOS || p.ts < cutoff);
  if (doomed.length) {
    await tx('readwrite', (s) => doomed.forEach((p) => s.delete(p.id)));
  }
}

// ---------- Camera ----------

let stream = null;
let facing = localStorage.getItem('clipcam.facing') || 'environment';

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    return showCamMessage('Live camera not supported in this browser.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
    video.srcObject = stream;
    video.classList.toggle('mirror', facing === 'user');
    await video.play().catch(() => {});
    camMsg.hidden = true;
    shutter.disabled = false;
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showCamMessage(denied ? 'Camera permission denied.' : 'Could not start the camera.');
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function showCamMessage(text) {
  camMsgText.textContent = text;
  camMsg.hidden = false;
  shutter.disabled = true;
}

// ---------- Image helpers ----------

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality)
  );

function drawToCanvas(source, w, h, maxSide = Infinity) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const png = await canvasToBlob(drawToCanvas(bmp, bmp.width, bmp.height), 'image/png');
  bmp.close?.();
  return png;
}

async function save(fullCanvas) {
  const [blob, thumb] = await Promise.all([
    canvasToBlob(fullCanvas, 'image/jpeg', 0.92),
    canvasToBlob(drawToCanvas(fullCanvas, fullCanvas.width, fullCanvas.height, THUMB_SIZE), 'image/jpeg', 0.8),
  ]);
  await addPhoto({ ts: Date.now(), w: fullCanvas.width, h: fullCanvas.height, blob, thumb });
  await prune();
  await refresh();
}

// ---------- Clipboard ----------

// Must be called synchronously inside a user gesture. Passing a Promise<Blob> to
// ClipboardItem keeps Safari's gesture requirement satisfied while we encode.
async function copyImage(pngPromise) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard images not supported');
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
  } catch (err) {
    // Older Chromium doesn't accept promises in ClipboardItem; retry with the resolved blob.
    if (err && err.name === 'TypeError') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pngPromise })]);
    } else {
      throw err;
    }
  }
}

// ---------- Actions ----------

shutter.addEventListener('click', () => {
  if (!stream || !video.videoWidth) return;
  const canvas = drawToCanvas(video, video.videoWidth, video.videoHeight);

  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  navigator.vibrate?.(15);

  const pngPromise = canvasToBlob(canvas, 'image/png');
  copyImage(pngPromise)
    .then(() => toast('Copied to clipboard'))
    .catch(() => toast('Saved — copy failed', true));

  save(canvas).catch(() => toast('Could not save photo', true));
});

flipBtn.addEventListener('click', () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  localStorage.setItem('clipcam.facing', facing);
  startCamera();
});

// Fallback when live camera isn't available: native camera picker.
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const canvas = drawToCanvas(bmp, bmp.width, bmp.height);
    bmp.close?.();
    await save(canvas);
    // The gesture has usually expired by now, so this may fail; Recent still works.
    await copyImage(canvasToBlob(canvas, 'image/png'))
      .then(() => toast('Copied to clipboard'))
      .catch(() => toast('Saved — tap it in Recent to copy'));
  } catch {
    toast('Could not read photo', true);
  }
});

recentBtn.addEventListener('click', () => {
  refresh();
  sheet.showModal();
});
$('closeSheet').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) sheet.close(); // backdrop tap
});

$('clearAll').addEventListener('click', async () => {
  if (!grid.children.length) return;
  await clearPhotos();
  await refresh();
  toast('Cleared');
});

grid.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = Number(li.dataset.id);

  if (e.target.closest('.del')) {
    deletePhoto(id).then(refresh);
    return;
  }
  if (e.target.closest('.pic')) {
    copyImage(getPhoto(id).then((p) => toPng(p.blob)))
      .then(() => {
        toast('Copied to clipboard');
        setTimeout(() => sheet.close(), 350);
      })
      .catch(() => toast('Copy failed', true));
  }
});

// ---------- UI ----------

let urls = [];
function objectUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}

function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

async function refresh() {
  const photos = await listPhotos();
  urls.forEach(URL.revokeObjectURL);
  urls = [];

  if (photos[0]) lastThumb.src = objectUrl(photos[0].thumb);
  else lastThumb.removeAttribute('src');
  countEl.hidden = photos.length === 0;
  countEl.textContent = photos.length;

  emptyEl.hidden = photos.length > 0;
  grid.replaceChildren(
    ...photos.map((p) => {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      li.innerHTML = `
        <button class="pic" aria-label="Copy photo"><img alt=""></button>
        <time></time>
        <button class="del" aria-label="Delete">✕</button>`;
      li.querySelector('img').src = objectUrl(p.thumb);
      li.querySelector('time').textContent = relTime(p.ts);
      return li;
    })
  );
}

let toastTimer;
function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.className = `toast show ${isError ? 'err' : 'ok'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// Release the camera when backgrounded; re-acquire on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else {
    startCamera();
    prune().then(refresh);
  }
});

// ---------- Boot ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});

shutter.disabled = true;
prune().then(refresh);
startCamera();
