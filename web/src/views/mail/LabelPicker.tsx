import { useState } from "react";
import { Plus } from "lucide-react";
import { useSettings } from "@/store/settings";
import { useMail } from "@/store/mail";
import { Popover } from "@/ui/popover";
import type { Id } from "@/jmap/types";
import { CALENDAR_COLORS } from "@/ui/misc";
import { t } from "@/lib/i18n";

/** Labels are IMAP keywords on the messages; their names/colors live in settings. */
export function LabelPicker({ ids, anchor, onClose, onApplied }: { ids: Id[]; anchor: { x: number; y: number }; onClose: () => void; onApplied?: () => void }) {
  const labels = useSettings((s) => s.settings.labels);
  const update = useSettings((s) => s.update);
  const emails = useMail((s) => s.emails);
  const setKeyword = useMail((s) => s.setKeyword);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const has = (kw: string) => ids.every((id) => emails[id]?.keywords[kw]);
  const some = (kw: string) => ids.some((id) => emails[id]?.keywords[kw]);
  const filtered = labels.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()));

  const create = () => {
    const name = q.trim();
    if (!name) return;
    const keyword = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || `label${Date.now()}`;
    if (labels.some((l) => l.keyword === keyword)) return;
    const color = CALENDAR_COLORS[labels.length % CALENDAR_COLORS.length]!;
    update({ labels: [...labels, { keyword, name, color }] });
    void setKeyword(ids, keyword, true).then(onApplied);
    setQ("");
    setCreating(false);
  };

  return (
    <Popover anchor={{ x: anchor.x, y: anchor.y, w: 0, h: 0 }} onClose={onClose} width={260} closeOnClick={false}>
      <div className="menu-title">{t("Label as")}</div>
      <div className="menu-search">
        <input
          className="input sm"
          autoFocus
          placeholder={labels.length ? t("Search or create label") : t("New label name")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length === 1 && !creating) {
                const l = filtered[0]!;
                void setKeyword(ids, l.keyword, !has(l.keyword)).then(onApplied);
              } else create();
            }
          }}
        />
      </div>
      {filtered.map((l) => {
        const all = has(l.keyword);
        const partial = !all && some(l.keyword);
        return (
          <label key={l.keyword} className="menu-item" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={all}
              ref={(el) => {
                if (el) el.indeterminate = partial;
              }}
              onChange={(e) => void setKeyword(ids, l.keyword, e.target.checked).then(onApplied)}
              style={{ accentColor: l.color }}
            />
            <span className="label-dot" style={{ background: l.color }} />
            <span className="grow truncate">{l.name}</span>
          </label>
        );
      })}
      {q.trim() && !labels.some((l) => l.name.toLowerCase() === q.trim().toLowerCase()) && (
        <button className="menu-item" onClick={create}>
          <Plus size={16} />
          <span>{t("Create “{name}”", { name: q.trim() })}</span>
        </button>
      )}
      {!labels.length && !q && <div className="hint" style={{ padding: "4px 10px 8px" }}>{t("Type a name to create your first label.")}</div>}
    </Popover>
  );
}
