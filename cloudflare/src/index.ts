import { DurableObject } from "cloudflare:workers";

interface Env {
  SESSIONS: DurableObjectNamespace<RelaySession>;
  ALLOWED_WEB_ORIGINS: string;
  RELAY_ORIGIN: string;
}

type Role = "host" | "client";
interface Attachment { role: Role; authenticated: boolean; rateWindow?: number; rateCount?: number }
const INPUTS = new Set(["move", "button", "scroll", "key", "text"]);
const MAX_BYTES = 8 * 1024;

function reply(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (part) => part.toString(16).padStart(2, "0")).join("");
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return reply({ ok: true, service: "MouseLink" });
    if (url.pathname === "/api/config") {
      return reply({ relayOrigin: (env.RELAY_ORIGIN || url.origin).replace(/\/+$/, "") });
    }
    const match = url.pathname.match(/^\/relay\/([A-F0-9]{12})$/);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "WebSocket required" }, 426);
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "client") return reply({ error: "Invalid role" }, 400);
      if (role === "client") {
        const origin = request.headers.get("Origin");
        if (origin) {
          const allowedOrigins = (env.ALLOWED_WEB_ORIGINS || url.origin).split(",").map((value) => value.trim()).filter(Boolean);
          let requestOrigin = "";
          try { requestOrigin = new URL(origin).origin; } catch { return reply({ error: "Invalid origin" }, 403); }
          if (!allowedOrigins.includes(requestOrigin)) return reply({ error: "Cross-origin session join blocked" }, 403);
        }
      }
      return env.SESSIONS.get(env.SESSIONS.idFromName(match[1])).fetch(request);
    }
    return reply({ error: "Not found" }, 404);
  },
};

