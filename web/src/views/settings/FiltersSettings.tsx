import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Code, GripVertical, Plus, Trash2, Wand2, Play, AlertTriangle, Power } from "lucide-react";
import { useSieve } from "@/store/sieve";
import { useMail } from "@/store/mail";
import { describeRule, newRule, reorderRules, rulesToSieve, upsertRule, type SieveRule } from "@/lib/sieve";
import { RuleDialog } from "./RuleDialog";
import { saveAndApply } from "../mail/FilterFromMessage";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { Switch, Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";
import type { SieveScript } from "@/jmap/types";

export function FiltersSettings() {
  const sieve = useSieve();
  const [tab, setTab] = useState<"rules" | "scripts">("rules");
  useEffect(() => {
    if (sieve.available && !sieve.scripts.length && !sieve.loading) void sieve.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sieve.available]);

  if (!sieve.available) {
    return (
      <div>
        <h1>Filters & rules</h1>
        <p className="lead">Sieve filtering is not available for this account.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Filters & rules</h1>
      <p className="lead">Sort incoming mail automatically. Rules run on the server (Sieve), so they work for every client you use.</p>
      <div className="view-switch" style={{ marginBottom: 16 }}>
        <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}><Wand2 size={15} /> Rules</button>
        <button className={tab === "scripts" ? "active" : ""} onClick={() => setTab("scripts")}><Code size={15} /> Scripts (advanced)</button>
      </div>
      {sieve.loading && !sieve.scripts.length ? <Spinner /> : tab === "rules" ? <RulesEditor /> : <ScriptsEditor />}
    </div>
  );
}

/** Private drag type, so a rule can only be dropped on the rule list. */
const RULE_MIME = "application/x-ihasmail-sieve-rule";

function RulesEditor() {
  const sieve = useSieve();
  const { script, rules, content, damage } = sieve.rules();
  const [local, setLocal] = useState<SieveRule[] | null>(null);
  const [editing, setEditing] = useState<SieveRule | null>(null);
  const [saving, setSaving] = useState(false);
  const list = local ?? rules ?? [];
  const dirty = local !== null;
  const inbox = useMail((s) => { const id = s.roleId("inbox"); return id ? s.mailboxes[id] : undefined; });
  /** The rule being dragged, the one armed to be, and where a drop would land. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; below: boolean } | null>(null);
  /**
   * The same id as `dragId`, kept synchronously: the first dragover can arrive
   * before React has re-rendered with the state, and a stale read there draws a
   * drop line on the card being dragged.
   */
  const dragging = useRef<string | null>(null);
  const endDrag = () => { dragging.current = null; setDragId(null); setArmed(null); setOver(null); };
  /** Which half of the card the pointer is over decides which side of it the rule lands. */
  const isBelow = (el: HTMLElement, y: number) => { const b = el.getBoundingClientRect(); return y > b.top + b.height / 2; };
  const activeIsOther = script && script.name !== "ihasmail" && script.isActive;

  const save = async (next: SieveRule[]) => {
    setSaving(true);
    try {
      await sieve.saveRules(next);
      setLocal(null);
      toast.success("Filters saved");
    } catch (err) {
      toast.error(`Could not save filters: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // Before the hand-written branch: a script that arrived in part is not a
  // script someone chose to write themselves, and the way out of it is a reload
  // rather than the "start with rules" button below, which would write over it.
  if (damage) {
    return (
      <div className="warn-box">
        <div className="row gap-8" style={{ marginBottom: 8 }}><AlertTriangle size={18} /> <b>Only part of your filter script arrived.</b></div>
        <p style={{ margin: "0 0 8px" }}>It {damage}, so the rules in it can't be shown or edited — saving what did arrive would write it back over the rest. Reload the page to try again. Your rules are still on the server; nothing here has changed them.</p>
        <button className="btn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }

  if (rules === null) {
    return (
      <div className="warn-box">
        <div className="row gap-8" style={{ marginBottom: 8 }}><AlertTriangle size={18} /> <b>Your active script “{script?.name}” was written by hand.</b></div>
        <p style={{ margin: "0 0 8px" }}>The visual rule editor only manages scripts it created. You can edit the script in the <b>Scripts</b> tab, or start fresh with rules (the existing script will be kept but deactivated).</p>
        <button className="btn" onClick={async () => { if (await confirmDialog({ title: "Switch to rules?", message: `“${script?.name}” will be deactivated (not deleted) and a new “ihasmail” script will take over.`, confirmLabel: "Continue" })) void save([]); }}>Start with rules</button>
      </div>
    );
  }

  return (
    <div>
      {activeIsOther && <div className="warn-box mb-16">Another script (“{script?.name}”) is active. Saving rules here will activate the “ihasmail” script instead.</div>}
      {list.length === 0 && <div className="empty" style={{ padding: 32 }}><Wand2 size={32} /><h3>No filters yet</h3><p>Create a rule to move newsletters to a folder, flag important senders, or forward mail.</p></div>}
      {list.map((r, i) => (
        <div
          key={r.id}
          className={`rule-card ${r.enabled ? "" : "disabled"} ${dragId === r.id ? "dragging" : ""} ${over?.id === r.id ? (over.below ? "drop-below" : "drop-above") : ""}`}
          draggable={armed === r.id}
          onDragStart={(e) => { e.dataTransfer.setData(RULE_MIME, r.id); e.dataTransfer.effectAllowed = "move"; dragging.current = r.id; setDragId(r.id); }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(RULE_MIME) || dragging.current === r.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const below = isBelow(e.currentTarget, e.clientY);
            if (over?.id !== r.id || over.below !== below) setOver({ id: r.id, below });
          }}
          onDragLeave={() => setOver((o) => (o?.id === r.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            const from = e.dataTransfer.getData(RULE_MIME);
            if (from) setLocal(reorderRules(list, from, r.id, isBelow(e.currentTarget, e.clientY)));
            endDrag();
          }}
        >
          <div className="row">
            <span
              className="drag-handle"
              title="Drag to reorder"
              aria-hidden="true"
              onPointerDown={() => setArmed(r.id)}
              onPointerUp={() => setArmed(null)}
            ><GripVertical size={16} /></span>
            <Switch checked={r.enabled} onChange={(v) => setLocal(list.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} />
            <div className="grow" style={{ cursor: "pointer", minWidth: 0 }} onClick={() => setEditing(r)}>
              <div style={{ fontWeight: 600 }}>{r.name}</div>
              <div className="hint truncate">{describeRule(r)}</div>
            </div>
            <button className="icon-btn sm" disabled={i === 0} aria-label="Move up" onClick={() => { const n = [...list]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setLocal(n); }}><ArrowUp size={16} /></button>
            <button className="icon-btn sm" disabled={i === list.length - 1} aria-label="Move down" onClick={() => { const n = [...list]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; setLocal(n); }}><ArrowDown size={16} /></button>
            <button className="icon-btn sm danger" aria-label="Delete rule" onClick={() => setLocal(list.filter((x) => x.id !== r.id))}><Trash2 size={16} /></button>
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => setEditing(newRule())}><Plus size={16} /> New rule</button>
        <span className="spacer" />
        {dirty && <button className="btn btn-ghost" onClick={() => setLocal(null)}>Discard changes</button>}
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save(list)}>{saving ? "Saving…" : "Save filters"}</button>
      </div>
      {content && (
        <details style={{ marginTop: 20 }}>
          <summary className="hint" style={{ cursor: "pointer" }}>Preview generated Sieve script</summary>
          <pre className="code" style={{ minHeight: 120, marginTop: 8 }}>{rulesToSieve(list)}</pre>
        </details>
      )}
      {editing && (
        <RuleDialog
          rule={editing}
          onClose={() => setEditing(null)}
          applyMailbox={inbox ? { id: inbox.id, name: inbox.name } : null}
          onSave={(r, applyNow) => {
            setEditing(null);
            if (applyNow && inbox) {
              // Save immediately so the rule is live, then apply it to the Inbox.
              // saveAndApply takes the list as it stands now: an edited rule keeps its place.
              setLocal(null);
              void saveAndApply(r, list, inbox.id);
            } else setLocal(upsertRule(list, r));
          }}
        />
      )}
    </div>
  );
}

function ScriptsEditor() {
  const sieve = useSieve();
  const [sel, setSel] = useState<SieveScript | null>(null);
  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  const open = async (s: SieveScript | null) => {
    setSel(s);
    setValidation(null);
    if (s) {
      setName(s.name);
      setContent(await sieve.getContent(s.id));
    } else {
      setName("");
      setContent('require ["fileinto"];\n\n');
    }
  };

  const save = async (activate: boolean) => {
    if (!name.trim()) {
      toast.error("Script name is required");
      return;
    }
    setBusy(true);
    try {
      const err = await sieve.validate(content);
      setValidation(err);
      if (err) {
        toast.error("Script has errors");
        return;
      }
      await sieve.saveScript(sel?.id ?? null, name.trim(), content, activate);
      toast.success("Script saved");
      setSel(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sel !== null || name !== "" || content !== "") {
    if (sel !== null || name !== "" || content !== "") {
      return (
        <div>
          <div className="field"><label>Script name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(sel)} /></div>
          <div className="field">
            <label>Sieve source</label>
            <textarea className="code" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} style={{ minHeight: 320 }} />
          </div>
          {validation && <div className="error-box mb-16">{validation}</div>}
          <div className="row">
            <button className="btn btn-ghost" onClick={() => { setSel(null); setName(""); setContent(""); }}>Cancel</button>
            <button className="btn" disabled={busy} onClick={async () => { setBusy(true); const err = await sieve.validate(content); setValidation(err); setBusy(false); if (!err) toast.success("Script is valid"); }}><Play size={14} /> Validate</button>
            <span className="spacer" />
            <button className="btn" disabled={busy} onClick={() => void save(false)}>Save</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>Save & activate</button>
          </div>
        </div>
      );
    }
  }

  return (
    <div>
      <p className="hint">Advanced: manage raw Sieve scripts. Only one script can be active at a time.</p>
      {sieve.scripts.map((s) => (
        <div key={s.id} className="card">
          <div className="card-head">
            <h3>{s.name} {s.isActive && <span className="tag" style={{ background: "var(--success)" }}>active</span>}</h3>
            <button className="btn btn-sm" onClick={() => void open(s)}>Edit</button>
            <button className="btn btn-sm" onClick={async () => { try { await sieve.activate(s.isActive ? null : s.id); } catch (err) { toast.error((err as Error).message); } }}><Power size={14} /> {s.isActive ? "Deactivate" : "Activate"}</button>
            <button className="icon-btn sm danger" aria-label="Delete script" onClick={async () => { if (await confirmDialog({ title: `Delete script “${s.name}”?`, confirmLabel: "Delete", danger: true })) { try { await sieve.destroy(s.id); } catch (err) { toast.error((err as Error).message); } } }}><Trash2 size={16} /></button>
          </div>
        </div>
      ))}
      <button className="btn" onClick={async () => { const n = await promptDialog({ title: "New script", placeholder: "Script name" }); if (n) { setName(n); setContent('require ["fileinto"];\n\n'); } }}><Plus size={16} /> New script</button>
    </div>
  );
}
