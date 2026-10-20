import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSettings, type Template } from "@/store/settings";
import { Dialog } from "@/ui/dialog";
import { RichEditor } from "../compose/RichEditor";
import { RecipientInput } from "../compose/RecipientInput";
import { formatAddress } from "@/lib/address";
import { htmlToText } from "@/lib/text/text";
import { t as translate } from "@/lib/i18n";
import { PLACEHOLDER_NAMES } from "@/lib/templatePlaceholders";

export function TemplatesSettings() {
  const templates = useSettings((s) => s.settings.templates);
  const update = useSettings((s) => s.update);
  const [editing, setEditing] = useState<Template | null>(null);
  return (
    <div>
      <h1>{translate("Templates")}</h1>
      <p className="lead">{translate("Canned responses you can insert into any message from the composer's template button.")}</p>
      {templates.map((t) => (
        <div key={t.id} className="card clickable" onClick={() => setEditing(t)}>
          <div className="card-head">
            <h3>{t.name}</h3>
            <button className="icon-btn sm danger" aria-label={translate("Delete template")} onClick={(e) => { e.stopPropagation(); update({ templates: templates.filter((x) => x.id !== t.id) }); }}><Trash2 size={16} /></button>
          </div>
          {t.subject && <div className="hint">{translate("Subject: {subject}", { subject: t.subject })}</div>}
          {recipientCount(t) > 0 && <div className="hint truncate">{translate("Adds: {recipients}", { recipients: [...(t.to ?? []), ...(t.cc ?? []), ...(t.bcc ?? [])].map(formatAddress).join(", ") })}</div>}
          <div className="hint truncate">{htmlToText(t.html).slice(0, 140)}</div>
        </div>
      ))}
      <button className="btn" onClick={() => setEditing({ id: `t${Date.now()}`, name: "", subject: "", html: "" })}><Plus size={16} />  {translate("New template")}</button>
      {editing && (
        <Dialog open onClose={() => setEditing(null)} title={templates.some((t) => t.id === editing.id) ? translate("Edit template") : translate("New template")} size="lg" footer={<><button className="btn" onClick={() => setEditing(null)}>{translate("Cancel")}</button><button className="btn btn-primary" disabled={!editing.name.trim()} onClick={() => { const exists = templates.some((t) => t.id === editing.id); update({ templates: exists ? templates.map((t) => (t.id === editing.id ? editing : t)) : [...templates, editing] }); setEditing(null); }}>{translate("Save")}</button></>}>
          <div className="field-row">
            <div className="field"><label>{translate("Name")}</label><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus /></div>
            <div className="field"><label>{translate("Subject (optional)")}</label><input className="input" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></div>
          </div>
          <div className="field">
            <label htmlFor="template-to">{translate("To (optional)")}</label>
            <RecipientInput id="template-to" value={editing.to ?? []} onChange={(to) => setEditing({ ...editing, to })} exclude={[...(editing.cc ?? []), ...(editing.bcc ?? [])]} />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="template-cc">{translate("Cc (optional)")}</label>
              <RecipientInput id="template-cc" value={editing.cc ?? []} onChange={(cc) => setEditing({ ...editing, cc })} exclude={[...(editing.to ?? []), ...(editing.bcc ?? [])]} />
            </div>
            <div className="field">
              <label htmlFor="template-bcc">{translate("Bcc (optional)")}</label>
              <RecipientInput id="template-bcc" value={editing.bcc ?? []} onChange={(bcc) => setEditing({ ...editing, bcc })} exclude={[...(editing.to ?? []), ...(editing.cc ?? [])]} />
            </div>
          </div>
          <p className="hint">{translate("Added to the message when you insert the template, beside anyone already on it.")}</p>
          <div className="field">
            <label>{translate("Body")}</label>
            <div style={{ border: "1px solid var(--border-strong)", borderRadius: 8, minHeight: 200, display: "flex", flexDirection: "column" }}>
              <RichEditor html={editing.html} onChange={(html) => setEditing({ ...editing, html })} showToolbar placeholder={translate("Template text…")} />
            </div>
          </div>
          <PlaceholderReference />
        </Dialog>
      )}
    </div>
  );
}

function recipientCount(t: Template): number {
  return (t.to?.length ?? 0) + (t.cc?.length ?? 0) + (t.bcc?.length ?? 0);
}

/**
 * What each placeholder answers, shown under the body so the names are
 * discoverable without documentation. Rendered from `PLACEHOLDER_NAMES` rather
 * than from this map, so a name added to the lib and forgotten here appears
 * with no description instead of quietly not appearing at all.
 */
function placeholderHint(name: string): string {
  switch (name) {
    case "recipientName": return translate("Who the message is addressed to");
    case "recipientFirstName": return translate("Their first name alone");
    case "recipientEmail": return translate("Their address");
    case "myName": return translate("The name on the identity you are sending as");
    case "myEmail": return translate("That identity's address");
    case "subject": return translate("The subject already on the message");
    case "date": return translate("Today, in your date format");
    case "time": return translate("Now, on your clock");
    default: return "";
  }
}

function PlaceholderReference() {
  return (
    <div className="field">
      <label>{translate("Placeholders")}</label>
      <div className="placeholder-list">
        {PLACEHOLDER_NAMES.map((name) => (
          <div key={name} className="placeholder-row">
            <code>{`{{${name}}}`}</code>
            <span className="hint">{placeholderHint(name)}</span>
          </div>
        ))}
      </div>
      <p className="hint">
        {translate("Filled in when the template is inserted, so you can edit the result before sending. One that cannot be answered yet — a recipient's name on a message you have not addressed — is left in the body as written, rather than becoming a blank.")}
      </p>
    </div>
  );
}