export class RelaySession extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private authQueue: Promise<void> = Promise.resolve();
  constructor(state: DurableObjectState, env: Env) { super(state, env); this.state = state; }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "WebSocket required" }, 426);
    const role = new URL(request.url).searchParams.get("role") as Role;
    if (role !== "host" && role !== "client") return reply({ error: "Invalid role" }, 400);
    if (this.state.getWebSockets().length >= 4) return reply({ error: "Session is busy" }, 429);
    const pair = new WebSocketPair();
    const browser = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role, authenticated: false } satisfies Attachment);
    this.state.acceptWebSocket(server, [role]);
    return new Response(null, { status: 101, webSocket: browser });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; }
    catch { socket.close(1007, "Invalid JSON"); return; }
    const peer = socket.deserializeAttachment() as Attachment | null;
    if (!peer) { socket.close(1008, "Missing role"); return; }
    if (!peer.authenticated) { await this.authenticate(socket, peer, message); return; }

    if (peer.role === "host") {
      if (message.t === "ready") this.toClients({ t: "ready" });
      return;
    }
    const currentWindow = Math.floor(Date.now() / 1000);
    const rateCount = peer.rateWindow === currentWindow ? (peer.rateCount || 0) + 1 : 1;
    if (rateCount > 120) { socket.close(1008, "Input rate exceeded"); return; }
    peer.rateWindow = currentWindow;
    peer.rateCount = rateCount;
    socket.serializeAttachment(peer);
    const event = this.cleanInput(message);
    if (event) this.toHosts({ t: "input", event });
  }

  private async authenticate(socket: WebSocket, peer: Attachment, message: Record<string, unknown>): Promise<void> {
    let release!: () => void;
    const previous = this.authQueue;
    this.authQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.authenticateInOrder(socket, peer, message);
    } finally {
      release();
    }
  }

  private async authenticateInOrder(socket: WebSocket, peer: Attachment, message: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    if (peer.role === "host") {
      if (message.t !== "register" || typeof message.pin !== "string" || !/^\d{6}$/.test(message.pin)) {
        socket.close(1008, "Host registration required");
        return;
      }
      const hostExists = this.peers("host").some((item) => (item.deserializeAttachment() as Attachment).authenticated);
      if (hostExists) { socket.close(1013, "Host already connected"); return; }
      const candidate = await hash(message.pin);
      const saved = await this.state.storage.get<string>("pinHash");
      if (saved && !equal(saved, candidate)) { socket.close(1008, "Session PIN mismatch"); return; }
      await this.state.storage.put("pinHash", candidate);
      await this.state.storage.delete("failedPins");
      await this.state.storage.deleteAlarm();
      socket.serializeAttachment({ role: "host", authenticated: true } satisfies Attachment);
      send(socket, { t: "auth", ok: true, role: "host" });
      return;
    }

    if (message.t !== "auth" || typeof message.pin !== "string" || !/^\d{6}$/.test(message.pin)) {
      socket.close(1008, "Enter the six-digit PIN");
      return;
    }
    const host = this.peers("host").find((item) => (item.deserializeAttachment() as Attachment).authenticated);
    if (!host) {
      send(socket, { t: "auth", ok: false, reason: "Desktop host is offline." });
      socket.close(1013, "Host offline");
      return;
    }
    const attempts = await this.state.storage.get<{ count: number; until: number }>("failedPins");
    if (attempts && attempts.until > now && attempts.count >= 5) {
      send(socket, { t: "auth", ok: false, reason: "Too many attempts. Wait one minute." });
      socket.close(1008, "Rate limited");
      return;
    }
    const expected = await this.state.storage.get<string>("pinHash");
    if (!expected || !equal(expected, await hash(message.pin))) {
      const next = attempts && attempts.until > now
        ? { count: attempts.count + 1, until: attempts.until }
        : { count: 1, until: now + 60_000 };
      await this.state.storage.put("failedPins", next);
      send(socket, { t: "auth", ok: false, reason: "Session code or PIN is incorrect." });
      socket.close(1008, "Pairing failed");
      return;
    }
    const clientExists = this.peers("client").some((item) => (item.deserializeAttachment() as Attachment).authenticated);
    if (clientExists) {
      send(socket, { t: "auth", ok: false, reason: "Another phone is already connected." });
      socket.close(1013, "Session busy");
      return;
    }
    socket.serializeAttachment({ role: "client", authenticated: true } satisfies Attachment);
    await this.state.storage.delete("failedPins");
    send(socket, { t: "auth", ok: true, role: "client" });
    send(host, { t: "client", connected: true });
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const peer = socket.deserializeAttachment() as Attachment | null;
    if (peer?.role === "host" && peer.authenticated) {
      this.toClients({ t: "host", connected: false });
      this.state.setAlarm(Date.now() + 60_000);
    } else if (peer?.role === "client" && peer.authenticated) {
      this.toHosts({ t: "client", connected: false });
    }
    try { socket.close(code, reason); } catch { /* socket already closed */ }
  }

  webSocketError(socket: WebSocket): void {
    try { socket.close(1011, "WebSocket error"); } catch { /* socket already closed */ }
  }

  async alarm(): Promise<void> {
    const hostOnline = this.peers("host").some((item) => (item.deserializeAttachment() as Attachment).authenticated);
    if (hostOnline) return;
    for (const peer of this.state.getWebSockets()) {
      try { peer.close(1001, "Session expired"); } catch { /* socket already closed */ }
    }
    await this.state.storage.deleteAll();
  }

  private peers(role: Role): WebSocket[] { return this.state.getWebSockets(role); }
  private toHosts(value: unknown): void {
    for (const peer of this.peers("host")) if ((peer.deserializeAttachment() as Attachment).authenticated) send(peer, value);
  }
  private toClients(value: unknown): void {
    for (const peer of this.peers("client")) if ((peer.deserializeAttachment() as Attachment).authenticated) send(peer, value);
  }

  private cleanInput(message: Record<string, unknown>): Record<string, unknown> | null {
    if (!INPUTS.has(String(message.t))) return null;
    if (message.t === "move") {
      const x = Number(message.x), y = Number(message.y);
      return Number.isFinite(x) && Number.isFinite(y)
        ? { t: "move", x: Math.max(-140, Math.min(140, x)), y: Math.max(-140, Math.min(140, y)) }
        : null;
    }
    if (message.t === "button") {
      return ["left", "right", "middle"].includes(String(message.button))
        ? { t: "button", button: message.button, down: Boolean(message.down) } : null;
    }
    if (message.t === "scroll") {
      const amount = Number(message.amount);
      return Number.isInteger(amount) ? { t: "scroll", amount: Math.max(-6, Math.min(6, amount)) } : null;
    }
    if (message.t === "key") {
      const key = String(message.key).toUpperCase();
      const allowed = ["ENTER", "TAB", "ESCAPE", "BACKSPACE", "SPACE", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "DELETE"];
      return allowed.includes(key) ? { t: "key", key } : null;
    }
    return message.t === "text" && typeof message.value === "string" && message.value.length <= 100
      ? { t: "text", value: message.value } : null;
  }
}
