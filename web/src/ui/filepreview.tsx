import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Code2, Download, Eye, Pencil, Printer, Save, X } from "lucide-react";
import { confirmDialog, Dialog } from "./dialog";
import { formatSize } from "@/lib/format";
import { previewKind, TEXT_PREVIEW_CHARS, TEXT_PREVIEW_MAX } from "@/lib/preview";
import { isMarkdown, renderMarkdown } from "@/lib/markdown";
import { t } from "@/lib/i18n";

/**
 * One blob, described the way both callers can describe it. The URLs are built
 * by the caller so this stays a presentational component: nothing in `ui/`
 * reaches for the JMAP client, and this is not the file to break that with.
 */
export interface PreviewFile {
  name: string;
  type: string;
  size?: number | null;
  /** Plain download -- the server sends it as an attachment. */
  url: string;
  /** The same blob asked for inline. Only the allowlisted types come back that way. */
  inlineUrl: string;
}

type Mode = "rendered" | "source" | "edit";

/**
 * Shows a file without downloading it: pictures, PDFs, and anything text.
 *
 * Grown out of the attachment preview in MessageView, which is still one of its
 * two callers -- the other is Files, which could only hand you the bytes.
 *
 * `onSave` is what makes it an editor. Files passes one; mail does not, because
 * a message part is not a thing that can be written back.
 */
