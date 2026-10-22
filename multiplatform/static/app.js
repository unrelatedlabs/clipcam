'use strict';

const CHUNK = 16 * 1024;            // safe SCTP message size across browsers
const HIGH_WATER = 4 * 1024 * 1024; // pause sending above this much buffered
const JPEG_QUALITY = 0.92;
const THUMB_SIZE = 160;

const $ = (id) => document.getElementById(id);
const video = $('video');
const shutter = $('shutter');
const flipBtn = $('flipBtn');
const lastBtn = $('lastBtn');
const lastThumb = $('lastThumb');
const camMsg = $('camMsg');
const camMsgText = $('camMsgText');
const fileInput = $('fileInput');
const flash = $('flash');
const statusEl = $('status');
const statusText = $('statusText');
const toastEl = $('toast');

// ---------- WebRTC connection to the Mac ----------

let pc = null;
let dc = null;
let connecting = null;
let reconnectTimer = null;
let macName = 'Mac';

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

function isOpen() {
  return dc && dc.readyState === 'open';
}

function waitForIce(conn, timeoutMs = 3000) {
  if (conn.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      conn.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => conn.iceGatheringState === 'complete' && done();
    conn.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeoutMs);
  });
}

function teardown() {
  const old = pc;
  pc = dc = null;
  old?.close();
}

function scheduleReconnect(delay = 1500) {
  setStatus('offline', 'Reconnecting…');
  requeueInFlight();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  if (connecting || isOpen()) return connecting;
  clearTimeout(reconnectTimer);
  setStatus('connecting', 'Connecting…');
  teardown();

  const conn = new RTCPeerConnection({ iceServers: [] });
  const channel = conn.createDataChannel('photos', { ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = CHUNK * 16;
  pc = conn;
  dc = channel;

  // Ignore events from connections we've already replaced.
  const current = () => conn === pc;
  channel.onopen = () => current() && pump();
  channel.onmessage = (e) => current() && onMessage(JSON.parse(e.data));
  channel.onclose = () => current() && scheduleReconnect();
  conn.onconnectionstatechange = () => {
    if (current() && ['failed', 'disconnected', 'closed'].includes(conn.connectionState)) scheduleReconnect();
  };

  connecting = (async () => {
    await conn.setLocalDescription(await conn.createOffer());
    await waitForIce(conn);
    const res = await fetch('/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: conn.localDescription.sdp, type: conn.localDescription.type }),
    });
    if (!res.ok) throw new Error(`signaling failed: ${res.status}`);
    await conn.setRemoteDescription(await res.json());
  })()
    .catch(() => current() && scheduleReconnect(3000))
    .finally(() => { connecting = null; });
  return connecting;
}

function onMessage(msg) {
  if (msg.type === 'hello') {
    macName = msg.name || 'Mac';
    setStatus('online', macName);
    return;
  }
  const item = queue.find((p) => p.id === msg.id);
  if (!item) return;
  queue.splice(queue.indexOf(item), 1);
  if (msg.type === 'copied') {
    markThumb(item, 'done');
    toast(`Copied on ${macName}`);
  } else if (msg.type === 'error') {
    markThumb(item, 'failed');
    toast(msg.message || 'Copy failed', true);
  }
  pump();
}

// ---------- Photo transfer ----------

// Photos waiting for the Mac to confirm. state: queued → sending → sent → (removed on reply)
const queue = [];
let pumping = false;
let lastPhoto = null;

function enqueue(blob, thumbUrl) {
  const item = { id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), blob, thumbUrl, state: 'queued' };
  queue.push(item);
  lastPhoto = item;
  showThumb(item);
  if (!isOpen()) {
    toast('Will send when connected');
    connect();
  }
  pump();
}

function requeueInFlight() {
  queue.forEach((p) => { if (p.state !== 'queued') p.state = 'queued'; });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let item;
    while (isOpen() && (item = queue.find((p) => p.state === 'queued'))) {
      item.state = 'sending';
      try {
        await transfer(dc, item);
        item.state = 'sent';
      } catch {
        item.state = 'queued';
        break;
      }
    }
  } finally {
    pumping = false;
  }
}

function drained(channel) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', ok);
      channel.removeEventListener('close', fail);
    };
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('channel closed')); };
    channel.addEventListener('bufferedamountlow', ok);
    channel.addEventListener('close', fail);
  });
}

async function transfer(channel, item) {
  const buf = await item.blob.arrayBuffer();
  channel.send(JSON.stringify({ type: 'begin', id: item.id, size: buf.byteLength }));
  for (let off = 0; off < buf.byteLength; off += CHUNK) {
    if (channel.bufferedAmount > HIGH_WATER) await drained(channel);
    if (channel.readyState !== 'open') throw new Error('channel closed');
    channel.send(buf.slice(off, off + CHUNK));
  }
  channel.send(JSON.stringify({ type: 'end', id: item.id }));
}

// ---------- Camera ----------

let stream = null;
let facing = localStorage.getItem('clipcam.facing') || 'environment';

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    return showCamMessage(window.isSecureContext
      ? 'Live camera not supported in this browser.'
      : 'Live camera needs HTTPS.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 4032 }, height: { ideal: 3024 } },
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

// Everything goes out as a plain JPEG with orientation already baked in.
async function sendCanvas(canvas) {
  const [blob, thumb] = await Promise.all([
    canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY),
    canvasToBlob(drawToCanvas(canvas, canvas.width, canvas.height, THUMB_SIZE), 'image/jpeg', 0.8),
  ]);
  enqueue(blob, URL.createObjectURL(thumb));
}

// ---------- Actions ----------

shutter.addEventListener('click', () => {
  if (!stream || !video.videoWidth) return;
  const canvas = drawToCanvas(video, video.videoWidth, video.videoHeight);

  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  navigator.vibrate?.(15);

  sendCanvas(canvas).catch(() => toast('Could not encode photo', true));
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
    await sendCanvas(canvas);
  } catch {
    toast('Could not read photo', true);
  }
});

lastBtn.addEventListener('click', () => {
  if (!lastPhoto || queue.includes(lastPhoto)) return;
  lastPhoto.state = 'queued';
  queue.push(lastPhoto);
  showThumb(lastPhoto);
  connect();
  pump();
});

// ---------- UI ----------

function showThumb(item) {
  if (lastThumb.src !== item.thumbUrl) lastThumb.src = item.thumbUrl;
  lastBtn.dataset.state = 'sending';
}

function markThumb(item, state) {
  if (item === lastPhoto) lastBtn.dataset.state = state;
}

let toastTimer;
function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.className = `toast show ${isError ? 'err' : 'ok'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// Mobile browsers suspend background pages: release the camera, and re-check the link on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return stopCamera();
  startCamera();
  if (!isOpen()) connect();
});

// ---------- Boot ----------

shutter.disabled = true;
// Camera first: once it's granted, browsers expose real host ICE candidates instead of mDNS names.
startCamera().finally(connect);
