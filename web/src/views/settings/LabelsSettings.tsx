import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSettings, type LabelVisibility } from "@/store/settings";
import { labelTree, descendantKeywords } from "@/lib/labelTree";
import { useMemo } from "react";
import { CALENDAR_COLORS, ColorSwatches } from "@/ui/misc";
import { promptDialog } from "@/ui/dialog";
import { t, tNode } from "@/lib/i18n";

export function LabelsSettings() {
  const labels = useSettings((s) => s.settings.labels);
  const update = useSettings((s) => s.update);
  const [editing, setEditing] = useState<string | null>(null);
  const roots = useMemo(() => labelTree(labels), [labels]);
  const descendantsOf = (keyword: string) => descendantKeywords(roots, keyword);

  const add = async () => {
    const name = await promptDialog({ title: t("New label"), placeholder: t("Label name") });
    if (!name?.trim()) return;
    const keyword = name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || `label${Date.now()}`;
    if (labels.some((l) => l.keyword === keyword)) return;
    update({ labels: [...labels, { keyword, name: name.trim(), color: CALENDAR_COLORS[labels.length % CALENDAR_COLORS.length]! }] });
  };

  return (
    <div>
      <h1>{t("Labels")}</h1>
      <p className="lead">{t("Labels are IMAP keywords stored on your messages, so every other client sees them. Names, colours and nesting are ihasmail\u2019s own and follow your account. Nesting is display only \u2014 it rewrites nothing in the mailbox.")}</p>
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
          <div className="field-row" style={{ marginTop: 10 }}>
            <div className="field">
              <label>{t("Nested under")}</label>
              <select
                className="select"
                value={l.parent ?? ""}
                onChange={(e) => update({ labels: labels.map((x) => (x.keyword === l.keyword ? { ...x, parent: e.target.value || undefined } : x)) })}
              >
                <option value="">{t("Nothing (top level)")}</option>
                {/* Itself and anything already beneath it are left out, so the
                    picker cannot be used to build a loop. */}
                {labels
                  .filter((c) => c.keyword !== l.keyword && !descendantsOf(l.keyword).has(c.keyword))
                  .map((c) => (
                    <option key={c.keyword} value={c.keyword}>{c.name}</option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label>{t("Show in the sidebar")}</label>
              <select
                className="select"
                value={l.visibility ?? "always"}
                onChange={(e) => update({ labels: labels.map((x) => (x.keyword === l.keyword ? { ...x, visibility: e.target.value as LabelVisibility } : x)) })}
              >
                <option value="always">{t("Always")}</option>
                <option value="unread">{t("Only when it has unread mail")}</option>
                <option value="hidden">{t("Never")}</option>
              </select>
            </div>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => void add()}><Plus size={16} />  {t("New label")}</button>
      <p className="hint mt-8">{tNode("Tip: press {key} on a conversation to apply labels. Search with {operator}.", { key: <kbd className="kbd">l</kbd>, operator: <code>label:name</code> })}</p>
    </div>
  );
}
