'use strict';

const MAX_PHOTOS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const THUMB_SIZE = 240;
const MAX_SIDE = 2048; // long edge of captured photos; PNG gets slow and huge beyond this
const MAX_DIGITAL_ZOOM = 5;

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
const viewfinder = $('viewfinder');
const lensesEl = $('lenses');
const zoomBadge = $('zoomBadge');
const focusRing = $('focusRing');
const torchBtn = $('torchBtn');

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
let track = null;
let facing = localStorage.getItem('clipcam.facing') || 'environment';
let zoomCap = null; // hardware zoom range, if the camera exposes one
let zoom = 1; // hardware zoom when zoomCap is set, otherwise digital (CSS scale + crop)

const lensKey = () => `clipcam.lens.${facing}`;

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    return showCamMessage('Live camera not supported in this browser.');
  }
  const saved = localStorage.getItem(lensKey());
  const open = (lens) =>
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(lens ? { deviceId: { exact: lens } } : { facingMode: { ideal: facing } }),
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
  try {
    try {
      stream = await open(saved);
    } catch (err) {
      if (!saved || err.name === 'NotAllowedError') throw err;
      localStorage.removeItem(lensKey()); // saved lens is gone; fall back to any camera
      stream = await open(null);
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => {});
    camMsg.hidden = true;
    shutter.disabled = false;
    setupTrackFeatures();
    renderLenses();
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showCamMessage(denied ? 'Camera permission denied.' : 'Could not start the camera.');
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
}

function setupTrackFeatures() {
  const caps = track.getCapabilities?.() || {};
  zoomCap = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
  zoom = zoomCap ? track.getSettings().zoom || zoomCap.min : 1;
  torchBtn.hidden = !caps.torch;
  torchBtn.classList.remove('on');
  applyPreviewTransform();
  updateZoomBadge();
}

// ---------- Lenses ----------

// iOS labels its lenses ("Back Ultra Wide Camera", "Back Telephoto Camera", ...);
// Android/desktop labels are opaque, so those just get numbered.
function lensFacing(label) {
  if (/front|user|facing front/i.test(label)) return 'user';
  if (/back|rear|environment|facing back/i.test(label)) return 'environment';
  return null;
}

function lensInfo(label) {
  if (/dual|triple/i.test(label)) return { virtual: true, order: 9 };
  if (/ultra ?wide/i.test(label)) return { name: '.5×', order: 0 };
  if (/tele/i.test(label)) return { name: 'Tele', order: 2 };
  if (/^(back|front)( truedepth)? camera$/i.test(label)) return { name: '1×', order: 1 };
  return { order: 5 };
}

async function renderLenses() {
  const current = track?.getSettings().deviceId;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'videoinput' && d.deviceId
  );
  const all = devices
    .filter((d) => [facing, null].includes(lensFacing(d.label)))
    .map((d) => ({ id: d.deviceId, label: d.label, ...lensInfo(d.label) }));
  const physical = all.filter((l) => !l.virtual);
  const lenses = (physical.length ? physical : all).sort((a, b) => a.order - b.order);

  lensesEl.replaceChildren(
    ...lenses.map((l, i) => {
      const b = document.createElement('button');
      b.className = 'lens' + (l.id === current ? ' active' : '');
      b.textContent = l.name || String(i + 1);
      b.title = l.label;
      b.dataset.id = l.id;
      return b;
    })
  );
  lensesEl.hidden = lenses.length < 2;
}

lensesEl.addEventListener('click', (e) => {
  const b = e.target.closest('.lens');
  if (!b || b.classList.contains('active')) return;
  localStorage.setItem(lensKey(), b.dataset.id);
  startCamera();
});

// ---------- Zoom, focus, torch ----------

function applyPreviewTransform() {
  const mirror = track?.getSettings().facingMode === 'user' || (!track?.getSettings().facingMode && facing === 'user');
  const s = zoomCap ? 1 : zoom;
  video.style.transform = `scale(${mirror ? -s : s}, ${s})`;
}

