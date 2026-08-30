import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Id, SetResponse, SieveScript } from "@/jmap/types";
import { rulesToSieve, scriptDamage, sieveToRules, type SieveRule } from "@/lib/sieve";
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
  /** `loaded` distinguishes "this script is hand-written" from "we could not read it". */
  rules(): { script: SieveScript | null; rules: SieveRule[] | null; content: string; loaded: boolean; damage: string | null };
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
      // Preload contents.
      //
      // A fetch that fails must not be recorded as "". An empty script parses
      // to an empty rule list, which reads as "this script has no rules" and is
      // indistinguishable from "we could not read this script" -- and the next
      // save then writes the whole script out from that empty baseline,
      // destroying every rule in it. That is issue #76.
      //
      // Leaving the key absent instead means `rules()` reports the content as
      // unknown, and `saveRules` refuses rather than guessing.
      const fetched: Record<Id, string> = {};
      await Promise.all(
        res.list.map(async (s) => {
          try {
            fetched[s.id] = await client.fetchBlobText(accountId, s.blobId, "application/sieve");
          } catch {
            /* leave absent: unknown, not empty */
          }
        }),
      );
      // Merged, not replaced: saveScript caches the content it just wrote, and
      // a reload whose fetch failed must not throw that away.
      set((st) => ({ contents: { ...st.contents, ...fetched } }));
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
    if (!script) return { script: null, rules: [], content: "", loaded: true, damage: null };
    const content = contents[script.id];
    // Not loaded, or the fetch failed. `null` means "cannot say", which every
    // caller already treats as "do not edit this script" -- as opposed to `[]`,
    // which means "this script genuinely has no rules" and invites a save that
    // would overwrite whatever is really in it.
    if (content === undefined) return { script, rules: null, content: "", loaded: false, damage: null };
    // Read, but not all of it. Showing the rules that did parse would be the
    // most dangerous thing available: a short list that looks complete, over a
    // script that is not. Say "cannot say" here too.
    const damage = scriptDamage(content);
    if (damage) return { script, rules: null, content, loaded: true, damage };
    return { script, rules: sieveToRules(content), content, loaded: true, damage: null };
  },

  async saveRules(rules) {
    const existing = get().scripts.find((s) => s.name === IHASMAIL_SCRIPT) ?? null;
    // The last line of defence. Writing rules replaces the whole script, so
    // doing it from a baseline we never managed to read deletes whatever was
    // there. Refusing is recoverable; overwriting is not.
    if (existing) {
      const content = get().contents[existing.id];
      if (content === undefined) {
        throw new Error("Your filter script could not be read, so saving would overwrite it. Reload and try again.");
      }
      // Read in full is a separate question from read at all, and the answer
      // that cost rules in #76 was "partly". A baseline missing its tail writes
      // out just as confidently as one missing entirely.
      const damage = scriptDamage(content);
      if (damage) {
        throw new Error(`Your filter script ${damage}, so saving would overwrite the rest of it. Reload and try again.`);
      }
    }
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
    if (err) throw new Error(setErrorMessage(err));
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
    if (err) throw new Error(setErrorMessage(err));
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
