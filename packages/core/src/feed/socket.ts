// A WebSocket that reconnects by itself with exponential backoff:
// 1 s, 2 s, 4 s, ... up to 30 s. The delay resets once data flows again.
// Uses Node's built-in WebSocket; tests pass in a fake one.

export type WsLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
};

export type SocketOptions = {
  name: string;
  url: string;
  /** Called right after each (re)connect, e.g. to send a subscribe message. */
  onOpen: (send: (msg: unknown) => void) => void;
  onMessage: (text: string) => void;
  onStatus: (connected: boolean, detail: string) => void;
  /** Some venues (Bybit) close idle sockets unless we ping. */
  ping?: { message: unknown; everyMs: number };
  minDelayMs?: number;
  maxDelayMs?: number;
  createSocket?: (url: string) => WsLike;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };
};

export function backoffDelay(attempt: number, minDelayMs = 1_000, maxDelayMs = 30_000): number {
  return Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
}

export class ReconnectingSocket {
  private ws: WsLike | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private opts: SocketOptions;
  private timers: NonNullable<SocketOptions["timers"]>;
  /** How many times we have (re)connected. Visible for tests and the health strip. */
  connectCount = 0;
  /** The delay used for the most recent reconnect, in ms. */
  lastDelayMs: number | null = null;

  constructor(opts: SocketOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    if (this.pingTimer) this.timers.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
    let ws: WsLike;
    try {
      ws = create(this.opts.url);
    } catch (err) {
      this.handleClose(`could not open socket: ${(err as Error).message}`);
      return;
    }
    this.ws = ws;
    const send = (msg: unknown) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));

    ws.onopen = () => {
      this.connectCount += 1;
      this.opts.onStatus(true, `${this.opts.name} connected`);
      this.opts.onOpen(send);
      if (this.opts.ping) {
        const { message, everyMs } = this.opts.ping;
        this.pingTimer = this.timers.setInterval(() => send(message), everyMs);
      }
    };
    ws.onmessage = (ev) => {
      this.attempt = 0; // data is flowing, so the next drop starts from the short delay again
      this.opts.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    ws.onerror = () => {
      // An error is always followed by close; we reconnect there.
    };
    ws.onclose = () => {
      if (this.ws === ws) this.handleClose("connection closed");
    };
  }

  private handleClose(detail: string): void {
    if (this.pingTimer) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
    this.opts.onStatus(false, `${this.opts.name}: ${detail}`);
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, this.opts.minDelayMs, this.opts.maxDelayMs);
    this.attempt += 1;
    this.lastDelayMs = delay;
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), delay);
  }
}
