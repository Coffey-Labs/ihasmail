import { create } from "zustand";
import { X } from "lucide-react";
import { t as translate } from "@/lib/i18n";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
  action?: { label: string; onClick: () => void | Promise<void> };
  duration: number;
  progress?: boolean;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, "id">): number;
  dismiss(id: number): void;
}

let counter = 1;
const timers = new Map<number, number>();

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = counter++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (t.duration > 0) {
      const timer = window.setTimeout(() => get().dismiss(id), t.duration);
      timers.set(id, timer);
    }
    return id;
  },
  dismiss(id) {
    const t = timers.get(id);
    if (t) window.clearTimeout(t);
    timers.delete(id);
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));

export const toast = {
  show(message: string, opts: { action?: Toast["action"]; duration?: number; kind?: Toast["kind"]; progress?: boolean } = {}): number {
    return useToasts.getState().push({ message, kind: opts.kind ?? "info", action: opts.action, duration: opts.duration ?? (opts.action ? 7000 : 4000), progress: opts.progress });
  },
  success(message: string, opts: { action?: Toast["action"]; duration?: number } = {}): number {
    return toast.show(message, { ...opts, kind: "success" });
  },
  error(message: string, opts: { action?: Toast["action"]; duration?: number } = {}): number {
    return toast.show(message, { ...opts, kind: "error", duration: opts.duration ?? 8000 });
  },
  dismiss(id: number) {
    useToasts.getState().dismiss(id);
  },
};

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                void t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" aria-label={translate("Dismiss")} onClick={() => dismiss(t.id)}>
            <X size={16} />
          </button>
          {t.progress && t.duration > 0 && <span className="toast-progress" style={{ animationDuration: `${t.duration}ms` }} />}
        </div>
      ))}
    </div>
  );
}
