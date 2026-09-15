import { currentLanguage } from "@/lib/i18n";
import { DEFAULT_UI_LANGUAGE } from "@/lib/languages";

/**
 * Stalwart's permission labels, in the reader's language.
 *
 * The server publishes one English label per permission -- "Accounts
 * Management: Create accounts" -- and nothing else. Each language has its own
 * file under `locales/permissions`, loaded only when the Roles screen asks, so
 * six hundred labels do not ride along with every page of mail.
 *
 * A file is keyed by permission name, not by the English label, so a change
 * to Stalwart's wording does not orphan its translation. A permission a later
 * Stalwart adds has no entry yet, and shows the server's English label until
 * one is written.
 */

export interface PermissionCatalog {
  /** The English heading before the colon, e.g. "Accounts Management", to its translation. */
  categories: Record<string, string>;
  /** Permission name to the translated action, the part after the colon. */
  labels: Record<string, string>;
}

export interface PermissionInfo {
  name: string;
  /** Stalwart's English label, as the server sent it. */
  label: string;
}

export interface PermissionEntry {
  name: string;
  /** The heading this permission is listed under, in the reader's language. */
  category: string;
  /** The English heading, which is what groups are keyed by. */
  categoryKey: string;
  /** What it allows, in the reader's language. */
  action: string;
}

/** The heading a label without one is listed under. */
export const GENERAL_CATEGORY = "General";

/** Split Stalwart's "Heading: action" label at its first colon. */
export function splitLabel(label: string): { categoryKey: string; action: string } {
  const at = label.indexOf(":");
  if (at < 0) return { categoryKey: GENERAL_CATEGORY, action: label };
  return { categoryKey: label.slice(0, at).trim(), action: label.slice(at + 1).trim() };
}

const loaded = new Map<string, Promise<PermissionCatalog | null>>();

/** The catalogue for a language, or null for English and for a language without a file. */
export function loadPermissionCatalog(tag: string = currentLanguage()): Promise<PermissionCatalog | null> {
  if (tag === DEFAULT_UI_LANGUAGE) return Promise.resolve(null);
  let pending = loaded.get(tag);
  if (!pending) {
    pending = import(`../locales/permissions/${tag}.ts`).then(
      (m: { permissionCatalog: PermissionCatalog }) => m.permissionCatalog,
      () => null,
    );
    loaded.set(tag, pending);
  }
  return pending;
}

/** Each permission with its heading and action in the reader's language, falling back to Stalwart's English. */
export function describePermissions(list: readonly PermissionInfo[], catalog: PermissionCatalog | null, generalLabel: string): PermissionEntry[] {
  return list.map(({ name, label }) => {
    const { categoryKey, action } = splitLabel(label);
    const category = categoryKey === GENERAL_CATEGORY ? generalLabel : (catalog?.categories[categoryKey] ?? categoryKey);
    return { name, categoryKey, category, action: catalog?.labels[name] ?? action };
  });
}
