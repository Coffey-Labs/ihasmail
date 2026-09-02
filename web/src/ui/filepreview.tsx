import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Code2, Download, Eye, Printer } from "lucide-react";
import { Dialog } from "./dialog";
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

/**
 * Shows a file without downloading it: pictures, PDFs, and anything text.
 *
 * Grown out of the attachment preview in MessageView, which is where it still
 * has one of its two callers -- the other is Files, which until now could only
 * hand you the bytes.
 */
export function FilePreviewDialog({ file, onClose, caption }: { file: PreviewFile | null; onClose: () => void; caption?: ReactNode }) {
  const kind = file ? previewKind(file.type, file.name) : null;
  const tooBig = kind === "text" && typeof file?.size === "number" && file.size > TEXT_PREVIEW_MAX;
  const pdfRef = useRef<HTMLIFrameElement>(null);
  const markdown = Boolean(file) && kind === "text" && isMarkdown(file!.type, file!.name);
  /* Markdown opens as the document it is meant to be; the source is a click
     away for anyone who wants to see what it actually says. */
  const [rendered, setRendered] = useState(true);

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
      onClose={onClose}
      title={file?.name ?? t("Preview")}
      size="xl"
      footer={file && (
        <>
          {markdown && !tooBig && (
            <div className="segmented left" role="group" aria-label={t("View as")}>
              <button className={rendered ? "active" : ""} aria-pressed={rendered} onClick={() => setRendered(true)}><Eye size={14} />  {t("Rendered")}</button>
              <button className={rendered ? "" : "active"} aria-pressed={!rendered} onClick={() => setRendered(false)}><Code2 size={14} />  {t("Source")}</button>
            </div>
          )}
          {kind && !tooBig && <button className="btn" onClick={print}><Printer size={16} />  {t("Print")}</button>}
          <a className="btn" href={file.url} download={file.name}><Download size={16} />  {t("Download")}</a>
        </>
      )}
    >
      {file && (
        <>
          {tooBig ? (
            <p className="hint">{t("This file is too big to show here ({size}) — download it to read it.", { size: formatSize(file.size ?? 0) })}</p>
          ) : kind === "image" ? (
            <img src={file.inlineUrl} alt={file.name} style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto" }} />
          ) : kind === "pdf" ? (
            <iframe ref={pdfRef} title={file.name} src={file.inlineUrl} style={{ width: "100%", height: "70vh", border: 0 }} />
          ) : kind === "text" ? (
            /* `url`, not `inlineUrl`: fetch pays no attention to
               Content-Disposition, so this works for the text types the server
               will not serve inline -- Markdown among them. */
            <TextPreview url={file.url} markdown={markdown && rendered} />
          ) : (
            <p className="hint">{t("There is no preview for this kind of file.")}</p>
          )}
          {caption}
        </>
      )}
    </Dialog>
  );
}

function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null);
    setTruncated(false);
    fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (!live) return;
        setTruncated(body.length > TEXT_PREVIEW_CHARS);
        setText(body.slice(0, TEXT_PREVIEW_CHARS));
      })
      .catch(() => live && setText(t("Could not load this file.")));
    return () => {
      live = false;
    };
  }, [url]);
  /* Rendering is not free on a long file, and the toggle flips back and forth. */
  const html = useMemo(() => (markdown && text ? renderMarkdown(text) : null), [markdown, text]);
  return (
    <>
      {/* Someone else's file: not ours to translate, and not ours to reflow. */}
      {html !== null ? (
        <div className="md-body notranslate" translate="no" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code notranslate" translate="no" style={{ maxHeight: "65vh", whiteSpace: "pre-wrap" }}>
          {text ?? t("Loading…")}
        </pre>
      )}
      {truncated && <p className="hint">{t("Only the beginning is shown — download the file for the rest.")}</p>}
    </>
  );
}
