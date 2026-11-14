"""MouseLink desktop host: serves the phone UI and translates WebSocket input."""

from __future__ import annotations

import ctypes
import hashlib
import base64
import argparse
import json
import mimetypes
import os
import secrets
import socket
import struct
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

if sys.platform == "win32":
    from ctypes import wintypes


ROOT = Path(__file__).resolve().parent
HOST = "0.0.0.0"
PORT = int(os.environ.get("MOUSELINK_PORT", "8765"))
PAIRING_PIN = f"{secrets.randbelow(1_000_000):06d}"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 64 * 1024
MAX_TEXT = 100

_state_lock = threading.RLock()
_active_remote: str | None = None
_failed_pins: dict[str, list[float]] = {}
REMOTE_BRIDGE: "RelayBridge | None" = None


class InputController:
    """Small OS adapter. Windows works without extra packages; other OSes use pynput."""

    def __init__(self) -> None:
        self.is_windows = sys.platform == "win32"
        self.width = 0
        self.height = 0
        if self.is_windows:
            self.user32 = ctypes.windll.user32
            self.left = self.user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
            self.top = self.user32.GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
            self.width = self.user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
            self.height = self.user32.GetSystemMetrics(79) # SM_CYVIRTUALSCREEN
        else:
            try:
                from pynput.mouse import Button, Controller as MouseController
                from pynput.keyboard import Controller as KeyboardController, Key
            except ImportError as exc:
                raise RuntimeError("Install the optional desktop input package with: pip install -r requirements.txt") from exc
            self.mouse = MouseController()
            self.keyboard = KeyboardController()
            self.Button = Button
            self.Key = Key

    def move(self, dx: float, dy: float) -> None:
        if self.is_windows:
            point = wintypes.POINT()
            self.user32.GetCursorPos(ctypes.byref(point))
            x = max(self.left, min(self.left + self.width - 1, point.x + round(dx)))
            y = max(self.top, min(self.top + self.height - 1, point.y + round(dy)))
            self.user32.SetCursorPos(x, y)
        else:
            x, y = self.mouse.position
            self.mouse.position = (x + round(dx), y + round(dy))

    def button(self, button: str, pressed: bool) -> None:
        if self.is_windows:
            flags = {
                "left": (0x0002, 0x0004),
                "right": (0x0008, 0x0010),
                "middle": (0x0020, 0x0040),
            }
            down, up = flags[button]
            self.user32.mouse_event(down if pressed else up, 0, 0, 0, 0)
        else:
            self.mouse.press(getattr(self.Button, button)) if pressed else self.mouse.release(getattr(self.Button, button))

    def scroll(self, amount: int) -> None:
        if self.is_windows:
            self.user32.mouse_event(0x0800, 0, 0, int(amount * 120), 0)
        else:
            self.mouse.scroll(0, amount)

    def key(self, key_name: str) -> None:
        if self.is_windows:
            virtual_keys = {
                "ENTER": 0x0D, "TAB": 0x09, "ESCAPE": 0x1B, "BACKSPACE": 0x08,
                "SPACE": 0x20, "ARROWUP": 0x26, "ARROWDOWN": 0x28,
                "ARROWLEFT": 0x25, "ARROWRIGHT": 0x27, "DELETE": 0x2E,
            }
            code = virtual_keys.get(key_name)
            if code is not None:
                self.user32.keybd_event(code, 0, 0, 0)
                self.user32.keybd_event(code, 0, 0x0002, 0)
        else:
            key_map = {
                "ENTER": self.Key.enter, "TAB": self.Key.tab, "ESCAPE": self.Key.esc,
                "BACKSPACE": self.Key.backspace, "SPACE": self.Key.space,
                "ARROWUP": self.Key.up, "ARROWDOWN": self.Key.down,
                "ARROWLEFT": self.Key.left, "ARROWRIGHT": self.Key.right,
                "DELETE": self.Key.delete,
            }
            key = key_map.get(key_name)
            if key is not None:
                self.keyboard.press(key)
                self.keyboard.release(key)

    def type_text(self, value: str) -> None:
        if self.is_windows:
            # VK_PACKET injects Unicode without depending on the active keyboard layout.
            for character in value:
                encoded = character.encode("utf-16-le", errors="replace")
                for index in range(0, len(encoded), 2):
                    unit = int.from_bytes(encoded[index:index + 2], "little")
                    self.user32.keybd_event(0xE7, unit, 0x0004, 0)
                    self.user32.keybd_event(0xE7, unit, 0x0004 | 0x0002, 0)
        else:
            self.keyboard.type(value)

    def release_all(self) -> None:
        for button in ("left", "right", "middle"):
            try:
                self.button(button, False)
            except Exception:
                pass


