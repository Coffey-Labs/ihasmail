import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, FileText, FolderOpen, Maximize2, Minimize2, Minus, MoreVertical, Paperclip, Send, Trash2, X, Type, Clock, CheckCheck, ChevronsDown } from "lucide-react";
import { useCompose, type Draft } from "@/store/compose";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { visibleIdentities } from "@/lib/identityVisibility";
import { RecipientInput } from "./RecipientInput";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { MenuItem, MenuSep, MenuTitle, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { formatSize, formatRelative } from "@/lib/format";
import { htmlToText, textToHtml } from "@/lib/text";
import { isValidEmail } from "@/lib/address";
import { attachmentIcon } from "../mail/MessageView";
import { FilePicker } from "./FilePicker";
import { useFiles } from "@/store/files";
import { keyboard } from "@/lib/keyboard";
import { useIsMobile } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { ScheduleDialog, ScheduleMenuItems } from "./SchedulePicker";
import { scheduleSupported, scheduleWindowMs } from "@/store/scheduled";
import { formatScheduleTime } from "@/lib/schedule";

export function Composer({ draft }: { draft: Draft }) {
  const update = useCompose((s) => s.update);
  const close = useCompose((s) => s.close);
  const send = useCompose((s) => s.send);
  const saveDraft = useCompose((s) => s.saveDraft);
  const addFiles = useCompose((s) => s.addFiles);
  const addFromFiles = useCompose((s) => s.addFromFiles);
  const filesAvailable = useFiles((s) => s.available);
  const [pickerOpen, setPickerOpen] = useState(false);
  const removeAttachment = useCompose((s) => s.removeAttachment);
  const setIdentity = useCompose((s) => s.setIdentity);
  const insertTemplate = useCompose((s) => s.insertTemplate);
  const focus = useCompose((s) => s.focus);
  const allIdentities = useMail((s) => s.identities);
  const mailAccountId = useMail((s) => s.accountId);
  const hiddenIdentities = useSettings((s) => s.settings.hiddenIdentities);
  const defaultIdentityId = useSettings((s) => (mailAccountId ? s.settings.defaultIdentityByAccount[mailAccountId] : undefined));
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);
  const isMobile = useIsMobile();
  const editorRef = useRef<RichEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const moreMenu = useMenu();
  const sendMenu = useMenu();
  const templateMenu = useMenu();
  const [showToolbar, setShowToolbar] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Read once per render from the session; it cannot change while a composer is open.
  const canSchedule = scheduleSupported();
  const scheduleMax = canSchedule ? scheduleWindowMs() : 0;
  const d = draft;
  const key = d.key;
  // Where the caret starts, decided once when the composer opens: a blank
  // message starts in the recipients, a reply (already addressed and titled)
  // starts in the body. Deriving this from live state would move the caret
  // while the user types.
  const [initialFocus] = useState(() => initialFocusTarget(draft));

  const patch = useCallback((p: Partial<Draft>) => update(key, p), [update, key]);
  const onHtml = useCallback((html: string) => update(key, { html }), [update, key]);

  // Esc closes (saves draft); Ctrl+Enter sends
  useEffect(() => {
    if (d.minimized) return;
    return keyboard.pushScope("composer", [
      { keys: "mod+enter", description: "Send message", group: "Compose", handler: () => void doSend(), allowInInput: true },
      { keys: "esc", description: "Close composer (saves draft)", group: "Compose", handler: () => { if (document.activeElement?.closest(".composer")) { void close(key); return true; } return false; }, allowInInput: true },
      { keys: "mod+s", description: "Save draft", group: "Compose", handler: () => { void saveDraft(key); }, allowInInput: true },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, d.minimized]);

  const bodyText = useMemo(() => (d.format === "html" ? htmlToText(d.html.replace(/<div class="ihm-quote">[\s\S]*$/, "")) : d.text), [d.html, d.text, d.format]);

  const doSend = async () => {
    const all = [...d.to, ...d.cc, ...d.bcc];
    if (!all.length) {
      toast.error("Please add at least one recipient");
      return;
    }
    const bad = all.filter((a) => !isValidEmail(a.email));
    if (bad.length) {
      toast.error(`Invalid address: ${bad[0]!.email}`);
      return;
    }
    if (d.attachments.some((a) => a.error)) {
      toast.error("Remove attachments that failed to upload first");
      return;
    }
    if (d.attachments.some((a) => !a.blobId)) {
      toast.error("Attachments are still uploading");
      return;
    }
    if (!d.subject.trim()) {
      const ok = await confirmDialog({ title: "Send without a subject?", confirmLabel: "Send anyway" });
      if (!ok) return;
    }
    if (settings.attachmentReminder && !d.attachments.length && /\b(attach(ed|ment|ing)?|enclosed|anbei|ci-joint|adjunto)\b/i.test(bodyText) ) {
      const ok = await confirmDialog({ title: "Did you forget the attachment?", message: "Your message mentions an attachment, but nothing is attached.", confirmLabel: "Send anyway" });
      if (!ok) return;
    }
    await send(key);
  };

  const scheduleFor = (at: Date) => {
    sendMenu.close();
    setScheduleOpen(false);
    patch({ sendAt: at.getTime() });
  };

  const toggleFormat = () => {
    if (d.format === "html") {
      patch({ format: "text", text: htmlToText(d.html) });
    } else {
      patch({ format: "html", html: textToHtml(d.text, { linkify: false, quoteColors: false }).replace(/\n/g, "<br>") });
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addFiles(key, files);
  };

  /*
   * The picker offers the visible identities, plus two that can never be
   * hidden from it: the one this draft is already using, and the default a new
   * draft starts on. Hiding either would leave the select with no matching
   * option and silently move the From line. See lib/identityVisibility.
   */
  const identities = useMemo(
    () => visibleIdentities(allIdentities, hiddenIdentities, [d.identityId, defaultIdentityId]),
    [allIdentities, hiddenIdentities, d.identityId, defaultIdentityId],
  );
  const ident = identities.find((i) => i.id === d.identityId) ?? identities[0];
  const title = d.subject || (d.replyMode ? (d.replyMode === "forward" ? "Forward" : "Reply") : "New message");
  const status = d.sending ? "Sending…" : d.saving ? "Saving…" : d.error ? "Error" : d.savedAt ? `Saved ${formatRelative(new Date(d.savedAt).toISOString())}` : d.dirty ? "Unsaved" : "";
  const totalSize = d.attachments.reduce((n, a) => n + a.size, 0);

  if (d.minimized) {
    return (
      <div className="composer minimized" onClick={() => focus(key)}>
        <div className="composer-head">
          <span className="title">{title}</span>
          <button className="icon-btn sm" aria-label="Restore" onClick={(e) => { e.stopPropagation(); focus(key); }}><Maximize2 size={16} /></button>
          <button className="icon-btn sm" aria-label="Close" onClick={(e) => { e.stopPropagation(); void close(key); }}><X size={16} /></button>
        </div>
      </div>
    );
  }

  return (
    <div className={`composer ${d.maximized ? "maximized" : ""} ${dropping ? "dropping" : ""}`} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)} onDrop={onDrop} role="dialog" aria-label="Compose message">
      <div className="composer-head" onDoubleClick={() => patch({ maximized: !d.maximized })}>
        <span className="title">{title}</span>
        <span className="status">{status}</span>
        {!isMobile && <button className="icon-btn sm" aria-label="Minimize" title="Minimize" onClick={() => patch({ minimized: true })}><Minus size={16} /></button>}
        {!isMobile && <button className="icon-btn sm" aria-label={d.maximized ? "Restore" : "Maximize"} title={d.maximized ? "Restore" : "Full screen"} onClick={() => patch({ maximized: !d.maximized })}>{d.maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
        <button className="icon-btn sm" aria-label="Close" title="Save & close (Esc)" onClick={() => void close(key)}><X size={18} /></button>
      </div>
      <div className="composer-body">
        <div className="composer-fields">
          {identities.length > 1 && (
            <div className="composer-field">
              <label>From</label>
              <select className="from-select" value={ident?.id ?? ""} onChange={(e) => setIdentity(key, e.target.value)}>
                {identities.map((i) => <option key={i.id} value={i.id}>{i.name ? `${i.name} <${i.email}>` : i.email}</option>)}
              </select>
            </div>
          )}
          <div className="composer-field">
            <label htmlFor={`${key}-to`}>To</label>
            <RecipientInput id={`${key}-to`} value={d.to} onChange={(to) => patch({ to })} placeholder="Recipients" autoFocus={initialFocus === "to"} />
            <span className="field-extra">
              {!d.showCc && <button type="button" onClick={() => patch({ showCc: true })}>Cc</button>}
              {!d.showBcc && <button type="button" onClick={() => patch({ showBcc: true })}>Bcc</button>}
              {!d.showReplyTo && <button type="button" onClick={() => patch({ showReplyTo: true })} title="Set a Reply-To address">Reply-To</button>}
            </span>
          </div>
          {d.showReplyTo && (
            <div className="composer-field">
              <label htmlFor={`${key}-rt`} title="Replies will go to this address instead of the From address">Reply-To</label>
              <RecipientInput id={`${key}-rt`} value={d.replyTo} onChange={(replyTo) => patch({ replyTo })} placeholder="Replies go to…" />
            </div>
          )}
          {d.showCc && (
            <div className="composer-field">
              <label htmlFor={`${key}-cc`}>Cc</label>
              <RecipientInput id={`${key}-cc`} value={d.cc} onChange={(cc) => patch({ cc })} />
            </div>
          )}
          {d.showBcc && (
            <div className="composer-field">
              <label htmlFor={`${key}-bcc`}>Bcc</label>
              <RecipientInput id={`${key}-bcc`} value={d.bcc} onChange={(bcc) => patch({ bcc })} />
            </div>
          )}
          <div className="composer-field">
            <label htmlFor={`${key}-subj`} className="sr-only">Subject</label>
            <input id={`${key}-subj`} className="plain" placeholder="Subject" value={d.subject} onChange={(e) => patch({ subject: e.target.value })} autoFocus={initialFocus === "subject"} />
            {d.priority !== "normal" && <span className="tag" style={{ background: d.priority === "high" ? "var(--danger)" : "var(--fg-faint)" }}>{d.priority === "high" ? "High priority" : "Low priority"}</span>}
            {d.requestReceipt && <span className="tag" style={{ background: "var(--accent)" }} title="Read receipt requested"><CheckCheck size={12} /></span>}
            {d.sendAt !== null && (
              <button type="button" className="tag" style={{ background: "var(--accent)" }} title="Scheduled — click to clear the schedule" onClick={() => patch({ sendAt: null })}>
                <Clock size={12} /> {formatScheduleTime(new Date(d.sendAt))} <X size={12} />
              </button>
            )}
          </div>
        </div>
        {d.format === "html" ? (
          <RichEditor ref={editorRef} html={d.html} onChange={onHtml} placeholder="Write your message…" spellcheck={settings.spellcheck} onFiles={(files) => addFiles(key, files)} showToolbar={showToolbar} autoFocus={initialFocus === "body"} />
        ) : (
          <textarea className="editor-textarea" value={d.text} onChange={(e) => patch({ text: e.target.value })} placeholder="Write your message…" spellCheck={settings.spellcheck} />
        )}
        {d.attachments.some((a) => !a.inline) && (
          <div className="composer-attachments">
            {d.attachments.filter((a) => !a.inline).map((a) => (
              <div key={a.id} className={`attachment ${a.error ? "error" : ""}`} title={a.error ?? a.name}>
                <span className="att-icon">{attachmentIcon(a.type, a.name)}</span>
                <span className="att-text">
                  <span className="att-name">{a.name}</span>
                  <span className="att-size">{a.error ? <span style={{ color: "var(--danger)" }}>{a.error}</span> : a.blobId ? formatSize(a.size) : `${a.progress}%`}{a.inline ? " · inline" : ""}</span>
                </span>
                <button className="icon-btn xs" aria-label="Remove attachment" onClick={() => removeAttachment(key, a.id)}><X size={14} /></button>
                {!a.blobId && !a.error && <span className="att-progress" style={{ width: `${a.progress}%` }} />}
              </div>
            ))}
          </div>
        )}
        <div className="composer-foot">
          <span className="send-group">
            <button className="btn btn-primary" onClick={() => void doSend()} disabled={d.sending} title={d.sendAt !== null ? `Hand to the server, held until ${formatScheduleTime(new Date(d.sendAt))} (Ctrl+Enter)` : "Send (Ctrl+Enter)"}>
              {d.sendAt !== null ? <><Clock size={16} /> Schedule send</> : <><Send size={16} /> Send</>}
            </button>
            <button className="btn btn-primary" onClick={sendMenu.open} aria-label="Send options"><ChevronDown size={16} /></button>
          </span>
          <Popover anchor={sendMenu.anchor} onClose={sendMenu.close} side="top" width={280}>
            <MenuItem icon={<Send size={16} />} label={d.sendAt !== null ? "Send now instead" : "Send"} kbd={d.sendAt !== null ? undefined : "Ctrl+↵"} onClick={() => { if (d.sendAt !== null) patch({ sendAt: null }); sendMenu.close(); void doSend(); }} />
            <MenuItem icon={<Clock size={16} />} label={`Undo window: ${settings.undoSendSeconds}s`} onClick={() => updateSettings({ undoSendSeconds: settings.undoSendSeconds >= 30 ? 0 : settings.undoSendSeconds + 5 })} />
            {canSchedule && <ScheduleMenuItems maxMs={scheduleMax} onPick={scheduleFor} onCustom={() => { sendMenu.close(); setScheduleOpen(true); }} />}
          </Popover>
          {pickerOpen && <FilePicker onPick={(picked) => void addFromFiles(key, picked)} onClose={() => setPickerOpen(false)} />}
          {canSchedule && scheduleOpen && (
            <ScheduleDialog open maxMs={scheduleMax} initial={d.sendAt} onClose={() => setScheduleOpen(false)} onPick={scheduleFor} />
          )}
          <span className="more-actions">
            <button className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}><Paperclip size={18} /></button>
            {filesAvailable && <button className="icon-btn" title="Attach from Files" onClick={() => setPickerOpen(true)}><FolderOpen size={18} /></button>}
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) addFiles(key, files); e.target.value = ""; }} />
            {d.format === "html" && <button className={`icon-btn ${showToolbar ? "active" : ""}`} title="Formatting options" onClick={() => setShowToolbar((v) => !v)}><Type size={18} /></button>}
            {settings.templates.length > 0 && <button className="icon-btn" title="Insert template" onClick={templateMenu.open}><FileText size={18} /></button>}
            <Popover anchor={templateMenu.anchor} onClose={templateMenu.close} side="top" width={260}>
              <MenuTitle>Templates</MenuTitle>
              {settings.templates.map((t) => <MenuItem key={t.id} label={t.name} onClick={() => insertTemplate(key, t.html, t.subject)} />)}
            </Popover>
            <button className="icon-btn" onClick={moreMenu.open} aria-label="More options"><MoreVertical size={18} /></button>
            <Popover anchor={moreMenu.anchor} onClose={moreMenu.close} side="top" width={260}>
              <MenuItem icon={<Type size={16} />} label={d.format === "html" ? "Switch to plain text" : "Switch to rich text"} onClick={toggleFormat} />
              <MenuItem icon={<CheckCheck size={16} />} label="Request read receipt" checked={d.requestReceipt} onClick={() => patch({ requestReceipt: !d.requestReceipt })} />
              <MenuSep />
              <MenuTitle>Priority</MenuTitle>
              <MenuItem label="High" checked={d.priority === "high"} onClick={() => patch({ priority: "high" })} />
              <MenuItem label="Normal" checked={d.priority === "normal"} onClick={() => patch({ priority: "normal" })} />
              <MenuItem label="Low" checked={d.priority === "low"} onClick={() => patch({ priority: "low" })} />
              <MenuSep />
              <MenuItem icon={<ChevronsDown size={16} />} label="Save as template" onClick={async () => { const name = await promptDialog({ title: "Save as template", defaultValue: d.subject || "Template", placeholder: "Template name" }); if (name) updateSettings({ templates: [...useSettings.getState().settings.templates, { id: `t${Date.now()}`, name, subject: d.subject, html: d.format === "html" ? d.html : textToHtml(d.text) }] }); }} />
              <MenuItem icon={<FileText size={16} />} label="Save draft now" onClick={() => void saveDraft(key)} />
            </Popover>
          </span>
          <span className="spacer" />
          {totalSize > 20 * 1024 * 1024 && <span className="hint row gap-4" title="Large attachments may be rejected by some servers"><AlertTriangle size={14} /> {formatSize(totalSize)}</span>}
          <button className="icon-btn danger" title="Discard draft" aria-label="Discard draft" onClick={async () => { if (!d.dirty && !d.draftId) { void close(key, { discard: true }); return; } if (await confirmDialog({ title: "Discard this draft?", confirmLabel: "Discard", danger: true })) void close(key, { discard: true }); }}><Trash2 size={18} /></button>
        </div>
      </div>
    </div>
  );
}

export type FocusTarget = "to" | "subject" | "body";

/** Which field a freshly opened composer should put the caret in. */
export function initialFocusTarget(d: Pick<Draft, "to" | "subject">): FocusTarget {
  if (!d.to.length) return "to";
  if (!d.subject) return "subject";
  return "body";
}