function updateZoomBadge() {
  const base = zoomCap ? zoomCap.min : 1;
  const shown = zoom / base;
  zoomBadge.textContent = `${shown < 10 ? shown.toFixed(1) : Math.round(shown)}×`;
  zoomBadge.hidden = Math.abs(shown - 1) < 0.05;
}

let zoomFrame = 0;
function setZoom(z) {
  const [min, max] = zoomCap ? [zoomCap.min, zoomCap.max] : [1, MAX_DIGITAL_ZOOM];
  zoom = Math.min(max, Math.max(min, z));
  updateZoomBadge();
  if (!zoomCap) return applyPreviewTransform();
  cancelAnimationFrame(zoomFrame);
  zoomFrame = requestAnimationFrame(() => track?.applyConstraints({ advanced: [{ zoom }] }).catch(() => {}));
}

zoomBadge.addEventListener('click', () => setZoom(zoomCap ? zoomCap.min : 1));

// Map a tap on the (object-fit: cover, possibly scaled/mirrored) preview to 0..1 frame coords.
function toFramePoint(clientX, clientY) {
  const r = video.getBoundingClientRect();
  const scale = Math.max(r.width / video.videoWidth, r.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  let x = (clientX - r.left - (r.width - w) / 2) / w;
  const y = (clientY - r.top - (r.height - h) / 2) / h;
  if (video.style.transform.startsWith('scale(-')) x = 1 - x;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function focusAt(clientX, clientY) {
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
  const adv = {};
  if (supported.pointsOfInterest) adv.pointsOfInterest = [toFramePoint(clientX, clientY)];
  if (caps.focusMode?.includes('single-shot')) adv.focusMode = 'single-shot';
  if (caps.exposureMode?.includes('single-shot')) adv.exposureMode = 'single-shot';
  if (!adv.pointsOfInterest && !adv.focusMode) return; // camera doesn't allow focus control

  const box = viewfinder.getBoundingClientRect();
  focusRing.style.left = `${clientX - box.left}px`;
  focusRing.style.top = `${clientY - box.top}px`;
  focusRing.classList.remove('go');
  void focusRing.offsetWidth;
  focusRing.classList.add('go');
  track.applyConstraints({ advanced: [adv] }).catch(() => {});
}

// One finger tap = focus, two finger pinch = zoom.
const pointers = new Map();
let pinch = null;
let tap = null;

viewfinder.addEventListener('pointerdown', (e) => {
  if (!track) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    tap = { x: e.clientX, y: e.clientY, t: Date.now() };
  } else if (pointers.size === 2) {
    tap = null;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
  }
});

viewfinder.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    setZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
  }
});

const endPointer = (e) => {
  if (!pointers.delete(e.pointerId)) return;
  if (tap && e.type === 'pointerup' && Date.now() - tap.t < 500) focusAt(e.clientX, e.clientY);
  tap = null;
  if (pointers.size < 2) pinch = null;
};
viewfinder.addEventListener('pointerup', endPointer);
viewfinder.addEventListener('pointercancel', endPointer);
// iOS Safari would otherwise zoom the whole page on pinch.
document.addEventListener('gesturestart', (e) => e.preventDefault());

torchBtn.addEventListener('click', () => {
  const on = !torchBtn.classList.contains('on');
  track?.applyConstraints({ advanced: [{ torch: on }] })
    .then(() => torchBtn.classList.toggle('on', on))
    .catch(() => toast('Flash unavailable', true));
});

// Grab the current frame, cropped to the digital zoom and capped at MAX_SIDE.
function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const z = zoomCap ? 1 : zoom;
  const sw = vw / z;
  const sh = vh / z;
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext('2d').drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
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
  const canvas = captureFrame();

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
    const canvas = drawToCanvas(bmp, bmp.width, bmp.height, MAX_SIDE);
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