class RelayBridge:
    """Keeps the desktop connected outbound to the configured MouseLink relay."""

    def __init__(self, site_url: str) -> None:
        try:
            import websocket
        except ImportError as exc:
            raise RuntimeError("Remote sessions need websocket-client. Install it with: pip install -r requirements.txt") from exc
        parsed = urlsplit(site_url.strip().rstrip("/"))
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Enter a public website URL starting with https://.")
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("Enter the website origin only, without a page path.")
        if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1"):
            raise ValueError("Remote pairing requires an HTTPS website.")
        self.site_url = urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")
        try:
            with urllib.request.urlopen(self.site_url + "/api/config", timeout=8) as response:
                config = json.loads(response.read(4096).decode("utf-8"))
        except Exception as exc:
            raise ValueError("Could not load MouseLink relay settings from that website.") from exc
        relay_origin = config.get("relayOrigin") if isinstance(config, dict) else None
        if not isinstance(relay_origin, str) or not relay_origin:
            raise ValueError("That website has no relay configured yet.")
        relay = urlsplit(relay_origin.rstrip("/"))
        if relay.scheme not in ("https", "http") or not relay.hostname or relay.username or relay.password:
            raise ValueError("The website returned an invalid relay URL.")
        if relay.path not in ("", "/") or relay.query or relay.fragment:
            raise ValueError("The relay URL must be an origin without a page path.")
        if relay.scheme != "https" and relay.hostname not in ("localhost", "127.0.0.1"):
            raise ValueError("Remote pairing requires a secure HTTPS relay.")
        socket_scheme = "wss" if relay.scheme == "https" else "ws"
        self.endpoint = f"{socket_scheme}://{relay.netloc}/relay"
        self.relay_url = relay_origin.rstrip("/")
        self.remote_url = self.site_url + "/remote/"
        self.session_code = secrets.token_hex(6).upper()
        self.pin = f"{secrets.randbelow(1_000_000):06d}"
        self._websocket_module = websocket
        self._app = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._authenticated = False
        self._phone_connected = False
        self._error: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="MouseLink-relay", daemon=True)
        self._thread.start()
        print(f"  Public remote:        {self.remote_url}")
        print(f"  Session code:         {self.session_code}")
        print(f"  Pairing PIN:          {self.pin}")

    def stop(self) -> None:
        self._stop.set()
        app = self._app
        if app is not None:
            try:
                app.close()
            except Exception:
                pass

    def status(self) -> dict[str, object]:
        with self._lock:
            return {
                "configured": True,
                "ready": self._authenticated,
                "phoneConnected": self._phone_connected,
                "siteUrl": self.site_url,
                "relayUrl": self.relay_url,
                "code": self.session_code,
                "pin": self.pin,
                "url": self.remote_url,
                "error": self._error,
            }

    def _run(self) -> None:
        delay = 2
        while not self._stop.is_set():
            address = f"{self.endpoint}/{self.session_code}?role=host"

            def opened(app) -> None:
                app.send(json.dumps({"t": "register", "pin": self.pin}))

            def received(app, raw: str) -> None:
                try:
                    message = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    return
                if message.get("t") == "auth":
                    with self._lock:
                        self._authenticated = bool(message.get("ok"))
                        self._error = None if message.get("ok") else str(message.get("reason", "Relay rejected the session"))
                    if message.get("ok"):
                        app.send(json.dumps({"t": "ready"}))
                    return
                if message.get("t") == "client":
                    with self._lock:
                        self._phone_connected = bool(message.get("connected"))
                    if not message.get("connected"):
                        INPUT.release_all()
                    return
                if message.get("t") == "input" and isinstance(message.get("event"), dict):
                    try:
                        apply_input_event(message["event"])
                    except Exception as exc:
                        print(f"Remote input failed: {exc}")

            def failed(app, error) -> None:
                with self._lock:
                    self._authenticated = False
                    self._phone_connected = False
                    self._error = str(error)[:180]

            def closed(app, status, reason) -> None:
                with self._lock:
                    self._authenticated = False
                    self._phone_connected = False

            self._app = self._websocket_module.WebSocketApp(
                address,
                on_open=opened,
                on_message=received,
                on_error=failed,
                on_close=closed,
            )
            try:
                self._app.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as exc:
                failed(self._app, exc)
            self._app = None
            if self._stop.wait(delay):
                break
            delay = min(delay * 2, 30)


def _network_ips() -> list[str]:
    addresses: set[str] = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = item[4][0]
            if not address.startswith("127."):
                addresses.add(address)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 9))
        address = probe.getsockname()[0]
        if not address.startswith("127."):
            addresses.add(address)
        probe.close()
    except OSError:
        pass
    return sorted(addresses)


