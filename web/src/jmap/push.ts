import type { Id, StateChange } from "./types";

export type PushListener = (accountId: Id, type: string, newState: string) => void;

/**
 * JMAP push over Server-Sent Events (proxied through our server).
 * Emits per-type state changes so stores can refresh incrementally.
 */
class PushManager {
  private es: EventSource | null = null;
  private listeners = new Set<PushListener>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private backoff = 1000;
  private reconnectTimer: number | null = null;
  private stopped = true;
  private lastStates = new Map<string, string>();
  connected = false;

  start(): void {
    this.stopped = false;
    this.connect();
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    this.es = null;
    this.setConnected(false);
  }

  subscribe(fn: PushListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    for (const fn of this.connectionListeners) fn(v);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && !this.es && !this.stopped) this.connect();
  };

  private onOnline = () => {
    if (!this.es && !this.stopped) this.connect();
  };

  private connect(): void {
    if (this.stopped || this.es) return;
    const url = `/api/events?types=*&closeafter=no&ping=30`;
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      this.backoff = 1000;
      this.setConnected(true);
    };
    es.addEventListener("state", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data as string) as StateChange;
        if (data["@type"] !== "StateChange") return;
        for (const [accountId, types] of Object.entries(data.changed)) {
          for (const [type, state] of Object.entries(types)) {
            const key = `${accountId}/${type}`;
            if (this.lastStates.get(key) === state) continue;
            this.lastStates.set(key, state);
            for (const fn of this.listeners) fn(accountId, type, state);
          }
        }
      } catch {
        /* ignore malformed */
      }
    });
    es.addEventListener("ping", () => {
      /* keepalive */
    });
    es.onerror = () => {
      es.close();
      this.es = null;
      this.setConnected(false);
      if (this.stopped) return;
      const delay = Math.min(this.backoff, 60_000);
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }
}

export const push = new PushManager();
