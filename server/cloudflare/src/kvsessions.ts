import { randomBytes } from "node:crypto";
import { deriveKey, open, randomToken, safeEqual, seal, sha256 } from "../../src/crypto.js";
import type { CreateSessionParams, LiveSession, SessionBackend, SessionSummary, StoredSession } from "../../src/sessions.js";

/**
 * The slice of Workers KV this uses, declared rather than imported.
 *
 * The spike stays inside the server package's own tsconfig, which has no
 * Cloudflare types; four methods is a smaller price than a second type root,
 * and it documents exactly how much of KV the design depends on.
 */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

const COOKIE_SEP = ".";
const rec = (id: string) => `s:${id}`;
/**
 * The second key is the enumeration the interface's own notes say a stateless
 * cookie cannot provide: `listForUser` and `destroyAllForUser` have to reach
 * sessions that are not presenting themselves, and "sign out everywhere" is
 * what makes a password change mean anything. KV cannot query by value, so the
 * username goes in the key and the prefix listing is the query.
 */
const idx = (username: string, id: string) => `u:${username.toLowerCase()}:${id}`;

interface Deps {
  appSecret: string;
  sessionTtl: number;
  sessionRememberTtl: number;
}

/**
 * Sessions in Workers KV, for a deployment with no disk and no memory that
 * outlives a request.
 *
 * What is stored is exactly what `SessionStore` stores: the sealing key is
 * derived from the half of the cookie the server never keeps, so KV holds
 * ciphertext and a hash, and a dump of the namespace is not a pile of
 * passwords.
 *
 * The one behaviour that is weaker than the in-process store is the sliding
 * expiry. That store bumps `lastSeenAt` on a record it already has in hand;
 * here a bump is a network write, so it is rate-limited to once a minute per
 * session -- the same threshold, for a different reason.
 *
 * KV is eventually consistent between colos. A session created in one region
 * can take a moment to be readable in another, and a revocation the same. For
 * sign-in and sign-out that is a second of oddity; for `destroyAllForUser`
 * after a password change it is a window where an old cookie still resolves
 * somewhere. A Durable Object is the answer if that window is unacceptable,
 * and this class is the shape that swap would take.
 */
export class KVSessionStore implements SessionBackend {
  constructor(
    private readonly kv: KVLike,
    private readonly deps: Deps,
  ) {}

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  private ttlFor(remember: boolean): number {
    return remember ? this.deps.sessionRememberTtl : this.deps.sessionTtl;
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

  private async read(id: string): Promise<StoredSession | null> {
    const raw = await this.kv.get(rec(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  private async write(s: StoredSession): Promise<void> {
    // KV expires the record itself, so an abandoned session needs no sweeper --
    // the timer the in-process store runs has no equivalent here and needs none.
    const ttl = Math.max(60, Math.ceil((s.expiresAt - Date.now()) / 1000));
    await this.kv.put(rec(s.id), JSON.stringify(s), { expirationTtl: ttl });
    await this.kv.put(idx(s.username, s.id), s.id, { expirationTtl: ttl });
  }

  async create(params: CreateSessionParams): Promise<{ cookie: string; session: LiveSession }> {
    const id = randomToken(18);
    const secret = randomToken(32);
    const salt = randomBytes(16);
    const key = deriveKey(secret, this.deps.appSecret, salt);
    const now = Date.now();
    const stored: StoredSession = {
      id,
      secretHash: sha256(secret),
      salt: salt.toString("base64"),
      sealedCredentials: seal(JSON.stringify({ u: params.username, p: params.password }), key),
      username: params.username,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlFor(params.remember) * 1000,
      remember: params.remember,
      userAgent: params.userAgent.slice(0, 200),
      ip: params.ip,
    };
    await this.write(stored);
    return { cookie: `${id}${COOKIE_SEP}${secret}`, session: this.toLive(stored, params.username, params.password) };
  }

  private split(cookie: string | undefined): { id: string; secret: string } | null {
    if (!cookie) return null;
    const i = cookie.indexOf(COOKIE_SEP);
    if (i <= 0) return null;
    return { id: cookie.slice(0, i), secret: cookie.slice(i + 1) };
  }

  async resolve(cookie: string | undefined): Promise<LiveSession | null> {
    const parts = this.split(cookie);
    if (!parts) return null;
    const stored = await this.read(parts.id);
    if (!stored) return null;
    const now = Date.now();
    if (stored.expiresAt <= now) {
      await this.destroy(parts.id);
      return null;
    }
    if (!safeEqual(stored.secretHash, sha256(parts.secret))) return null;
    const key = deriveKey(parts.secret, this.deps.appSecret, Buffer.from(stored.salt, "base64"));
    const json = open(stored.sealedCredentials, key);
    if (!json) return null;
    let creds: { u: string; p: string };
    try {
      creds = JSON.parse(json) as { u: string; p: string };
    } catch {
      return null;
    }
    if (now - stored.lastSeenAt > 60_000) {
      stored.lastSeenAt = now;
      stored.expiresAt = now + this.ttlFor(stored.remember) * 1000;
      await this.write(stored);
    }
    return this.toLive(stored, creds.u, creds.p);
  }

  async reseal(cookie: string | undefined, password: string): Promise<boolean> {
    const parts = this.split(cookie);
    if (!parts) return false;
    const stored = await this.read(parts.id);
    if (!stored) return false;
    if (!safeEqual(stored.secretHash, sha256(parts.secret))) return false;
    const key = deriveKey(parts.secret, this.deps.appSecret, Buffer.from(stored.salt, "base64"));
    stored.sealedCredentials = seal(JSON.stringify({ u: stored.username, p: password }), key);
    await this.write(stored);
    return true;
  }

  async destroy(id: string): Promise<void> {
    const stored = await this.read(id);
    await this.kv.delete(rec(id));
    if (stored) await this.kv.delete(idx(stored.username, id));
  }

  private async forUser(username: string): Promise<StoredSession[]> {
    const listed = await this.kv.list({ prefix: `u:${username.toLowerCase()}:` });
    const out: StoredSession[] = [];
    for (const k of listed.keys) {
      const id = k.name.slice(k.name.lastIndexOf(":") + 1);
      const s = await this.read(id);
      if (s) out.push(s);
      else await this.kv.delete(k.name); // the record expired; its index entry is litter
    }
    return out;
  }

  async destroyAllForUser(username: string, exceptId?: string): Promise<number> {
    const all = await this.forUser(username);
    let n = 0;
    for (const s of all) {
      if (s.id === exceptId) continue;
      await this.destroy(s.id);
      n++;
    }
    return n;
  }

  async listForUser(username: string): Promise<SessionSummary[]> {
    const all = await this.forUser(username);
    return all
      .map(({ id, username: u, createdAt, lastSeenAt, expiresAt, remember, userAgent, ip }) => ({ id, username: u, createdAt, lastSeenAt, expiresAt, remember, userAgent, ip }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}
