import { withBase } from "@/lib/basePath";
import { DEFAULT_SETTINGS, type Settings } from "@/store/settings";

/**
 * What the installation has decided about settings, rather than the reader.
 *
 * Two powers, from #207. `defaults` seed an account that has never had settings
 * of its own and can be changed afterwards like anything else. `enforced` are
 * applied on every load and cannot be changed here at all -- their controls stay
 * visible and go dead, which is what the issue asked for: hiding them confuses
 * somebody who has used ihasmail somewhere without a policy.
 *
 * Fetched once. `/api/config` is unauthenticated and already fetched by the
 * sign-in page, so this costs nothing on a cold load and is available before
 * anybody's settings are read.
 */
export interface PolicyChange {
  /** Unique in the policy; what an account stores to say it has had this one. */
  version: string;
  settings: Partial<Settings>;
}

export interface SettingsPolicy {
  defaults: Partial<Settings>;
  enforced: Partial<Settings>;
  /**
   * Applied once each, to everybody, and changeable afterwards.
   *
   * The third power in #207, and the one that needed somewhere to remember: an
   * admin turning something on for existing accounts, without it snapping back
   * on for a reader who then turned it off.
   */
  changes: PolicyChange[];
}

const EMPTY: SettingsPolicy = { defaults: {}, enforced: {}, changes: [] };

let policy: SettingsPolicy = EMPTY;
let fetched: Promise<SettingsPolicy> | null = null;

/**
 * Keys the installation names that this build does not have.
 *
 * A policy written against a newer ihasmail, or with a typo in it, must not
 * introduce a setting that nothing reads: `update` would carry it around and
 * `syncedPart` would push it to the reader's settings file for ever. Anything
 * not in `DEFAULT_SETTINGS` is dropped, which is the same rule `importJson`
 * already applies to a settings file somebody hands us.
 */
function known(obj: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k in DEFAULT_SETTINGS) out[k] = v;
  return out as Partial<Settings>;
}

export async function loadSettingsPolicy(): Promise<SettingsPolicy> {
  if (fetched) return fetched;
  fetched = (async () => {
    try {
      const res = await fetch(withBase("/api/config"), { credentials: "same-origin" });
      if (!res.ok) return EMPTY;
      const body = (await res.json()) as {
        settingsPolicy?: { defaults?: Record<string, unknown>; enforced?: Record<string, unknown>; changes?: Array<{ version: string; settings: Record<string, unknown> }> };
      };
      policy = {
        defaults: known(body.settingsPolicy?.defaults ?? {}),
        enforced: known(body.settingsPolicy?.enforced ?? {}),
        /* A change whose every key this build does not have is dropped whole:
           applying nothing and then recording it as applied would mean it never
           ran on the ihasmail that does have the setting. */
        changes: (body.settingsPolicy?.changes ?? [])
          .map((c) => ({ version: c.version, settings: known(c.settings ?? {}) }))
          .filter((c) => c.version && Object.keys(c.settings).length),
      };
      return policy;
    } catch {
      /* No policy is the ordinary case and an unreachable one must not stop a
         sign-in: an installation that sets nothing looks exactly like this. */
      return EMPTY;
    }
  })();
  return fetched;
}

/** What the installation has settled, for a reader who has none of their own. */
export function policyDefaults(): Partial<Settings> {
  return policy.defaults;
}

/** What the installation has settled that a reader may not change. */
export function policyEnforced(): Partial<Settings> {
  return policy.enforced;
}

/** Whether this setting belongs to the administrator rather than the reader. */
export function isEnforced(key: keyof Settings): boolean {
  return key in policy.enforced;
}

/** Changes the installation wants applied once each. */
export function policyChanges(): PolicyChange[] {
  return policy.changes;
}

/** Only for tests: forget what was fetched. */
export function resetSettingsPolicyForTest(next: Partial<SettingsPolicy> = {}): void {
  policy = {
    defaults: known((next.defaults ?? {}) as Record<string, unknown>),
    enforced: known((next.enforced ?? {}) as Record<string, unknown>),
    changes: (next.changes ?? [])
      .map((c) => ({ version: c.version, settings: known(c.settings as Record<string, unknown>) }))
      .filter((c) => c.version && Object.keys(c.settings).length),
  };
  fetched = Promise.resolve(policy);
}