export function FilePreviewDialog({
  file,
  onClose,
  caption,
  onSave,
  startInEdit,
}: {
  file: PreviewFile | null;
  onClose: () => void;
  caption?: ReactNode;
  /** Write the text back. Rejecting with a message is how a conflict is reported. */
  onSave?: (text: string) => Promise<void>;
  /** Open straight into the editor -- what the row menu's Edit asks for. */
  startInEdit?: boolean;
}) {
  const kind = file ? previewKind(file.type, file.name) : null;
  const tooBig = kind === "text" && typeof file?.size === "number" && file.size > TEXT_PREVIEW_MAX;
  const markdown = Boolean(file) && kind === "text" && isMarkdown(file!.type, file!.name);
  const pdfRef = useRef<HTMLIFrameElement>(null);

  const loaded = useTextFile(kind === "text" && !tooBig ? file?.url ?? null : null);
  const [mode, setMode] = useState<Mode>("source");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState(false);

  /* A new file starts over: Markdown as the document it is, everything else as
     what it says, and never in the editor. */
  useEffect(() => {
    setMode(markdown ? "rendered" : "source");
    setDraft("");
    setSaveError(null);
    setPendingEdit(Boolean(startInEdit));
  }, [file?.url, markdown, startInEdit]);

  /*
   * Three reasons not to offer editing, and each of them would lose data:
   *
   *  - the file was truncated for display, so saving would write the tail away;
   *  - it did not decode as UTF-8 (the replacement character is the giveaway),
   *    so saving would write mojibake over whatever encoding it really is;
   *  - the caller has no way to save it, or the reader has no right to.
   */
  const lossy = loaded.text?.includes("�") ?? false;
  const editable = Boolean(onSave) && kind === "text" && !tooBig && !loaded.truncated && !lossy && loaded.text !== null && !loaded.failed;
  const editing = mode === "edit";
  const dirty = editing && draft !== (loaded.text ?? "");

  /* Opening straight into the editor has to wait for the text to arrive, and
     may still land in the read-only view: whether a file can be edited is not
     known until it has been read (truncated? not UTF-8?), and the row menu
     could only guess from its name. The note under the pane says why. */
  useEffect(() => {
    if (!pendingEdit || loaded.text === null) return;
    setPendingEdit(false);
    if (!editable) return;
    setDraft(loaded.text);
    setMode("edit");
  }, [pendingEdit, editable, loaded.text]);

  const startEditing = () => {
    setDraft(loaded.text ?? "");
    setSaveError(null);
    setMode("edit");
  };

  const stopEditing = async () => {
    if (dirty && !(await confirmDialog({ title: t("Throw away your changes?"), confirmLabel: t("Discard"), danger: true }))) return;
    setMode(markdown ? "rendered" : "source");
    setSaveError(null);
  };

  const save = useCallback(async () => {
    if (!onSave || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      loaded.replace(draft);
      setMode(markdown ? "rendered" : "source");
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [onSave, saving, draft, loaded, markdown]);

  /* The shortcut everyone's hands already know. Only while the editor is open,
     so it does not shadow the browser's own Save anywhere else. */
  useEffect(() => {
    if (!editing) return;
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, save]);

  /* Closing with unsaved work asks first -- Escape and the backdrop both come
     through here. */
  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirmDialog({ title: t("Close without saving?"), confirmLabel: t("Discard"), danger: true }).then((yes) => yes && onClose());
  };

  /*
   * Print what is on screen, not the mail or the file list behind it.
   *
   * A PDF is its own document inside an iframe, and the page around it cannot
   * paginate it -- printing the page yields the first screenful of the viewer
   * and nothing else. Same origin, so we can ask the iframe to print itself,
   * which is the browser's own PDF print. Chrome sometimes refuses while the
   * viewer is still loading; opening it in a tab leaves the reader somewhere
   * they can print from, which is better than a silent no-op.
   *
   * Pictures and text are ours to lay out, so those go through the page with
   * the dialog marked and everything else dropped -- see `printing-preview` in
   * the print block of app.css.
   */
  const print = () => {
    if (kind === "pdf") {
      const frame = pdfRef.current;
      try {
        if (!frame?.contentWindow) throw new Error("no frame");
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch {
        if (file) window.open(file.inlineUrl, "_blank", "noopener");
      }
      return;
    }
    const root = document.documentElement;
    const clear = () => {
      root.classList.remove("printing-preview");
      window.removeEventListener("afterprint", clear);
    };
    window.addEventListener("afterprint", clear);
    root.classList.add("printing-preview");
    try {
      window.print();
    } finally {
      clear();
    }
  };

  return (
    <Dialog
      open={Boolean(file)}
      onClose={requestClose}
      title={file?.name ?? t("Preview")}
      size="xl"
      closeOnBackdrop={!editing}
      footer={
        file && (
          <>
            {editing ? (
              <>
                {dirty && <span className="hint left">{t("Unsaved changes")}</span>}
                <button className="btn" onClick={() => void stopEditing()} disabled={saving}><X size={16} />  {t("Cancel")}</button>
                <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}><Save size={16} />  {saving ? t("Saving…") : t("Save")}</button>
              </>
            ) : (
              <>
                {markdown && !tooBig && (
                  <div className="segmented left" role="group" aria-label={t("View as")}>
                    <button className={mode === "rendered" ? "active" : ""} aria-pressed={mode === "rendered"} onClick={() => setMode("rendered")}><Eye size={14} />  {t("Rendered")}</button>
                    <button className={mode === "source" ? "active" : ""} aria-pressed={mode === "source"} onClick={() => setMode("source")}><Code2 size={14} />  {t("Source")}</button>
                  </div>
                )}
                {editable && <button className="btn" onClick={startEditing}><Pencil size={16} />  {t("Edit")}</button>}
                {kind && !tooBig && <button className="btn" onClick={print}><Printer size={16} />  {t("Print")}</button>}
                <a className="btn" href={file.url} download={file.name}><Download size={16} />  {t("Download")}</a>
              </>
            )}
          </>
        )
      }
    >
      {file && (
        <>
          {saveError && <div className="error-box mb-8">{saveError}</div>}
          {tooBig ? (
            <p className="hint">{t("This file is too big to show here ({size}) — download it to read it.", { size: formatSize(file.size ?? 0) })}</p>
          ) : kind === "image" ? (
            <img src={file.inlineUrl} alt={file.name} style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto" }} />
          ) : kind === "pdf" ? (
            <iframe ref={pdfRef} title={file.name} src={file.inlineUrl} style={{ width: "100%", height: "70vh", border: 0 }} />
          ) : kind === "text" ? (
            <TextPane
              loaded={loaded}
              mode={mode}
              markdown={markdown}
              draft={draft}
              onDraft={setDraft}
              note={editing ? null : readOnlyNote(loaded, lossy)}
            />
          ) : (
            <p className="hint">{t("There is no preview for this kind of file.")}</p>
          )}
          {caption}
        </>
      )}
    </Dialog>
  );
}

/** Why the file is being shown but not offered for editing, when there is a reason worth saying. */
function readOnlyNote(loaded: LoadedText, lossy: boolean): string | null {
  if (loaded.text === null || loaded.failed) return null;
  if (loaded.truncated) return t("Only the beginning is shown — download the file for the rest.");
  if (lossy) return t("This file is not UTF-8 text, so editing it here would corrupt it — download it instead.");
  return null;
}

function TextPane({
  loaded,
  mode,
  markdown,
  draft,
  onDraft,
  note,
}: {
  loaded: LoadedText;
  mode: Mode;
  markdown: boolean;
  draft: string;
  onDraft: (v: string) => void;
  note: string | null;
}) {
  /* Rendering is not free on a long file, and the toggle flips back and forth. */
  const html = useMemo(() => (mode === "rendered" && markdown && loaded.text ? renderMarkdown(loaded.text) : null), [mode, markdown, loaded.text]);
  if (mode === "edit") {
    return (
      <textarea
        className="code notranslate"
        translate="no"
        autoFocus
        spellCheck={false}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        style={{ height: "60vh", whiteSpace: "pre", display: "block" }}
        aria-label={t("File contents")}
      />
    );
  }
  return (
    <>
      {/* Someone else's file: not ours to translate, and not ours to reflow. */}
      {html !== null ? (
        <div className="md-body notranslate" translate="no" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code notranslate" translate="no" style={{ maxHeight: "65vh", whiteSpace: "pre-wrap" }}>
          {loaded.text ?? t("Loading…")}
        </pre>
      )}
      {note && <p className="hint">{note}</p>}
    </>
  );
}

interface LoadedText {
  text: string | null;
  truncated: boolean;
  failed: boolean;
  /** Adopt what was just saved as the new baseline, without re-fetching. */
  replace(next: string): void;
}

/**
 * The file's text, held here rather than in the pane that shows it: the editor,
 * the source view and the rendered view are all looking at the same bytes, and
 * saving has to know what they were to tell whether anything changed.
 */
function useTextFile(url: string | null): LoadedText {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setText(null);
    setTruncated(false);
    setFailed(false);
    if (!url) return;
    let live = true;
    fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (!live) return;
        setTruncated(body.length > TEXT_PREVIEW_CHARS);
        setText(body.slice(0, TEXT_PREVIEW_CHARS));
      })
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setText(t("Could not load this file."));
      });
    return () => {
      live = false;
    };
  }, [url]);
  const replace = useCallback((next: string) => {
    setText(next);
    setTruncated(false);
  }, []);
  return { text, truncated, failed, replace };
}
