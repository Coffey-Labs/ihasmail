import { useRef } from "react";
import { t } from "@/lib/i18n";

interface Props {
  direction: "vertical" | "horizontal"; // vertical = a vertical bar that resizes width
  onResize: (delta: number) => void;
  onEnd?: () => void;
  onReset?: () => void;
  ariaLabel?: string;
  className?: string;
}

/** Drag handle between two panes. Calls onResize with the pointer delta since the last event. */
export function Splitter({ direction, onResize, onEnd, onReset, ariaLabel, className }: Props) {
  const last = useRef(0);
  const active = useRef(false);
  return (
    <div
      className={`splitter ${direction}${className ? ` ${className}` : ""}`}
      role="separator"
      aria-orientation={direction === "vertical" ? "vertical" : "horizontal"}
      aria-label={ariaLabel ?? t("Resize panes")}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault();
        active.current = true;
        last.current = direction === "vertical" ? e.clientX : e.clientY;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = direction === "vertical" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        const pos = direction === "vertical" ? e.clientX : e.clientY;
        const delta = pos - last.current;
        if (delta) {
          last.current = pos;
          onResize(delta);
        }
      }}
      onPointerUp={(e) => {
        if (!active.current) return;
        active.current = false;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onEnd?.();
      }}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -24 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 24 : 0;
        if (!step) return;
        e.preventDefault();
        // A key press is a whole drag in one: without the end, the size moved on
        // screen and was never saved.
        onResize(step);
        onEnd?.();
      }}
    >
      <span className="splitter-grip" />
    </div>
  );
}
