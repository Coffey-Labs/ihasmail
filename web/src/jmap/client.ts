import type { Id, Invocation, JmapResponse, JmapSession, MethodError, UploadResponse } from "./types";
import { withBase } from "@/lib/basePath";

export const CAP = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  vacation: "urn:ietf:params:jmap:vacationresponse",
  sieve: "urn:ietf:params:jmap:sieve",
  contacts: "urn:ietf:params:jmap:contacts",
  contactsParse: "urn:ietf:params:jmap:contacts:parse",
  calendars: "urn:ietf:params:jmap:calendars",
  calendarsParse: "urn:ietf:params:jmap:calendars:parse",
  principals: "urn:ietf:params:jmap:principals",
  availability: "urn:ietf:params:jmap:principals:availability",
  quota: "urn:ietf:params:jmap:quota",
  blob: "urn:ietf:params:jmap:blob",
  filenode: "urn:ietf:params:jmap:filenode",
  websocket: "urn:ietf:params:jmap:websocket",
} as const;

export class JmapMethodError extends Error {
  constructor(
    public readonly method: string,
    public readonly error: MethodError,
  ) {
    super(`${method}: ${error.type}${error.description ? ` - ${error.description}` : ""}`);
    this.name = "JmapMethodError";
  }
  get type() {
    return this.error.type;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `${code} (${status})`);
    this.name = "ApiError";
  }
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
  type?: string;
  detail?: string;
  title?: string;
}

