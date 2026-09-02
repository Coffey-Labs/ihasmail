import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { keyboard } from "@/lib/keyboard";
import { useMail } from "@/store/mail";
import { useCompose } from "@/store/compose";
import { Dialog } from "@/ui/dialog";
import { Kbd } from "@/ui/misc";
import { t } from "@/lib/i18n";

export function useGlobalShortcuts({ onHelp, onGoToFolder }: { onHelp: () => void; onGoToFolder: () => void }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    const go = (role: string) => () => {
      const id = useMail.getState().roleId(role as never);
      if (id) navigate(`/mail/${id}`);
    };
    return keyboard.pushScope("global", [
      { keys: "c", description: "Compose new message", group: "Mail", handler: () => void useCompose.getState().open() },
      { keys: "?", description: "Show keyboard shortcuts", group: "Navigation", handler: onHelp },
      { keys: "g i", description: "Go to Inbox", group: "Navigation", handler: go("inbox") },
      /*
       * A folder by name, for a tree the other `g` shortcuts cannot reach. The
       * ones below are the handful of folders every account has; this is for
       * the dozens that Sieve fills and that have no letter of their own (#233).
       *
       * `o` on its own opens a conversation, which is not a clash: the manager
       * completes a pending sequence before it tries a single key.
       */
      { keys: "g o", description: "Go to folder…", group: "Navigation", handler: onGoToFolder },
      { keys: "g s", description: "Go to Starred", group: "Navigation", handler: () => navigate("/search?q=is:starred") },
      { keys: "g t", description: "Go to Sent", group: "Navigation", handler: go("sent") },
      { keys: "g d", description: "Go to Drafts", group: "Navigation", handler: go("drafts") },
      { keys: "g a", description: "Go to All mail / Archive", group: "Navigation", handler: () => { const id = useMail.getState().roleId("all") ?? useMail.getState().roleId("archive"); if (id) navigate(`/mail/${id}`); } },
      { keys: "g l", description: "Go to Calendar", group: "Navigation", handler: () => navigate("/calendar") },
      { keys: "g c", description: "Go to Contacts", group: "Navigation", handler: () => navigate("/contacts") },
      { keys: "g f", description: "Go to Files", group: "Navigation", handler: () => navigate("/files") },
      { keys: "g k", description: "Go to Settings", group: "Navigation", handler: () => navigate("/settings") },
    ]);
  }, [navigate, onHelp, onGoToFolder]);
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useMemo(() => (open ? keyboard.list() : []), [open]);
  const groups = useMemo(() => {
    const g = new Map<string, typeof list>();
    for (const b of list) {
      const arr = g.get(b.group) ?? [];
      arr.push(b);
      g.set(b.group, arr);
    }
    return [...g.entries()];
  }, [list]);
  return (
    <Dialog open={open} onClose={onClose} title={t("Keyboard shortcuts")} size="lg">
      <div className="shortcut-grid">
        {groups.map(([group, items]) => (
          <div key={group}>
            <h3>{group}</h3>
            {items.map((b) => (
              <div key={b.keys} className="shortcut-row">
                <span>{b.description}</span>
                <Kbd keys={b.keys} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
