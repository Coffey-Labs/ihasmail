/**
 * Gmail-style keyboard shortcut manager with two-key sequences ("g i").
 * Handlers are registered in scopes; the most recently pushed scope wins.
 */
export type KeyHandler = (e: KeyboardEvent) => void | boolean;

interface Binding {
  keys: string; // e.g. "j", "shift+i", "g i", "mod+enter"
  handler: KeyHandler;
  description: string;
  group: string;
  allowInInput?: boolean;
}

interface Scope {
  name: string;
  bindings: Binding[];
}

class Keyboard {
  private scopes: Scope[] = [];
  private pendingPrefix: string | null = null;
  private prefixTimer: number | null = null;
  enabled = true;

  constructor() {
    if (typeof window !== "undefined") window.addEventListener("keydown", this.onKeyDown, true);
  }

  pushScope(name: string, bindings: Binding[]): () => void {
    const scope = { name, bindings };
    this.scopes.push(scope);
    return () => {
      this.scopes = this.scopes.filter((s) => s !== scope);
    };
  }

  /** All bindings with descriptions, for the help overlay. */
  list(): Array<{ group: string; keys: string; description: string }> {
    const seen = new Set<string>();
    const out: Array<{ group: string; keys: string; description: string }> = [];
    for (const s of [...this.scopes].reverse()) {
      for (const b of s.bindings) {
        if (!b.description || seen.has(b.keys)) continue;
        seen.add(b.keys);
        out.push({ group: b.group, keys: b.keys, description: b.description });
      }
    }
    return out;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    // Let modal dialogs and popovers handle their own keys (Escape, arrows, ...).
    if (document.querySelector(".dialog-backdrop, .popover")) return;
    const target = e.target as HTMLElement | null;
    const inInput =
      !!target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    const combo = comboOf(e);
    if (!combo) return;

    // Try sequence completion first.
    const candidates: Binding[] = [];
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      for (const b of this.scopes[i]!.bindings) candidates.push(b);
    }
    if (this.pendingPrefix) {
      const seq = `${this.pendingPrefix} ${combo}`;
      const b = candidates.find((x) => x.keys === seq && (!inInput || x.allowInInput));
      this.clearPrefix();
      if (b) {
        const r = b.handler(e);
        if (r !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    }
    // Is this combo the first half of any sequence?
    if (!inInput && candidates.some((x) => x.keys.startsWith(`${combo} `))) {
      this.pendingPrefix = combo;
      this.prefixTimer = window.setTimeout(() => this.clearPrefix(), 1200);
      e.preventDefault();
      return;
    }
    const b = candidates.find((x) => x.keys === combo && (!inInput || x.allowInInput));
    if (b) {
      const r = b.handler(e);
      if (r !== false) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  private clearPrefix() {
    this.pendingPrefix = null;
    if (this.prefixTimer) window.clearTimeout(this.prefixTimer);
    this.prefixTimer = null;
  }
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function comboOf(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && key.length > 1) parts.push("shift");
  let k = key;
  if (k === " ") k = "space";
  else if (k === "Escape") k = "esc";
  else if (k.length === 1) {
    // Single chars: shift is encoded by the character itself (e.g. "#", "!").
    k = k.length === 1 && !e.shiftKey ? k.toLowerCase() : k;
  } else k = k.toLowerCase();
  parts.push(k);
  return parts.join("+");
}

export function formatKeys(keys: string): string {
  return keys
    .split(" ")
    .map((k) =>
      k
        .split("+")
        .map((p) => (p === "mod" ? (isMac ? "⌘" : "Ctrl") : p === "shift" ? "⇧" : p === "alt" ? (isMac ? "⌥" : "Alt") : p === "enter" ? "↵" : p === "esc" ? "Esc" : p === "space" ? "Space" : p === "arrowup" ? "↑" : p === "arrowdown" ? "↓" : p === "arrowleft" ? "←" : p === "arrowright" ? "→" : p.length === 1 ? p : p[0]!.toUpperCase() + p.slice(1)))
        .join(isMac ? "" : "+"),
    )
    .join(" then ");
}

export const keyboard = new Keyboard();
