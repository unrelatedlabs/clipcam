#!/usr/bin/env python3
"""ClipCam — take a photo on your phone, paste it on your Mac.

Serves a mobile web app over HTTPS on the local network. The phone opens a
WebRTC data channel to this server and streams each photo through it; the
server puts the image on the macOS clipboard.
"""

import argparse
import asyncio
import datetime
import ipaddress
import json
import logging
import socket
import ssl
import subprocess
import tempfile
from pathlib import Path

from aiohttp import web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CERT_DIR = HERE / "certs"
MAX_PHOTO_BYTES = 64 * 1024 * 1024

log = logging.getLogger("clipcam")
peers: set[RTCPeerConnection] = set()


# ---------- Network / TLS ----------

def lan_ip() -> str:
    # Connecting a UDP socket sends nothing; it just picks the outbound interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def local_hostname() -> str | None:
    try:
        out = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, check=True)
        return f"{out.stdout.strip()}.local"
    except (OSError, subprocess.CalledProcessError):
        return None


def ensure_cert(ip: str, hostname: str | None) -> tuple[Path, Path]:
    """Return (cert, key), generating a self-signed pair if missing or stale.

    Mobile browsers only grant camera access to secure contexts, so plain HTTP won't do.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert_path, key_path = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if cert_path.exists() and key_path.exists():
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        ips = {str(a) for a in san.get_values_for_type(x509.IPAddress)}
        not_expired = cert.not_valid_after_utc > datetime.datetime.now(datetime.timezone.utc)
        if ip in ips and not_expired:
            return cert_path, key_path

    log.info("Generating self-signed certificate for %s", ip)
    CERT_DIR.mkdir(exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ClipCam")])
    alt_names = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                 x509.IPAddress(ipaddress.ip_address(ip))]
    if hostname:
        alt_names.append(x509.DNSName(hostname))
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


# ---------- Clipboard ----------

def copy_to_clipboard(jpeg: bytes, save_dir: Path | None, notify: bool) -> Path | None:
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H.%M.%S")
    with tempfile.TemporaryDirectory(prefix="clipcam-") as tmp:
        src = Path(tmp) / "photo.jpg"
        png = Path(tmp) / "photo.png"
        src.write_bytes(jpeg)
        # PNG is the image flavor virtually every Mac app accepts on paste.
        subprocess.run(["sips", "-s", "format", "png", str(src), "--out", str(png)],
                       check=True, capture_output=True)
        subprocess.run(["osascript", "-e", f'set the clipboard to (read (POSIX file "{png}") as «class PNGf»)'],
                       check=True, capture_output=True)

    saved = None
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
        saved = save_dir / f"ClipCam {stamp}.jpg"
        saved.write_bytes(jpeg)

    if notify:
        subprocess.run(["osascript", "-e", 'display notification "Photo copied to clipboard" with title "ClipCam"'],
                       capture_output=True)
    return saved


# ---------- WebRTC ----------

def attach_photo_channel(channel, app: web.Application) -> None:
    """Protocol (all control messages are JSON text):
        phone → mac: {"type":"begin","id","size"}, binary chunks…, {"type":"end","id"}
        mac → phone: {"type":"hello","name"} | {"type":"copied","id"} | {"type":"error","id","message"}
    """
    current: dict = {}

    def reply(**msg):
        if channel.readyState == "open":
            channel.send(json.dumps(msg))

    async def finish(photo_id: str, data: bytes):
        try:
            saved = await asyncio.to_thread(copy_to_clipboard, data, app["save_dir"], app["notify"])
            log.info("Copied photo %s (%.1f MB)%s", photo_id, len(data) / 1e6, f" → {saved}" if saved else "")
            reply(type="copied", id=photo_id)
        except subprocess.CalledProcessError as e:
            log.error("Clipboard failed: %s", e.stderr.decode(errors="replace").strip())
            reply(type="error", id=photo_id, message="Mac could not copy the image")

    @channel.on("message")
    def on_message(msg):
        if isinstance(msg, bytes):
            buf = current.get("buf")
            if buf is not None:
                buf.extend(msg)
                if len(buf) > current["size"]:
                    reply(type="error", id=current["id"], message="Photo larger than announced")
                    current.clear()
            return

        m = json.loads(msg)
        if m.get("type") == "begin":
            size = int(m["size"])
            if size > MAX_PHOTO_BYTES:
                reply(type="error", id=m["id"], message="Photo too large")
                return
            current.update(id=m["id"], size=size, buf=bytearray())
        elif m.get("type") == "end":
            if current.get("id") != m.get("id") or len(current["buf"]) != current["size"]:
                reply(type="error", id=m.get("id"), message="Transfer incomplete")
            else:
                asyncio.ensure_future(finish(current["id"], bytes(current["buf"])))
            current.clear()

    reply(type="hello", name=socket.gethostname().removesuffix(".local"))


async def offer(request: web.Request) -> web.Response:
    params = await request.json()
    # LAN only: host candidates are enough, no STUN/TURN.
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    peers.add(pc)
    peer = request.remote

    @pc.on("connectionstatechange")
    async def on_state():
        log.info("Phone %s: %s", peer, pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            peers.discard(pc)

    @pc.on("datachannel")
    def on_datachannel(channel):
        if channel.label == "photos":
            attach_photo_channel(channel, request.app)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=params["sdp"], type=params["type"]))
    await pc.setLocalDescription(await pc.createAnswer())
    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


async def on_shutdown(app: web.Application) -> None:
    await asyncio.gather(*(pc.close() for pc in peers))
    peers.clear()


# ---------- App ----------

async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


def print_banner(url: str) -> None:
    print(f"\n  ClipCam is running → open on your phone:\n\n    {url}\n", flush=True)
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except ImportError:
        pass
    print("  The certificate is self-signed, so the browser warns once:\n"
          "    iPhone/Safari:   Show Details → visit this website → Visit Website\n"
          "    Android/Chrome:  Advanced → Proceed to … (unsafe)\n", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--save-dir", type=Path, help="also save every photo as a JPEG in this folder")
    ap.add_argument("--no-notify", action="store_true", help="don't show a macOS notification per photo")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    if not args.verbose:
        for noisy in ("aioice", "aiortc", "aiohttp.access"):
            logging.getLogger(noisy).setLevel(logging.WARNING)

    ip, hostname = lan_ip(), local_hostname()
    cert, key = ensure_cert(ip, hostname)
    ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ssl_ctx.load_cert_chain(cert, key)

    app = web.Application()
    app["save_dir"] = args.save_dir.expanduser() if args.save_dir else None
    app["notify"] = not args.no_notify
    app.router.add_get("/", index)
    app.router.add_post("/offer", offer)
    app.router.add_static("/static/", STATIC)
    app.on_shutdown.append(on_shutdown)

    print_banner(f"https://{ip}:{args.port}/")
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_ctx, print=None)


if __name__ == "__main__":
    main()