def _is_local(address: str) -> bool:
    return address in ("127.0.0.1", "::1")


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def _read_exact(stream, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ConnectionError("incomplete WebSocket frame")
    return data


def _send_frame(handler: BaseHTTPRequestHandler, payload: bytes, opcode: int = 1) -> None:
    length = len(payload)
    header = bytearray([0x80 | opcode])
    if length < 126:
        header.append(length)
    elif length <= 0xFFFF:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    handler.wfile.write(header + payload)
    handler.wfile.flush()


class MouseLinkHandler(BaseHTTPRequestHandler):
    server_version = "MouseLink/1.0"

    def log_message(self, format: str, *args) -> None:
        if args and str(args[1] if len(args) > 1 else "").startswith("5"):
            super().log_message(format, *args)

    def _reply(self, status: int, body: bytes, content_type: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/status":
            with _state_lock:
                connected = _active_remote is not None
                relay_status = REMOTE_BRIDGE.status() if REMOTE_BRIDGE else {"configured": False}
            is_local = _is_local(self.client_address[0])
            result = {
                "name": socket.gethostname(), "port": PORT, "ips": _network_ips(),
                "connected": connected, "isLocal": is_local,
                "pin": PAIRING_PIN if is_local else None,
                "remote": relay_status if is_local else None,
                "platform": "Windows" if sys.platform == "win32" else sys.platform,
            }
            return self._reply(200, _json_bytes(result))
        if path == "/ws":
            return self._websocket()
        files = {"/": "index.html", "/remote": "index.html", "/index.html": "index.html",
                 "/app.css": "app.css", "/app.js": "app.js", "/manifest.webmanifest": "manifest.webmanifest",
                 "/icon.svg": "icon.svg", "/sw.js": "sw.js"}
        filename = files.get(path)
        if filename is None:
            return self._reply(404, b"Not found", "text/plain; charset=utf-8")
        try:
            payload = (ROOT / "web" / filename).read_bytes()
        except OSError:
            return self._reply(404, b"App files are missing", "text/plain; charset=utf-8")
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if filename.endswith(".webmanifest"):
            mime = "application/manifest+json"
        return self._reply(200, payload, f"{mime}; charset=utf-8" if mime.startswith("text/") or "javascript" in mime or "json" in mime else mime)

    def do_POST(self) -> None:
        global REMOTE_BRIDGE
        if not _is_local(self.client_address[0]):
            return self._reply(403, _json_bytes({"error": "Open the desktop dashboard on this computer."}))
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc.lower() != self.headers.get("Host", "").lower():
            return self._reply(403, _json_bytes({"error": "Cross-origin dashboard requests are not allowed."}))
        if urlsplit(self.path).path != "/api/remote/start":
            return self._reply(404, _json_bytes({"error": "Not found"}))
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 2048:
                raise ValueError("Invalid request size.")
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            site_url = data.get("siteUrl", "") if isinstance(data, dict) else ""
            if not isinstance(site_url, str):
                raise ValueError("Enter the public MouseLink website URL.")
            bridge = RelayBridge(site_url)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RuntimeError) as exc:
            return self._reply(400, _json_bytes({"error": str(exc)}))
        with _state_lock:
            if REMOTE_BRIDGE:
                REMOTE_BRIDGE.stop()
            REMOTE_BRIDGE = bridge
        bridge.start()
        return self._reply(200, _json_bytes({"ok": True, "remote": bridge.status()}))

    def _websocket(self) -> None:
        global _active_remote
        key = self.headers.get("Sec-WebSocket-Key")
        if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            return self._reply(400, b"WebSocket upgrade required", "text/plain; charset=utf-8")
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc.lower() != self.headers.get("Host", "").lower():
            return self._reply(403, b"Cross-origin control is not allowed", "text/plain; charset=utf-8")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        authenticated = False
        peer = self.client_address[0]
        try:
            while True:
                first, second = _read_exact(self.rfile, 2)
                if first & 0x70:
                    raise ConnectionError("reserved frame bits are unsupported")
                opcode = first & 0x0F
                masked = bool(second & 0x80)
                if not masked:
                    raise ConnectionError("client frames must be masked")
                length = second & 0x7F
                if length == 126:
                    length = struct.unpack("!H", _read_exact(self.rfile, 2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", _read_exact(self.rfile, 8))[0]
                if length > MAX_FRAME:
                    raise ConnectionError("frame too large")
                mask = _read_exact(self.rfile, 4)
                payload = _read_exact(self.rfile, length)
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
                if opcode == 8:
                    _send_frame(self, b"", 8)
                    break
                if opcode == 9:
                    _send_frame(self, payload, 10)
                    continue
                if opcode == 10:
                    continue
                if opcode != 1:
                    raise ConnectionError("only text messages are supported")
                message = json.loads(payload.decode("utf-8"))
                if not isinstance(message, dict):
                    raise ValueError("message must be an object")
                if not authenticated:
                    if message.get("t") != "auth":
                        raise PermissionError("pairing required")
                    now = time.time()
                    with _state_lock:
                        recent = [stamp for stamp in _failed_pins.get(peer, []) if now - stamp < 60]
                        _failed_pins[peer] = recent
                        locked = len(recent) >= 5
                        pin_ok = not locked and secrets.compare_digest(str(message.get("pin", "")), PAIRING_PIN)
                        if locked or not pin_ok:
                            if not locked:
                                recent.append(now)
                                _failed_pins[peer] = recent
                            busy = False
                        else:
                            busy = _active_remote is not None
                            if not busy:
                                _active_remote = peer
                                authenticated = True
                                _failed_pins.pop(peer, None)
                    if not pin_ok:
                        reason = "Too many attempts. Wait one minute and try again." if locked else "Check the PIN and try again."
                        _send_frame(self, _json_bytes({"t": "auth", "ok": False, "reason": reason}))
                        if locked:
                            break
                        continue
                    if busy:
                        _send_frame(self, _json_bytes({"t": "auth", "ok": False, "reason": "Another phone is already connected."}))
                        continue
                    _send_frame(self, _json_bytes({"t": "auth", "ok": True}))
                    continue
                self._handle_input(message)
        except (ConnectionError, OSError, ValueError, PermissionError, UnicodeDecodeError):
            pass
        except Exception as exc:
            print(f"Input event failed: {exc}")
        finally:
            if authenticated:
                with _state_lock:
                    if _active_remote == peer:
                        _active_remote = None
                INPUT.release_all()

    def _handle_input(self, message: dict) -> None:
        apply_input_event(message)


def apply_input_event(message: dict) -> None:
    event_type = message.get("t")
    if event_type == "move":
        dx = max(-140.0, min(140.0, float(message.get("x", 0))))
        dy = max(-140.0, min(140.0, float(message.get("y", 0))))
        INPUT.move(dx, dy)
    elif event_type == "button":
        button = message.get("button")
        if button in ("left", "right", "middle"):
            INPUT.button(button, bool(message.get("down")))
    elif event_type == "scroll":
        amount = max(-6, min(6, int(message.get("amount", 0))))
        if amount:
            INPUT.scroll(amount)
    elif event_type == "key":
        key_name = str(message.get("key", "")).upper()
        if key_name in {"ENTER", "TAB", "ESCAPE", "BACKSPACE", "SPACE", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "DELETE"}:
            INPUT.key(key_name)
    elif event_type == "text":
        value = message.get("value", "")
        if isinstance(value, str) and len(value) <= MAX_TEXT:
            INPUT.type_text(value)


def main() -> None:
    global INPUT, REMOTE_BRIDGE
    parser = argparse.ArgumentParser(description="MouseLink desktop mouse host")
    parser.add_argument("--site-url", "--relay-url", dest="site_url", default=os.environ.get("MOUSELINK_SITE_URL") or os.environ.get("MOUSELINK_RELAY_URL", ""), help="Public MouseLink website URL for remote sessions")
    args = parser.parse_args()
    INPUT = InputController()
    httpd = ThreadingHTTPServer((HOST, PORT), MouseLinkHandler)
    httpd.daemon_threads = True
    if args.site_url:
        REMOTE_BRIDGE = RelayBridge(args.site_url)
        REMOTE_BRIDGE.start()
    ips = _network_ips()
    print("\n  MouseLink desktop host is ready")
    print(f"  Open on this computer: http://127.0.0.1:{PORT}")
    if ips:
        print("  Open on your phone:   " + "  |  ".join(f"http://{ip}:{PORT}" for ip in ips))
    print(f"  Pairing PIN:           {PAIRING_PIN}")
    print("  Keep this window open. Press Ctrl+C to stop.\n")
    if getattr(sys, "frozen", False):
        threading.Timer(1.25, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nStopping MouseLink…")
    finally:
        if REMOTE_BRIDGE:
            REMOTE_BRIDGE.stop()
        INPUT.release_all()
        httpd.server_close()


if __name__ == "__main__":
    try:
        main()
    except OSError as exc:
        print(f"Could not start MouseLink on port {PORT}: {exc}")
        raise SystemExit(1)
    except RuntimeError as exc:
        print(exc)
        raise SystemExit(1)
