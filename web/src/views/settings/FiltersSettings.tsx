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
import { t, tNode } from "@/lib/i18n";
import { confirmLeaveUnsaved, useUnsavedChanges } from "@/lib/unsavedChanges";

export function FiltersSettings() {
  const sieve = useSieve();
  const [tab, setTab] = useState<"rules" | "scripts">("rules");
  /*
   * Switching tabs unmounts the editor you were in, which is a way of losing
   * work that never leaves the page and so never reaches the router's guard.
   * Ask here for the same reason navigation asks.
   */
  const switchTab = (next: "rules" | "scripts") => {
    if (next === tab) return;
    void confirmLeaveUnsaved().then((ok) => {
      if (ok) setTab(next);
    });
  };
  useEffect(() => {
    if (sieve.available && !sieve.scripts.length && !sieve.loading) void sieve.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sieve.available]);

  if (!sieve.available) {
    return (
      <div>
        <h1>{t("Filters & rules")}</h1>
        <p className="lead">{t("Sieve filtering is not available for this account.")}</p>
      </div>
    );
  }

  return (
    <div>
      <h1>{t("Filters & rules")}</h1>
      <p className="lead">{t("Sort incoming mail automatically. Rules run on the server (Sieve), so they work for every client you use.")}</p>
      <div className="view-switch" style={{ marginBottom: 16 }}>
        <button className={tab === "rules" ? "active" : ""} onClick={() => switchTab("rules")}><Wand2 size={15} />  {t("Rules")}</button>
        <button className={tab === "scripts" ? "active" : ""} onClick={() => switchTab("scripts")}><Code size={15} />  {t("Scripts (advanced)")}</button>
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

  const save = async (next: SieveRule[]): Promise<boolean> => {
    setSaving(true);
    try {
      await sieve.saveRules(next);
      setLocal(null);
      toast.success(t("Filters saved"));
      return true;
    } catch (err) {
      toast.error(t("Could not save filters: {error}", { error: (err as Error).message }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Before the early returns below: a hook cannot be skipped, and the branches
  // they guard have nothing pending anyway.
  useUnsavedChanges({
    dirty,
    message: t("Your filter rules have changes that have not been saved."),
    save: () => save(list),
    discard: () => setLocal(null),
  });

  // Before the hand-written branch: a script that arrived in part is not a
  // script someone chose to write themselves, and the way out of it is a reload
  // rather than the "start with rules" button below, which would write over it.
  if (damage) {
    return (
      <div className="warn-box">
        <div className="row gap-8" style={{ marginBottom: 8 }}><AlertTriangle size={18} /> <b>{t("Only part of your filter script arrived.")}</b></div>
        <p style={{ margin: "0 0 8px" }}>{t("It {damage}, so the rules in it can't be shown or edited — saving what did arrive would write it back over the rest. Reload the page to try again. Your rules are still on the server; nothing here has changed them.", { damage })}</p>
        <button className="btn" onClick={() => window.location.reload()}>{t("Reload")}</button>
      </div>
    );
  }

  if (rules === null) {
    return (
      <div className="warn-box">
        <div className="row gap-8" style={{ marginBottom: 8 }}><AlertTriangle size={18} /> <b>{t("Your active script “{name}” was written by hand.", { name: script?.name ?? "" })}</b></div>
        <p style={{ margin: "0 0 8px" }}>{tNode("The visual rule editor only manages scripts it created. You can edit the script in the {tab} tab, or start fresh with rules (the existing script will be kept but deactivated).", { tab: <b>{t("Scripts")}</b> })}</p>
        <button className="btn" onClick={async () => { if (await confirmDialog({ title: t("Switch to rules?"), message: t("“{name}” will be deactivated (not deleted) and a new “ihasmail” script will take over.", { name: script?.name ?? "" }), confirmLabel: t("Continue") })) void save([]); }}>{t("Start with rules")}</button>
      </div>
    );
  }

  return (
    <div>
      {activeIsOther && <div className="warn-box mb-16">{t("Another script (“{name}”) is active. Saving rules here will activate the “ihasmail” script instead.", { name: script?.name ?? "" })}</div>}
      {list.length === 0 && <div className="empty" style={{ padding: 32 }}><Wand2 size={32} /><h3>{t("No filters yet")}</h3><p>{t("Create a rule to move newsletters to a folder, flag important senders, or forward mail.")}</p></div>}
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
              title={t("Drag to reorder")}
              aria-hidden="true"
              onPointerDown={() => setArmed(r.id)}
              onPointerUp={() => setArmed(null)}
            ><GripVertical size={16} /></span>
            <Switch checked={r.enabled} onChange={(v) => setLocal(list.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} />
            <div className="grow" style={{ cursor: "pointer", minWidth: 0 }} onClick={() => setEditing(r)}>
              <div style={{ fontWeight: 600 }}>{r.name}</div>
              <div className="hint truncate">{describeRule(r)}</div>
            </div>
            <button className="icon-btn sm" disabled={i === 0} aria-label={t("Move up")} onClick={() => { const n = [...list]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setLocal(n); }}><ArrowUp size={16} /></button>
            <button className="icon-btn sm" disabled={i === list.length - 1} aria-label={t("Move down")} onClick={() => { const n = [...list]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; setLocal(n); }}><ArrowDown size={16} /></button>
            <button className="icon-btn sm danger" aria-label={t("Delete rule")} onClick={() => setLocal(list.filter((x) => x.id !== r.id))}><Trash2 size={16} /></button>
          </div>
        </div>
      ))}
      {/*
        * Pinned, because with more than a screenful of rules this bar was the
        * only thing saying there was unsaved work and it sat below the fold.
        */}
      <div className="row save-bar">
        <button className="btn" onClick={() => setEditing(newRule())}><Plus size={16} />  {t("New rule")}</button>
        <span className="spacer" />
        {dirty && <span className="unsaved">{t("Unsaved changes")}</span>}
        {dirty && <button className="btn btn-ghost" onClick={() => setLocal(null)}>{t("Discard changes")}</button>}
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save(list)}>{saving ? t("Saving…") : t("Save filters")}</button>
      </div>
      {content && (
        <details style={{ marginTop: 20 }}>
          <summary className="hint" style={{ cursor: "pointer" }}>{t("Preview generated Sieve script")}</summary>
          <pre className="code notranslate" translate="no" style={{ minHeight: 120, marginTop: 8 }}>{rulesToSieve(list)}</pre>
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
  /**
   * What was in the editor when it opened, so "has this been touched" is a
   * comparison rather than a flag every edit path has to remember to set.
   * `null` means the editor is closed and there is nothing to compare.
   */
  const [opened, setOpened] = useState<{ name: string; content: string } | null>(null);
  const dirty = opened !== null && (name !== opened.name || content !== opened.content);

  const start = (scriptName: string, source: string) => {
    setName(scriptName);
    setContent(source);
    setOpened({ name: scriptName, content: source });
  };

  const close = () => {
    setSel(null);
    setName("");
    setContent("");
    setOpened(null);
    setValidation(null);
  };

  const open = async (s: SieveScript | null) => {
    setSel(s);
    setValidation(null);
    if (s) start(s.name, await sieve.getContent(s.id));
    else start("", 'require ["fileinto"];\n\n');
  };

  const save = async (activate: boolean): Promise<boolean> => {
    if (!name.trim()) {
      toast.error(t("Script name is required"));
      return false;
    }
    setBusy(true);
    try {
      const err = await sieve.validate(content);
      setValidation(err);
      if (err) {
        toast.error(t("Script has errors"));
        return false;
      }
      await sieve.saveScript(sel?.id ?? null, name.trim(), content, activate);
      toast.success(t("Script saved"));
      // All the way closed, back to the list. Clearing only `sel` left the
      // editor up -- it is shown whenever there is a name or a body -- but with
      // the name unlocked, so saving a second time created a duplicate script
      // rather than updating the one just written.
      close();
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A hand-written script is the worst thing here to lose, and until now
  // leaving the page took it without asking.
  useUnsavedChanges({
    dirty,
    message: t("Your Sieve script has changes that have not been saved."),
    // Whether this script is the active one is not this dialog's question to
    // reopen, so the save it offers leaves that exactly as it found it.
    save: () => save(false),
    discard: close,
  });

  // One question, asked once: the editor is up exactly while a script is open
  // in it. Before, this was a pair of identical nested conditions reading name
  // and body, which is also why saving could not put the editor away.
  if (opened !== null) {
    return (
      <div>
        <div className="field"><label>{t("Script name")}</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(sel)} /></div>
        <div className="field">
          <label>{t("Sieve source")}</label>
          <textarea className="code notranslate" translate="no" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} style={{ minHeight: 320 }} />
        </div>
        {validation && <div className="error-box mb-16">{validation}</div>}
        <div className="row save-bar">
          <button className="btn btn-ghost" onClick={close}>{t("Cancel")}</button>
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); const err = await sieve.validate(content); setValidation(err); setBusy(false); if (!err) toast.success(t("Script is valid")); }}><Play size={14} />  {t("Validate")}</button>
          <span className="spacer" />
          {dirty && <span className="unsaved">{t("Unsaved changes")}</span>}
          <button className="btn" disabled={busy} onClick={() => void save(false)}>{t("Save")}</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>{t("Save & activate")}</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="hint">{t("Advanced: manage raw Sieve scripts. Only one script can be active at a time.")}</p>
      {sieve.scripts.map((s) => (
        <div key={s.id} className="card">
          <div className="card-head">
            <h3><span>{s.name} </span>{s.isActive && <span className="tag" style={{ background: "var(--success)" }}>{t("active")}</span>}</h3>
            <button className="btn btn-sm" onClick={() => void open(s)}>{t("Edit")}</button>
            <button className="btn btn-sm" onClick={async () => { try { await sieve.activate(s.isActive ? null : s.id); } catch (err) { toast.error((err as Error).message); } }}><Power size={14} /> {s.isActive ? t("Deactivate") : t("Activate")}</button>
            <button className="icon-btn sm danger" aria-label={t("Delete script")} onClick={async () => { if (await confirmDialog({ title: t("Delete script “{name}”?", { name: s.name }), confirmLabel: t("Delete"), danger: true })) { try { await sieve.destroy(s.id); } catch (err) { toast.error((err as Error).message); } } }}><Trash2 size={16} /></button>
          </div>
        </div>
      ))}
      <button className="btn" onClick={async () => { const n = await promptDialog({ title: t("New script"), placeholder: t("Script name") }); if (n) start(n, 'require ["fileinto"];\n\n'); }}><Plus size={16} />  {t("New script")}</button>
    </div>
  );
}
