// The browser WebSocket with reconnect (docs/API.md).
import type {WsMessage} from '@/api/types';
import {reconnectDelayMs} from '@/state/live';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const PROTOCOL = 'openinfer.browser.v1';
/** Close code for a login that is no longer valid. */
const LOGIN_EXPIRED = 4401;
/** Close codes after an upgrade where the server refused us: say why and do not retry. */
const REFUSED: Record<number, string> = {
  4403: 'The server refused this connection: no permission.',
  4400: 'The server closed this connection with a protocol error.',
};

export type LiveSocketHandlers = {
  onMessage: (message: WsMessage) => void;
  onDisconnected: () => void;
  onRefused: (reason: string) => void;
  onExpired: () => void;
  /** The socket closed before any snapshot. A refused upgrade looks like this, with no close code to read. */
  onHandshakeFailed: () => void;
};

export class LiveSocket {
  private readonly handlers: LiveSocketHandlers;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(handlers: LiveSocketHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    this.open();
  }

  stop(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.handshakeTimer);
    this.detach();
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
  }

  private open(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/v1/ws/browser`, PROTOCOL);
    this.socket = socket;
    let established = false;
    this.handshakeTimer = setTimeout(() => {
      this.detach();
      this.handlers.onHandshakeFailed();
      this.disconnected();
    }, HANDSHAKE_TIMEOUT_MS);

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as WsMessage;
      if (message.type === 'snapshot') {
        clearTimeout(this.handshakeTimer);
        this.attempt = 0;
        established = true;
      }
      this.handlers.onMessage(message);
    };
    socket.onclose = (event) => {
      clearTimeout(this.handshakeTimer);
      this.socket = null;
      if (event.code === LOGIN_EXPIRED) {
        this.handlers.onExpired();
        return;
      }
      const refused = REFUSED[event.code];
      if (refused) {
        this.handlers.onRefused(refused);
        return;
      }
      if (!established) this.handlers.onHandshakeFailed();
      this.disconnected();
    };
  }

  private disconnected(): void {
    this.handlers.onDisconnected();
    this.retryTimer = setTimeout(() => this.open(), reconnectDelayMs(this.attempt));
    this.attempt += 1;
  }
}
