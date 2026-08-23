import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { deriveKey, open, randomToken, safeEqual, seal, sha256 } from "./crypto.js";

export interface StoredSession {
  id: string;
  /** sha256 of the cookie secret; used to validate presented cookies. */
  secretHash: string;
  /** base64 random salt for key derivation */
  salt: string;
  /** sealed JSON {username, password} */
  sealedCredentials: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  userAgent: string;
  ip: string;
}

export interface LiveSession {
  id: string;
  username: string;
  /** Basic Authorization header value for upstream calls. */
  authorization: string;
  remember: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string;
  ip: string;
}

const COOKIE_SEP = ".";

export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    if (this.file) {
      try {
        const raw = await readFile(this.file, "utf8");
        const arr = JSON.parse(raw) as StoredSession[];
        const now = Date.now();
        for (const s of arr) if (s.expiresAt > now) this.sessions.set(s.id, s);
        console.log(`[ihasmail] restored ${this.sessions.size} session(s)`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn("[ihasmail] could not read session file:", (err as Error).message);
        }
      }
    }
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.flush();
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed) this.scheduleSave();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 1000);
    this.saveTimer.unref();
  }

  private async flush(): Promise<void> {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.sessions.values()]), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (err) {
      console.warn("[ihasmail] could not persist sessions:", (err as Error).message);
    }
  }

  /** Create a session; returns the cookie value to hand to the client. */
  create(params: {
    username: string;
    password: string;
    remember: boolean;
    userAgent: string;
    ip: string;
  }): { cookie: string; session: LiveSession } {
    const id = randomToken(18);
    const secret = randomToken(32);
    const salt = randomBytes(16);
    const key = deriveKey(secret, config.appSecret, salt);
    const now = Date.now();
    const ttl = (params.remember ? config.sessionRememberTtl : config.sessionTtl) * 1000;
    const stored: StoredSession = {
      id,
      secretHash: sha256(secret),
      salt: salt.toString("base64"),
      sealedCredentials: seal(JSON.stringify({ u: params.username, p: params.password }), key),
      username: params.username,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ttl,
      remember: params.remember,
      userAgent: params.userAgent.slice(0, 200),
      ip: params.ip,
    };
    this.sessions.set(id, stored);
    this.scheduleSave();
    const cookie = `${id}${COOKIE_SEP}${secret}`;
    return { cookie, session: this.toLive(stored, params.username, params.password) };
  }

  /** Resolve a cookie to a live session (with decrypted upstream credentials). */
  resolve(cookie: string | undefined): LiveSession | null {
    if (!cookie) return null;
    const idx = cookie.indexOf(COOKIE_SEP);
    if (idx <= 0) return null;
    const id = cookie.slice(0, idx);
    const secret = cookie.slice(idx + 1);
    const stored = this.sessions.get(id);
    if (!stored) return null;
    const now = Date.now();
    if (stored.expiresAt <= now) {
      this.sessions.delete(id);
      this.scheduleSave();
      return null;
    }
    if (!safeEqual(stored.secretHash, sha256(secret))) return null;
    const key = deriveKey(secret, config.appSecret, Buffer.from(stored.salt, "base64"));
    const json = open(stored.sealedCredentials, key);
    if (!json) return null;
    let creds: { u: string; p: string };
    try {
      creds = JSON.parse(json) as { u: string; p: string };
    } catch {
      return null;
    }
    // Sliding expiry: bump every few minutes, not on every request.
    if (now - stored.lastSeenAt > 60_000) {
      stored.lastSeenAt = now;
      const ttl = (stored.remember ? config.sessionRememberTtl : config.sessionTtl) * 1000;
      stored.expiresAt = now + ttl;
      this.scheduleSave();
    }
    return this.toLive(stored, creds.u, creds.p);
  }

  destroy(id: string): void {
    if (this.sessions.delete(id)) this.scheduleSave();
  }

  destroyAllForUser(username: string, exceptId?: string): number {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.username === username && id !== exceptId) {
        this.sessions.delete(id);
        n++;
      }
    }
    if (n) this.scheduleSave();
    return n;
  }

  listForUser(username: string): Array<Omit<StoredSession, "secretHash" | "salt" | "sealedCredentials">> {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.username !== username) continue;
      const { secretHash: _h, salt: _s, sealedCredentials: _c, ...rest } = s;
      out.push(rest);
    }
    return out;
  }

  private toLive(s: StoredSession, username: string, password: string): LiveSession {
    return {
      id: s.id,
      username,
      authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      remember: s.remember,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent,
      ip: s.ip,
    };
  }
}
