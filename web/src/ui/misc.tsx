import { useEffect, useState, type ReactNode } from "react";
import type { EmailAddress } from "@/jmap/types";
import { avatarColor, initials } from "@/lib/address";
import { useContacts } from "@/store/contacts";
import { contactPhoto } from "@/lib/contacts";
import { t } from "@/lib/i18n";

export function Avatar({ who, size, className }: { who: EmailAddress | { name?: string | null; email?: string } | string | null | undefined; size?: "sm" | "lg" | "xl"; className?: string }) {
  const email = typeof who === "string" ? who : (who?.email ?? "");
  const name = typeof who === "string" ? who : (who?.name ?? who?.email ?? "");
  const photo = useContacts((s) => {
    if (!email || !s.loaded) return null;
    const c = s.lookupByEmail(email);
    return c && s.accountId ? contactPhoto(c, s.accountId) : null;
  });
  return (
    <span className={`avatar ${size ?? ""} ${className ?? ""}`} style={{ background: photo ? "transparent" : avatarColor(email || name) }} aria-hidden="true">
      {photo ? <img src={photo} alt="" loading="lazy" /> : initials({ name, email })}
    </span>
  );
}

export function Switch({ checked, onChange, label, hint, disabled, locked }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean; locked?: boolean }) {
  const sw = (
    <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => !disabled && !locked && onChange(!checked)} disabled={disabled || locked} />
  );
  if (!label) return sw;
  return (
    <div className="switch-row">
      <div className="switch-text">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
        {/* Shown rather than hidden, and said rather than implied: a control
            that is simply missing reads as a bug to somebody who has used
            ihasmail without a policy. Issue #207. */}
        {locked && <span className="hint">{t("Set for everyone here. You cannot change this.")}</span>}
      </div>
      {sw}
    </div>
  );
}

export function Spinner({ size = "md", label }: { size?: "md" | "lg"; label?: string }) {
  return (
    <div className="row" style={{ justifyContent: "center", padding: 16, gap: 10 }}>
      <span className={`spinner ${size === "lg" ? "lg" : ""}`} />
      {label && <span className="muted">{label}</span>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = () => setM(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [q]);
  return m;
}

export const useIsMobile = () => useMediaQuery("(max-width: 768px)");
export const useIsNarrow = () => useMediaQuery("(max-width: 900px)");
/**
 * Whether the thing doing the pointing is a finger.
 *
 * The touch gestures hang off this rather than off `useIsMobile`, because the
 * two are different questions and both get asked: a tablet in landscape is a
 * wide screen that swipes, and a phone plugged into a mouse is a narrow one
 * that should not. Width decides the layout; this decides the gestures.
 */
export const useIsTouch = () => useMediaQuery("(pointer: coarse)");

export function Kbd({ keys }: { keys: string }) {
  return (
    <span className="keys">
      {keys.split(" ").map((k, i) => (
        <span key={i}>
          {i > 0 && <span className="muted" style={{ margin: "0 3px" }}>{t("then")}</span>}
          {k.split("+").map((p, j) => (
            <kbd key={j} className="kbd" style={{ marginRight: 2 }}>
              {p === "mod" ? (navigator.platform.includes("Mac") ? "⌘" : "Ctrl") : p === "shift" ? "⇧" : p === "enter" ? "↵" : p === "esc" ? "Esc" : p}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

export function ColorSwatches({ value, onChange, colors }: { value: string | null | undefined; onChange: (c: string) => void; colors?: string[] }) {
  const list = colors ?? CALENDAR_COLORS;
  return (
    <div className="swatches">
      {list.map((c) => (
        <button key={c} type="button" className={`swatch ${value?.toLowerCase() === c ? "active" : ""}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
    </div>
  );
}

export const CALENDAR_COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#4b5563", "#9333ea", "#be123c"];
