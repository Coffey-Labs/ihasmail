import { create } from "zustand";
import { CAP, client } from "@/jmap/client";
import type { GetResponse, Id, SetResponse, SieveScript } from "@/jmap/types";
import { rulesToSieve, sieveToRules, type SieveRule } from "@/lib/sieve";
import { useSession } from "./session";

export const IHASMAIL_SCRIPT = "ihasmail";

interface SieveState {
  accountId: Id | null;
  available: boolean;
  scripts: SieveScript[];
  /** Content of each script by id. */
  contents: Record<Id, string>;
  loading: boolean;
  error: string | null;
  init(): Promise<void>;
  load(): Promise<void>;
  getContent(id: Id): Promise<string>;
  /** Rules derived from the "ihasmail" script (null = the active script is hand-written). */
  rules(): { script: SieveScript | null; rules: SieveRule[] | null; content: string };
  saveRules(rules: SieveRule[]): Promise<void>;
  saveScript(id: Id | null, name: string, content: string, activate: boolean): Promise<Id>;
  activate(id: Id | null): Promise<void>;
  destroy(id: Id): Promise<void>;
  validate(content: string): Promise<string | null>;
  applyChanges(types: Set<string>): void;
}

export const useSieve = create<SieveState>((set, get) => ({
  accountId: null,
  available: false,
  scripts: [],
  contents: {},
  loading: false,
  error: null,

  async init() {
    const accountId = useSession.getState().accountFor(CAP.sieve);
    const available = Boolean(accountId && client.hasCapability(CAP.sieve));
    set({ accountId, available });
    if (available) await get().load();
  },

  async load() {
    const accountId = get().accountId;
    if (!accountId) return;
    set({ loading: true });
    try {
      const res = await client.call<GetResponse<SieveScript>>("SieveScript/get", { accountId, ids: null });
      set({ scripts: res.list, loading: false, error: null });
      // Preload contents
      const contents: Record<Id, string> = {};
      await Promise.all(
        res.list.map(async (s) => {
          try {
            contents[s.id] = await client.fetchBlobText(accountId, s.blobId, "application/sieve");
          } catch {
            contents[s.id] = "";
          }
        }),
      );
      set({ contents });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async getContent(id) {
    const cached = get().contents[id];
    if (cached != null) return cached;
    const s = get().scripts.find((x) => x.id === id);
    if (!s) return "";
    const text = await client.fetchBlobText(get().accountId!, s.blobId, "application/sieve");
    set((st) => ({ contents: { ...st.contents, [id]: text } }));
    return text;
  },

  rules() {
    const { scripts, contents } = get();
    const script = scripts.find((s) => s.name === IHASMAIL_SCRIPT) ?? scripts.find((s) => s.isActive) ?? null;
    const content = script ? (contents[script.id] ?? "") : "";
    return { script, rules: script ? sieveToRules(content) : [], content };
  },

  async saveRules(rules) {
    const existing = get().scripts.find((s) => s.name === IHASMAIL_SCRIPT) ?? null;
    await get().saveScript(existing?.id ?? null, IHASMAIL_SCRIPT, rulesToSieve(rules), true);
  },

  async saveScript(id, name, content, activate) {
    const accountId = get().accountId!;
    const up = await client.upload(accountId, new Blob([content], { type: "application/sieve" }), { type: "application/sieve" });
    const args: Record<string, unknown> = { accountId };
    if (id) args.update = { [id]: { name, blobId: up.blobId } };
    else args.create = { s: { name, blobId: up.blobId } };
    if (activate) args.onSuccessActivateScript = id ?? "#s";
    const res = await client.call<SetResponse<SieveScript>>("SieveScript/set", args);
    const err = id ? res.notUpdated?.[id] : res.notCreated?.s;
    if (err) throw new Error(err.description ?? err.type);
    const newId = id ?? res.created!.s!.id;
    set((s) => ({ contents: { ...s.contents, [newId]: content } }));
    await get().load();
    return newId;
  },

  async activate(id) {
    const accountId = get().accountId!;
    const args: Record<string, unknown> = { accountId };
    if (id) args.onSuccessActivateScript = id;
    else args.onSuccessDeactivateScript = true;
    // A no-op set with activation hooks.
    await client.call<SetResponse>("SieveScript/set", args);
    await get().load();
  },

  async destroy(id) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("SieveScript/set", { accountId, destroy: [id] });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(err.description ?? err.type);
    await get().load();
  },

  async validate(content) {
    const accountId = get().accountId!;
    try {
      const up = await client.upload(accountId, new Blob([content], { type: "application/sieve" }), { type: "application/sieve" });
      const res = await client.call<{ error: { type: string; description?: string } | null }>("SieveScript/validate", { accountId, blobId: up.blobId });
      return res.error ? (res.error.description ?? res.error.type) : null;
    } catch (err) {
      return (err as Error).message;
    }
  },

  applyChanges(types) {
    if (types.has("SieveScript")) void get().load();
  },
}));
