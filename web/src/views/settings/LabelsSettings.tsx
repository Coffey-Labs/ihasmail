import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSettings } from "@/store/settings";
import { CALENDAR_COLORS, ColorSwatches } from "@/ui/misc";
import { promptDialog } from "@/ui/dialog";
import { t, tNode } from "@/lib/i18n";

export function LabelsSettings() {
  const labels = useSettings((s) => s.settings.labels);
  const update = useSettings((s) => s.update);
  const [editing, setEditing] = useState<string | null>(null);

  const add = async () => {
    const name = await promptDialog({ title: "New label", placeholder: "Label name" });
    if (!name?.trim()) return;
    const keyword = name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || `label${Date.now()}`;
    if (labels.some((l) => l.keyword === keyword)) return;
    update({ labels: [...labels, { keyword, name: name.trim(), color: CALENDAR_COLORS[labels.length % CALENDAR_COLORS.length]! }] });
  };

  return (
    <div>
      <h1>{t("Labels")}</h1>
      <p className="lead">{t("Labels are IMAP keywords stored on your messages, so they sync to other clients. Names and colours are kept in this browser.")}</p>
      {labels.map((l) => (
        <div key={l.keyword} className="card">
          <div className="card-head">
            <span className="label-dot" style={{ background: l.color, width: 14, height: 14 }} />
            {editing === l.keyword ? (
              <input className="input sm" autoFocus defaultValue={l.name} onBlur={(e) => { update({ labels: labels.map((x) => (x.keyword === l.keyword ? { ...x, name: e.target.value || x.name } : x)) }); setEditing(null); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} style={{ width: 240 }} />
            ) : (
              <h3 style={{ cursor: "text" }} onClick={() => setEditing(l.keyword)}>{l.name} <span className="hint" style={{ fontWeight: 400 }}>({l.keyword})</span></h3>
            )}
            <button className="icon-btn sm danger" aria-label={t("Delete label")} onClick={() => update({ labels: labels.filter((x) => x.keyword !== l.keyword) })}><Trash2 size={16} /></button>
          </div>
          <div style={{ marginTop: 8 }}>
            <ColorSwatches value={l.color} onChange={(c) => update({ labels: labels.map((x) => (x.keyword === l.keyword ? { ...x, color: c } : x)) })} />
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => void add()}><Plus size={16} />  {t("New label")}</button>
      <p className="hint mt-8">{tNode("Tip: press {key} on a conversation to apply labels. Search with {operator}.", { key: <kbd className="kbd">l</kbd>, operator: <code>label:name</code> })}</p>
    </div>
  );
}
