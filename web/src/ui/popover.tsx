import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface Anchor {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export function anchorFromEl(el: Element | null): Anchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

interface PopoverProps {
  anchor: Anchor | null;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  /** Prefer opening below (default) or above. */
  side?: "bottom" | "top" | "right";
  width?: number | string;
  style?: CSSProperties;
  closeOnClick?: boolean;
  role?: string;
  /** Accessible name — dialogs need one; menus take it from their trigger. */
  ariaLabel?: string;
}

/** Generic anchored popover rendered in a portal; closes on outside click / Escape. */
export function Popover({ anchor, onClose, children, className, align = "start", side = "bottom", width, style, closeOnClick = true, role = "menu", ariaLabel }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const el = ref.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    const aw = anchor.w ?? 0;
    const ah = anchor.h ?? 0;
    let left = align === "end" ? anchor.x + aw - rect.width : anchor.x;
    let top = side === "top" ? anchor.y - rect.height - 4 : anchor.y + ah + 4;
    if (side === "right") {
      left = anchor.x + aw + 4;
      top = anchor.y;
    }
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (left < 8) left = 8;
    let maxHeight = Math.min(vh - 16, 560);
    if (top + rect.height > vh - 8) {
      // flip above if there is room, else clamp
      const above = anchor.y - rect.height - 4;
      if (above >= 8 && side !== "right") top = above;
      else {
        top = Math.max(8, vh - rect.height - 8);
        maxHeight = vh - top - 8;
      }
    }
    if (top < 8) top = 8;
    setPos({ left, top, maxHeight });
  }, [anchor, align, side]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = () => onClose();
    // Defer so the opening click doesn't immediately close.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("touchstart", onDown, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onScroll);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      className={`popover ${className ?? ""}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden", width, maxHeight: pos?.maxHeight, ...style }}
      onClick={(e) => {
        if (closeOnClick && (e.target as HTMLElement).closest(".menu-item")) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemProps {
  icon?: ReactNode;
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  kbd?: string;
  active?: boolean;
  checked?: boolean;
  /** Renders the item as a link. An external one gets a new tab. */
  href?: string;
  external?: boolean;
}

export function MenuItem({ icon, label, onClick, disabled, danger, kbd, active, checked, href, external }: MenuItemProps) {
  const inner = (
    <>
      {checked !== undefined ? <span style={{ width: 16, display: "inline-flex" }}>{checked ? "✓" : ""}</span> : icon}
      <span className="grow truncate">{label}</span>
      {kbd && <span className="menu-kbd">{kbd}</span>}
    </>
  );
  const className = `menu-item ${danger ? "danger" : ""} ${active ? "active" : ""}`;
  /*
   * A real anchor when there is somewhere to go, rather than a button that
   * calls window.open. The browser's own handling of a link comes with it --
   * middle-click, a modifier-click, "open in new tab", the address on hover,
   * copying it -- none of which a button offers however carefully it is
   * scripted, and all of which someone expects from a menu entry that leaves
   * the app.
   */
  if (href) {
    return (
      <a
        className={className}
        href={href}
        role="menuitem"
        onClick={onClick}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled} role="menuitem">
      {inner}
    </button>
  );
}

export function MenuSep() {
  return <div className="menu-sep" />;
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className="menu-title">{children}</div>;
}

/** Hook to manage a menu anchored to a trigger element. */
export function useMenu() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return {
    anchor,
    open: (e: { currentTarget: Element } | Element) => setAnchor(anchorFromEl("currentTarget" in e ? e.currentTarget : e)),
    openAt: (x: number, y: number) => setAnchor({ x, y, w: 0, h: 0 }),
    close: () => setAnchor(null),
    isOpen: anchor !== null,
  };
}

/** Simple tooltip via title-like hover with delay. */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  return (
    <span
      style={{ display: "inline-flex" }}
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        timer.current = window.setTimeout(() => setPos({ x: r.left + r.width / 2, y: r.bottom + 6 }), 500);
      }}
      onMouseLeave={() => {
        if (timer.current) window.clearTimeout(timer.current);
        setPos(null);
      }}
      onMouseDown={() => {
        if (timer.current) window.clearTimeout(timer.current);
        setPos(null);
      }}
    >
      {children}
      {pos && createPortal(<div className="tooltip" style={{ left: Math.max(8, Math.min(pos.x, window.innerWidth - 8)), top: pos.y, transform: "translateX(-50%)" }}>{text}</div>, document.body)}
    </span>
  );
}
