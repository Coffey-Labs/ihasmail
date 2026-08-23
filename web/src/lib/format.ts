const rtf = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Gmail-style compact date for list views. */
export function formatListDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (isSameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Full date for message headers, e.g. "Sat, Aug 22, 2026, 3:14 PM" */
export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (d.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  if (!rtf) return formatListDate(iso, now);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return formatListDate(iso, now);
}

export function formatDateShort(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatMonthYear(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function uid(prefix = "u"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T & { cancel(): void } {
  let t: number | null = null;
  const wrapped = ((...args: Parameters<T>) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  }) as T & { cancel(): void };
  wrapped.cancel = () => {
    if (t) window.clearTimeout(t);
    t = null;
  };
  return wrapped;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
