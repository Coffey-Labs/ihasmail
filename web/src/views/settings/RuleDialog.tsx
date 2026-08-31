import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useMail } from "@/store/mail";
import { HEADER_CHOICES, HEADER_OPS, type SieveAction, type SieveRule, type SieveTest } from "@/lib/sieve";
import { Dialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import type { Id } from "@/jmap/types";
import { t as translate } from "@/lib/i18n";

export interface RuleDialogProps {
  rule: SieveRule;
  onClose: () => void;
  /** Called with the rule and whether the user asked to apply it to existing messages now. */
  onSave: (r: SieveRule, applyNow: boolean) => void;
  /** When set, offers "Also apply to existing messages in <folder>". */
  applyMailbox?: { id: Id; name: string } | null;
  /** Ticks that offer by default. Off unless applying is the point of the dialog. */
  applyByDefault?: boolean;
  title?: string;
  saveLabel?: string;
}

export function RuleDialog({ rule, onClose, onSave, applyMailbox, applyByDefault, title, saveLabel }: RuleDialogProps) {
  const [r, setR] = useState<SieveRule>(rule);
  const [applyNow, setApplyNow] = useState(Boolean(applyMailbox && applyByDefault));
  const mailboxes = useMail((s) => s.mailboxes);
  const mailboxPath = useMail((s) => s.mailboxPath);
  const folders = useMemo(() => Object.values(mailboxes).map((m) => ({ id: m.id, path: mailboxPath(m.id) })).sort((a, b) => a.path.localeCompare(b.path)), [mailboxes, mailboxPath]);
  const setTest = (i: number, t: SieveTest) => setR({ ...r, tests: r.tests.map((x, j) => (j === i ? t : x)) });
  const setAction = (i: number, a: SieveAction) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) });

  return (
    <Dialog open onClose={onClose} title={title ?? (rule.name === "New filter" ? translate("New rule") : translate("Edit rule"))} size="lg" footer={<>
      {applyMailbox && (
        <label className="check left" style={{ marginRight: "auto" }}>
          <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} />
          <span>{translate("Also apply to existing messages in")} <b>{applyMailbox.name}</b></span>
        </label>
      )}
      <button className="btn" onClick={onClose}>{translate("Cancel")}</button><button className="btn btn-primary" onClick={() => onSave(r, applyNow && Boolean(applyMailbox))} disabled={!r.name.trim()}>{saveLabel ?? "Done"}</button></>}>
      <div className="field"><label>{translate("Rule name")}</label><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} autoFocus /></div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="label">{translate("When")}</span>
        <select className="select" style={{ width: "auto" }} value={r.join} onChange={(e) => setR({ ...r, join: e.target.value as "allof" | "anyof" })}>
          <option value="allof">{translate("all of the following match")}</option>
          <option value="anyof">{translate("any of the following match")}</option>
        </select>
      </div>
      {r.tests.map((t, i) => {
        // A header the dropdown doesn't list needs a box to type its name in,
        // which takes a column of its own — the comparator keeps its.
        const customHeader = t.type === "header" && !HEADER_CHOICES.some((h) => h.value === t.header && h.value !== "__custom__");
        return (
          <div key={i} className={`rule-row${customHeader ? " named-header" : ""}`}>
            <select className="select" value={t.type === "true" ? "true" : t.type === "size" ? "size" : t.type === "body" ? "body" : t.type === "address" ? "address" : HEADER_CHOICES.some((h) => h.value === t.header) ? t.header : "__custom__"} onChange={(e) => {
              const v = e.target.value;
              if (v === "size") setTest(i, { type: "size", op: "over", value: 1024 * 1024 });
              else if (v === "body") setTest(i, { type: "body", op: "contains", value: "" });
              else if (v === "true") setTest(i, { type: "true" });
              else if (v === "address") setTest(i, { type: "address", header: "from", part: "domain", op: "is", value: "" });
              else setTest(i, { type: "header", header: v === "__custom__" ? "" : v, op: "contains", value: "" });
            }}>
              {HEADER_CHOICES.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              <option value="address">{translate("Sender domain")}</option>
              <option value="size">{translate("Message size")}</option>
              <option value="body">{translate("Body text")}</option>
              <option value="true">{translate("Always (all messages)")}</option>
            </select>
            {customHeader && t.type === "header" && (
              <input className="input" placeholder={translate("Header name")} aria-label={translate("Header name")} value={t.header} onChange={(e) => setTest(i, { ...t, header: e.target.value })} />
            )}
            {t.type === "size" ? (
              <select className="select" value={t.op} onChange={(e) => setTest(i, { ...t, op: e.target.value as "over" | "under" })}><option value="over">{translate("is larger than")}</option><option value="under">{translate("is smaller than")}</option></select>
            ) : t.type === "body" ? (
              <select className="select" value={t.op} onChange={(e) => setTest(i, { ...t, op: e.target.value as "contains" | "notcontains" })}><option value="contains">{translate("contains")}</option><option value="notcontains">{translate("does not contain")}</option></select>
            ) : t.type === "true" ? <span /> : (
              <select className="select" value={t.op} onChange={(e) => setTest(i, { ...t, op: e.target.value as SieveTest extends { op: infer O } ? O : never })}>
                {HEADER_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {t.type === "size" ? (
              <div className="row"><input className="input" type="number" min={1} value={Math.round(t.value / 1024)} onChange={(e) => setTest(i, { ...t, value: Number(e.target.value) * 1024 })} /><span className="muted">{translate("KB")}</span></div>
            ) : t.type === "true" ? <span /> : t.type === "header" && (t.op === "exists" || t.op === "notexists") ? <span /> : (
              <input className="input" placeholder={t.type === "address" ? "example.com" : "value"} value={(t as { value: string }).value} onChange={(e) => setTest(i, { ...t, value: e.target.value } as SieveTest)} />
            )}
            <button className="icon-btn sm danger" aria-label={translate("Remove condition")} onClick={() => setR({ ...r, tests: r.tests.filter((_, j) => j !== i) })} disabled={r.tests.length <= 1}><Trash2 size={16} /></button>
          </div>
        );
      })}
      <button className="btn btn-ghost btn-sm" onClick={() => setR({ ...r, tests: [...r.tests, { type: "header", header: "subject", op: "contains", value: "" }] })}><Plus size={14} />  {translate("Add condition")}</button>

      <div className="row" style={{ margin: "16px 0 8px" }}><span className="label">{translate("Then")}</span></div>
      {r.actions.map((a, i) => (
        <div key={i} className="rule-row actions">
          <select className="select" value={a.type} onChange={(e) => {
            const v = e.target.value as SieveAction["type"];
            const next: SieveAction = v === "fileinto" ? { type: "fileinto", mailbox: folders[0]?.path ?? "INBOX" } : v === "redirect" ? { type: "redirect", address: "" } : v === "reject" ? { type: "reject", reason: "" } : v === "addflag" ? { type: "addflag", flag: "" } : ({ type: v } as SieveAction);
            setAction(i, next);
          }}>
            <option value="fileinto">{translate("Move to folder")}</option>
            <option value="markread">{translate("Mark as read")}</option>
            <option value="flag">{translate("Star")}</option>
            <option value="addflag">{translate("Add label / keyword")}</option>
            <option value="redirect">{translate("Forward to")}</option>
            <option value="keep">{translate("Keep in Inbox")}</option>
            <option value="discard">{translate("Delete")}</option>
            <option value="reject">{translate("Reject with message")}</option>
            <option value="stop">{translate("Stop processing more rules")}</option>
          </select>
          {a.type === "fileinto" ? (
            <div className="row">
              <select
                className="select"
                value={a.mailbox}
                onChange={async (e) => {
                  const v = e.target.value;
                  if (v === "__new__") {
                    // Create a folder on the fly ("Parent/Child" creates nested folders).
                    const name = await promptDialog({ title: translate("New folder"), placeholder: translate("Folder name (use / for a subfolder, e.g. Work/Invoices)") });
                    if (!name?.trim()) return;
                    try {
                      const mail = useMail.getState();
                      const parts = name.split("/").map((x) => x.trim()).filter(Boolean);
                      let parentId: string | null = null;
                      for (const part of parts) {
                        const existing = Object.values(useMail.getState().mailboxes).find((m) => (m.parentId ?? null) === parentId && m.name.toLowerCase() === part.toLowerCase());
                        parentId = existing ? existing.id : await mail.createMailbox(part, parentId);
                      }
                      const path = useMail.getState().mailboxPath(parentId!);
                      setAction(i, { ...a, mailbox: path, mailboxId: parentId! });
                      toast.success(translate("Folder “{name}” created", { name: path }));
                    } catch (err) {
                      toast.error((err as Error).message);
                    }
                    return;
                  }
                  setAction(i, { ...a, mailbox: v, mailboxId: folders.find((f) => f.path === v)?.id });
                }}
              >
                {folders.map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
                {!folders.some((f) => f.path === a.mailbox) && <option value={a.mailbox}>{a.mailbox}</option>}
                <option value="__new__">{translate("＋ New folder…")}</option>
              </select>
              <label className="check nowrap"><input type="checkbox" checked={Boolean(a.copy)} onChange={(e) => setAction(i, { ...a, copy: e.target.checked })} />  {translate("keep copy")}</label>
            </div>
          ) : a.type === "redirect" ? (
            <div className="row">
              <input className="input" type="email" placeholder={translate("someone@example.com")} value={a.address} onChange={(e) => setAction(i, { ...a, address: e.target.value })} />
              <label className="check nowrap"><input type="checkbox" checked={Boolean(a.copy)} onChange={(e) => setAction(i, { ...a, copy: e.target.checked })} />  {translate("keep copy")}</label>
            </div>
          ) : a.type === "reject" ? (
            <input className="input" placeholder={translate("Reason")} value={a.reason} onChange={(e) => setAction(i, { ...a, reason: e.target.value })} />
          ) : a.type === "addflag" || a.type === "setflag" || a.type === "removeflag" ? (
            <input className="input" placeholder={translate("keyword (e.g. $important, work)")} value={a.flag} onChange={(e) => setAction(i, { ...a, flag: e.target.value })} />
          ) : <span />}
          <button className="icon-btn sm danger" aria-label={translate("Remove action")} onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })} disabled={r.actions.length <= 1}><Trash2 size={16} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => setR({ ...r, actions: [...r.actions, { type: "stop" }] })}><Plus size={14} />  {translate("Add action")}</button>
    </Dialog>
  );
}

