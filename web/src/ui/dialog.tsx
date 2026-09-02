import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { create } from "zustand";
import { t } from "@/lib/i18n";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeOnBackdrop?: boolean;
  className?: string;
}

export function Dialog({ open, onClose, title, children, footer, size = "md", closeOnBackdrop = true, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  /*
   * Callers almost always pass an inline arrow for onClose, so its identity
   * changes on every render of the parent. Depending on it here would tear the
   * effect down and set it up again on every keystroke in a dialog that holds
   * state, and the autofocus below would drag the caret back to the first
   * field mid-typing. Keep the latest handler in a ref instead, so the effect
   * depends only on `open`.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
      if (e.key === "Tab" && ref.current) {
        const focusables = ref.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]');
        if (!focusables.length) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    // autofocus first input
    window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("[autofocus],input,textarea,select,button.btn-primary");
      el?.focus();
    }, 10);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`dialog ${size} ${className ?? ""}`} role="dialog" aria-modal="true" ref={ref}>
        {title !== undefined && (
          <div className="dialog-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
              <X size={20} />
            </button>
          </div>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Imperative confirm / prompt ---------- */

export interface DialogChoice {
  value: string;
  label: string;
  /** Shown under the label, for the choice that needs the caveat. */
  hint?: string;
  danger?: boolean;
  /**
   * The safe answer, given the weight a dialog's confirm button has.
   *
   * A list of choices has no default until one is said to be, and the
   * destructive one must not become it by being the only thing with a colour --
   * which is what "Discard changes" was, on a guard whose whole purpose is to
   * stop you losing work ([#175]).
   *
   * [#175]: https://github.com/Coffey-Labs/ihasmail/issues/175
   */
  primary?: boolean;
}

interface ConfirmRequest {
  id: number;
  kind: "confirm" | "prompt" | "choice";
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
  choices?: DialogChoice[];
  resolve: (v: boolean | string | null) => void;
}

const useConfirmStore = create<{ queue: ConfirmRequest[]; push(r: ConfirmRequest): void; pop(): void }>((set, get) => ({
  queue: [],
  push: (r) => set({ queue: [...get().queue, r] }),
  pop: () => set({ queue: get().queue.slice(1) }),
}));

let reqId = 1;

export function confirmDialog(opts: { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().push({ id: reqId++, kind: "confirm", ...opts, resolve: (v) => resolve(Boolean(v)) });
  });
}

export function promptDialog(opts: { title: string; message?: ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useConfirmStore.getState().push({ id: reqId++, kind: "prompt", ...opts, resolve: (v) => resolve(typeof v === "string" ? v : null) });
  });
}

/**
 * A question with more than two answers, which "this one or all of them" is.
 *
 * Resolves to the chosen `value`, or `null` if the dialog is dismissed —
 * dismissing is not one of the choices, so a caller cannot mistake it for one.
 */
export function choiceDialog(opts: { title: string; message?: ReactNode; choices: DialogChoice[]; cancelLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useConfirmStore.getState().push({ id: reqId++, kind: "choice", ...opts, resolve: (v) => resolve(typeof v === "string" ? v : null) });
  });
}

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.queue[0]);
  const pop = useConfirmStore((s) => s.pop);
  const [value, setValue] = useState("");
  useEffect(() => setValue(req?.defaultValue ?? ""), [req?.id, req?.defaultValue]);
  if (!req) return null;
  const done = (v: boolean | string | null) => {
    req.resolve(v);
    pop();
  };
  return (
    <Dialog
      open
      onClose={() => done(req.kind === "confirm" ? false : null)}
      title={req.title}
      size="sm"
      footer={
        req.kind === "choice" ? (
          <button className="btn" onClick={() => done(null)}>
            {req.cancelLabel ?? "Cancel"}
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => done(req.kind === "prompt" ? null : false)}>
              {req.cancelLabel ?? "Cancel"}
            </button>
            <button className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} onClick={() => done(req.kind === "prompt" ? value : true)}>
              {req.confirmLabel ?? (req.kind === "prompt" ? "OK" : "Confirm")}
            </button>
          </>
        )
      }
    >
      {req.message && <p style={{ marginTop: 0 }}>{req.message}</p>}
      {req.kind === "choice" && (
        <div className="dialog-choices">
          {req.choices?.map((c) => (
            <button key={c.value} className={`btn dialog-choice ${c.primary ? "btn-primary" : ""} ${c.danger ? "danger" : ""}`} onClick={() => done(c.value)}>
              <span>{c.label}</span>
              {c.hint && <small>{c.hint}</small>}
            </button>
          ))}
        </div>
      )}
      {req.kind === "prompt" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            done(value);
          }}
        >
          <input className="input" autoFocus value={value} placeholder={req.placeholder} onChange={(e) => setValue(e.target.value)} />
        </form>
      )}
    </Dialog>
  );
}