interface Pending {
  method: string;
  args: Record<string, unknown>;
  using: Set<string>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export type ResultRef = { resultOf: string; name: string; path: string };

const HEADERS = { "content-type": "application/json", accept: "application/json", "x-requested-with": "ihasmail" };

/**
 * Generic fetch against our same-origin API with CSRF header + auth handling.
 *
 * `path` is written root-absolute at every call site -- `/api/jmap` -- and the
 * mount prefix is added here rather than there. One place to get it right, and
 * the `startsWith` below keeps working on the path as written rather than on
 * whatever the deployment happens to be called.
 */
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(withBase(path), {
    ...init,
    headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined) },
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    client.handleUnauthenticated();
    throw new ApiError(401, "unauthenticated", "Your session has expired. Please sign in again.");
  }
  if (!res.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body.error ?? body.type ?? "error", body.message ?? body.detail ?? body.title ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class JmapClient {
  session: JmapSession | null = null;
  private pending: Pending[] = [];
  private flushScheduled = false;
  private callCounter = 0;
  private unauthHandlers = new Set<() => void>();
  private stateHandlers = new Set<(sessionState: string) => void>();

  get maxCallsInRequest(): number {
    const core = this.session?.capabilities[CAP.core] as { maxCallsInRequest?: number } | undefined;
    return core?.maxCallsInRequest ?? 16;
  }

  get maxObjectsInGet(): number {
    const core = this.session?.capabilities[CAP.core] as { maxObjectsInGet?: number } | undefined;
    return core?.maxObjectsInGet ?? 500;
  }

  get maxObjectsInSet(): number {
    const core = this.session?.capabilities[CAP.core] as { maxObjectsInSet?: number } | undefined;
    return core?.maxObjectsInSet ?? 500;
  }

  get maxSizeUpload(): number {
    const core = this.session?.capabilities[CAP.core] as { maxSizeUpload?: number } | undefined;
    return core?.maxSizeUpload ?? 50_000_000;
  }

  hasCapability(cap: string): boolean {
    return Boolean(this.session?.capabilities && cap in this.session.capabilities);
  }

  accountHasCapability(accountId: Id, cap: string): boolean {
    const acc = this.session?.accounts[accountId];
    return Boolean(acc && cap in acc.accountCapabilities);
  }

  /**
   * Whether the server carries a capability at all, wherever it chose to
   * advertise it.
   *
   * Stalwart hands `urn:stalwart:jmap` out per-account rather than putting it
   * in the session-level `capabilities`, so `hasCapability` alone reports every
   * real 0.16 server as though it were older. Look in all three places.
   */
  hasCapabilityAnywhere(cap: string): boolean {
    if (this.hasCapability(cap)) return true;
    if (this.session?.primaryAccounts && cap in this.session.primaryAccounts) return true;
    return Object.values(this.session?.accounts ?? {}).some((a) => cap in (a.accountCapabilities ?? {}));
  }

  /**
   * The capability object itself, for the capabilities that carry limits.
   * Stalwart puts the interesting half of `urn:ietf:params:jmap:submission`
   * here and leaves the session-level copy empty.
   */
  accountCapability<T>(accountId: Id, cap: string): T | undefined {
    const acc = this.session?.accounts[accountId];
    return acc?.accountCapabilities[cap] as T | undefined;
  }

  primaryAccount(cap: string): Id | null {
    return this.session?.primaryAccounts[cap] ?? null;
  }

  onUnauthenticated(fn: () => void): () => void {
    this.unauthHandlers.add(fn);
    return () => this.unauthHandlers.delete(fn);
  }

  onSessionState(fn: (s: string) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  handleUnauthenticated(): void {
    for (const fn of this.unauthHandlers) fn();
  }

  /**
   * Queue a single method call; calls made within the same tick are batched
   * into one HTTP request (up to maxCallsInRequest).
   */
  call<T = Record<string, unknown>>(method: string, args: Record<string, unknown>, using: string[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        method,
        args,
        using: new Set([CAP.core, ...usingFor(method), ...using]),
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = [];
    const max = this.maxCallsInRequest;
    for (let i = 0; i < batch.length; i += max) {
      void this.sendBatch(batch.slice(i, i + max));
    }
  }

  private async sendBatch(batch: Pending[]): Promise<void> {
    const using = new Set<string>();
    const calls: Invocation[] = batch.map((p, idx) => {
      for (const u of p.using) using.add(u);
      return [p.method, p.args, `c${this.callCounter++}_${idx}`];
    });
    try {
      const res = await this.request(calls, [...using]);
      const byId = new Map<string, Invocation[]>();
      for (const inv of res.methodResponses) {
        const arr = byId.get(inv[2]) ?? [];
        arr.push(inv);
        byId.set(inv[2], arr);
      }
      batch.forEach((p, idx) => {
        const responses = byId.get(calls[idx]![2]);
        const first = responses?.[0];
        if (!first) {
          p.reject(new JmapMethodError(p.method, { type: "serverFail", description: "No response for call" }));
          return;
        }
        if (first[0] === "error") p.reject(new JmapMethodError(p.method, first[1] as MethodError));
        else p.resolve(first[1]);
      });
    } catch (err) {
      for (const p of batch) p.reject(err);
    }
  }

  /**
   * Drop capabilities this session never advertised.
   *
   * A server MUST reject the whole request with `unknownCapability` when
   * `using` names something it does not implement (RFC 8620), which would take
   * down every call in the batch — not just the one that wanted the capability.
   * Core always stays: it is the one urn every server has.
   */
  private supportedUsing(using: string[]): string[] {
    if (!this.session?.capabilities) return using;
    // Anywhere counts: a capability advertised per-account is one the server
    // has, and Stalwart advertises its own that way and no other.
    return using.filter((u) => u === CAP.core || this.hasCapabilityAnywhere(u));
  }

  /** Low-level request: send invocations verbatim, return raw response. */
  async request(methodCalls: Invocation[], using: string[] = [CAP.core, CAP.mail], createdIds?: Record<string, Id>): Promise<JmapResponse> {
    const body: Record<string, unknown> = { using: this.supportedUsing(using), methodCalls };
    if (createdIds) body.createdIds = createdIds;
    const res = await apiFetch<JmapResponse>("/api/jmap", { method: "POST", body: JSON.stringify(body) });
    if (res.sessionState && this.session && res.sessionState !== this.session.state) {
      for (const fn of this.stateHandlers) fn(res.sessionState);
    }
    return res;
  }

  /**
   * Run a chain of invocations (which may use result references) and return
   * responses keyed by call id. Throws if any call errored, unless `allowErrors`.
   */
  async chain(
    calls: Array<[method: string, args: Record<string, unknown>, id: string]>,
    opts: { using?: string[]; allowErrors?: boolean } = {},
  ): Promise<Map<string, Record<string, unknown>[]>> {
    const using = new Set<string>([CAP.core]);
    for (const [m] of calls) for (const u of usingFor(m)) using.add(u);
    for (const u of opts.using ?? []) using.add(u);
    const res = await this.request(calls, [...using]);
    const out = new Map<string, Record<string, unknown>[]>();
    for (const [name, args, id] of res.methodResponses) {
      if (name === "error" && !opts.allowErrors) {
        const method = calls.find((c) => c[2] === id)?.[0] ?? id;
        throw new JmapMethodError(method, args as MethodError);
      }
      const arr = out.get(id) ?? [];
      arr.push(name === "error" ? { __error: args } : args);
      out.set(id, arr);
    }
    return out;
  }

  uploadUrl(accountId: Id): string {
    return withBase(`/api/upload/${encodeURIComponent(accountId)}`);
  }

  downloadUrl(accountId: Id, blobId: Id, name: string, type: string, inline = false): string {
    const safeName = (name || "attachment").replace(/[/\\?#%]/g, "_");
    const u = withBase(`/api/blob/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(safeName)}?accept=${encodeURIComponent(type || "application/octet-stream")}`);
    return inline ? `${u}&inline=1` : u;
  }

  /** Upload a blob with progress reporting (XHR because fetch lacks upload progress). */
  upload(
    accountId: Id,
    data: Blob,
    opts: { type?: string; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.uploadUrl(accountId));
      xhr.setRequestHeader("content-type", opts.type || data.type || "application/octet-stream");
      xhr.setRequestHeader("x-requested-with", "ihasmail");
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          this.handleUnauthenticated();
          reject(new ApiError(401, "unauthenticated"));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response as UploadResponse);
        else reject(new ApiError(xhr.status, (xhr.response as ApiErrorBody)?.error ?? "upload_failed", (xhr.response as ApiErrorBody)?.message ?? "Upload failed"));
      };
      xhr.onerror = () => reject(new ApiError(0, "network_error", "Network error during upload"));
      xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled"));
      opts.signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(data);
    });
  }

  /** Fetch a blob's content as text (via the download proxy). */
  async fetchBlobText(accountId: Id, blobId: Id, type = "text/plain"): Promise<string> {
    const res = await fetch(this.downloadUrl(accountId, blobId, "blob.txt", type), { credentials: "same-origin" });
    if (res.status === 401) {
      this.handleUnauthenticated();
      throw new ApiError(401, "unauthenticated");
    }
    if (!res.ok) throw new ApiError(res.status, "download_failed");
    return await res.text();
  }

  async fetchBlob(accountId: Id, blobId: Id, type = "application/octet-stream"): Promise<Blob> {
    const res = await fetch(this.downloadUrl(accountId, blobId, "blob", type), { credentials: "same-origin" });
    if (res.status === 401) {
      this.handleUnauthenticated();
      throw new ApiError(401, "unauthenticated");
    }
    if (!res.ok) throw new ApiError(res.status, "download_failed");
    return await res.blob();
  }
}

/** Map method name prefix → required capability URNs. */
function usingFor(method: string): string[] {
  const type = method.split("/")[0] ?? "";
  switch (type) {
    case "Mailbox":
    case "Thread":
    case "Email":
    case "SearchSnippet":
      return [CAP.mail];
    // Identity belongs to the submission capability (RFC 8621), not mail:
    // Stalwart >= 0.16 rejects Identity/get and Identity/set outright when
    // "using" names only mail. Keep mail as well, so the filter in
    // supportedUsing() still leaves a usable urn on servers that predate
    // advertising submission.
    case "Identity":
    case "EmailSubmission":
      return [CAP.mail, CAP.submission];
    case "VacationResponse":
      return [CAP.mail, CAP.vacation];
    case "SieveScript":
      return [CAP.sieve];
    case "AddressBook":
    case "ContactCard":
      return [CAP.contacts, CAP.contactsParse];
    case "Calendar":
    case "CalendarEvent":
    case "ParticipantIdentity":
    case "CalendarEventNotification":
      return [CAP.calendars, CAP.calendarsParse];
    case "Principal":
      return [CAP.principals, CAP.availability];
    case "Quota":
      return [CAP.quota];
    case "Blob":
      return [CAP.blob];
    case "FileNode":
      return [CAP.filenode];
    case "PushSubscription":
      return [];
    default:
      return [];
  }
}

export const client = new JmapClient();

/** Build a JMAP result reference argument ("#ids": {...}). */
export function ref(resultOf: string, name: string, path: string): ResultRef {
  return { resultOf, name, path };
}

/** Chunk ids so a /get or /set call stays under the server's per-call maximum. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * A readable message for a JMAP SetError.
 *
 * Servers name the offending field in `properties`, which is usually the whole
 * answer to "why was this rejected" — Stalwart's description alone is often
 * just "Invalid property or value." Keep both.
 */
export function setErrorMessage(err: { type: string; description?: string; properties?: string[] } | null | undefined): string {
  if (!err) return "Unknown error";
  const base = err.description ?? err.type;
  const props = err.properties?.length ? ` (${err.properties.join(", ")})` : "";
  return `${base}${props}`;
}
