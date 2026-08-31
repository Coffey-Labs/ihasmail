import { useMemo } from "react";
import { keyboard } from "@/lib/keyboard";
import { Kbd } from "@/ui/misc";
import { t, tNode } from "@/lib/i18n";

export function ShortcutsSettings() {
  const list = useMemo(() => keyboard.list(), []);
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
    <div>
      <h1>{t("Keyboard shortcuts")}</h1>
      <p className="lead">{tNode("Gmail-style shortcuts are always on. Press {key} anywhere to see this list.", { key: <kbd className="kbd">?</kbd> })}</p>
      <div className="shortcut-grid">
        {groups.map(([group, items]) => (
          <div key={group}>
            <h3>{group}</h3>
            {items.map((b) => (
              <div key={b.keys} className="shortcut-row"><span>{b.description}</span><Kbd keys={b.keys} /></div>
            ))}
          </div>
        ))}
        {!groups.length && <p className="hint">{t("Open the Mail view to see all shortcuts.")}</p>}
      </div>
    </div>
  );
}
