/**
 * Palettes, and the two axes they replaced.
 *
 * The theme used to be one enum — `system | light | dark | ihasmail` — where
 * "ihasmail" carried a whole palette and implied dark. That works for exactly
 * one palette. With several, the two questions come apart: **which palette**
 * (the colours) and **which mode** (light or dark), and they are chosen
 * separately.
 *
 * Every palette here is taken from the project that publishes it, all MIT, and
 * from that project's own repository rather than from anyone's reimplementation
 * of it. The values are recorded in `.palette-sources/palettes-upstream.md` so
 * the derivation can be checked rather than taken on trust.
 */

export type PaletteId = "default" | "ihasmail" | "dracula" | "gruvbox" | "rose-pine" | "tokyo-night";
export type Mode = "system" | "light" | "dark";
/** What a mode resolves to once the system has been asked. */
export type ResolvedMode = "light" | "dark";

export interface PaletteMeta {
  id: PaletteId;
  name: string;
  /** Shown in Settings and in NOTICE; who to credit and under what. */
  credit?: string;
  /**
   * Whether the name is a word rather than a name.
   *
   * Five of these six are proper names -- ihasmail, Dracula, Gruvbox, Rosé
   * Pine, Tokyo Night -- and are rendered translate="no" so a page translator
   * leaves them alone. "Classic" is not a name, it is an adjective describing
   * the theme, and a German reader should see "Klassisch". Reported by a
   * native speaker reviewing the German catalogue (#247).
   */
  translatable?: boolean;
}

export const PALETTES: PaletteMeta[] = [
  { id: "default", name: "Classic", translatable: true },
  { id: "ihasmail", name: "ihasmail" },
  { id: "dracula", name: "Dracula", credit: "Dracula Theme (MIT) — dark: Dracula, light: Alucard" },
  { id: "gruvbox", name: "Gruvbox", credit: "gruvbox by morhetz (MIT)" },
  { id: "rose-pine", name: "Rosé Pine", credit: "Rosé Pine (MIT) — light variant is Dawn" },
  { id: "tokyo-night", name: "Tokyo Night", credit: "Tokyo Night by enkia (MIT) — light variant is Day" },
];

const byId = new Map(PALETTES.map((p) => [p.id, p]));

export function paletteMeta(id: PaletteId | string | null | undefined): PaletteMeta {
  return byId.get(id as PaletteId) ?? byId.get("default")!;
}

/**
 * Which of light and dark is actually being drawn.
 *
 * Every palette has both halves, so this is only ever resolving "system"
 * against the OS. That was not true while `ihasmail` was dark-only: the mode
 * then had to be overridden by the palette, and the toggle had to remember
 * which palette it had set aside on the way to light. Giving that palette a
 * light half removed the override, the memory and the greyed-out control in
 * one go.
 */
export function effectiveMode(mode: Mode, prefersDark: boolean): ResolvedMode {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

export interface ThemeChoice {
  palette: PaletteId;
  mode: Mode;
}

/**
 * The old enum, read as the two axes.
 *
 * Settings are stored in the account's own Files and are read by whatever
 * version happens to open them next, so this has to keep working indefinitely
 * rather than for one release.
 */
export function migrateTheme(theme: string | null | undefined): ThemeChoice {
  switch (theme) {
    case "ihasmail":
      return { palette: "ihasmail", mode: "dark" };
    case "light":
      return { palette: "default", mode: "light" };
    case "dark":
      return { palette: "default", mode: "dark" };
    case "system":
      return { palette: "default", mode: "system" };
    default:
      // Unknown, absent, or written by something newer: the default is what a
      // new account gets, and is never wrong in a way that hides mail.
      return { palette: "ihasmail", mode: "dark" };
  }
}

/**
 * The old enum, written back alongside the new fields.
 *
 * A device still running an older build reads `theme` and ignores everything
 * it does not know, so leaving it stale would show that device a theme nobody
 * chose. It cannot express "Gruvbox", but it can express light or dark, which
 * is the half that matters.
 */
export function legacyTheme(choice: ThemeChoice, prefersDark = false): "system" | "light" | "dark" | "ihasmail" {
  // Only the dark half of ihasmail's own palette has an old name; its light
  // half is new, and an older build has no word for it beyond "light".
  if (choice.palette === "ihasmail" && effectiveMode(choice.mode, prefersDark) === "dark") return "ihasmail";
  if (choice.palette === "default" && choice.mode === "system") return "system";
  return effectiveMode(choice.mode, prefersDark);
}

/**
 * Where the top-bar toggle goes.
 *
 * The palette never changes: only the mode flips. This used to be the awkward
 * part -- leaving a dark-only palette for light meant changing palette too,
 * and remembering which one to come back to -- and it stopped being awkward
 * when every palette gained both halves.
 */
export function toggleTarget(current: ThemeChoice, prefersDark: boolean): ThemeChoice {
  return { palette: current.palette, mode: effectiveMode(current.mode, prefersDark) === "dark" ? "light" : "dark" };
}
