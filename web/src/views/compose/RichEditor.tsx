import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Code, Eraser, Image as ImageIcon, Indent, Italic, Link as LinkIcon, List, ListOrdered, Outdent, Quote, Redo, Smile, Strikethrough, Underline, Undo, Palette, Highlighter, Type } from "lucide-react";
import { sanitizeEditorHtml } from "@/lib/html";
import { Popover, useMenu } from "@/ui/popover";
import { t as translate } from "@/lib/i18n";

export interface RichEditorHandle {
  focus(): void;
  insertHtml(html: string): void;
  insertText(text: string): void;
  getHtml(): string;
}

interface Props {
  html: string;
  onChange: (html: string) => void;
  placeholder?: string;
  spellcheck?: boolean;
  onFiles?: (files: File[]) => void;
  toolbarExtra?: ReactNode;
  showToolbar: boolean;
  autoFocus?: boolean;
  /** If provided, inserted images are uploaded and referenced by URL instead of embedded as data: URLs. */
  imageUpload?: (file: File) => Promise<string>;
}

const EMOJI = "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 😘 😋 😜 🤪 🤗 🤔 🤫 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 👐 🤲 🤝 🙏 💪 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💯 💥 🔥 ✨ 🎉 🎊 🎈 🎁 🏆 ⭐ 🌟 ☀️ 🌙 ⚡ ☕ 🍕 🍺 🚀 ✈️ 🏠 💼 📅 📎 📌 ✅ ❌ ⚠️ ❓ ❗ 💡 🔔 📧 🙈 🙉 🙊 🐱 🐶 🦊 🐼".split(" ");
const COLORS = ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#ffffff", "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff", "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc", "#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0", "#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79"];

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ html, onChange, placeholder, spellcheck = true, onFiles, toolbarExtra, showToolbar, autoFocus, imageUpload }, ref) {
  const elRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>("");
  const [empty, setEmpty] = useState(!html);
  const emojiMenu = useMenu();
  const colorMenu = useMenu();
  const hiliteMenu = useMenu();
  const linkMenu = useMenu();
  const [linkUrl, setLinkUrl] = useState("");
  const savedRange = useRef<Range | null>(null);

  // Sync external html → DOM (only when it differs from what we emitted)
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (html !== lastEmitted.current) {
      el.innerHTML = html;
      lastEmitted.current = html;
      setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
    }
  }, [html]);

  // autoFocus means "focus on mount", as it does on a DOM element. Reacting to
  // the prop turning true later yanks the caret out of whatever the user is
  // typing in — typing the first letter of a subject used to jump to the body.
  const autoFocusOnMount = useRef(autoFocus);
  useEffect(() => {
    if (!autoFocusOnMount.current) return;
    const el = elRef.current;
    if (!el) return;
    el.focus();
    // caret at start
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  const emit = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const v = el.innerHTML;
    lastEmitted.current = v;
    setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
    onChange(v);
  }, [onChange]);

  const exec = useCallback(
    (cmd: string, value?: string) => {
      elRef.current?.focus();
      restoreRange();
      document.execCommand(cmd, false, value);
      emit();
    },
    [emit],
  );

  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && elRef.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const restoreRange = () => {
    const r = savedRange.current;
    if (!r) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  };

  const insertHtml = useCallback(
    (h: string) => {
      elRef.current?.focus();
      restoreRange();
      document.execCommand("insertHTML", false, h);
      emit();
    },
    [emit],
  );

  useImperativeHandle(ref, () => ({
    focus: () => elRef.current?.focus(),
    insertHtml,
    insertText: (t: string) => {
      elRef.current?.focus();
      restoreRange();
      document.execCommand("insertText", false, t);
      emit();
    },
    getHtml: () => elRef.current?.innerHTML ?? "",
  }));

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imgItem = items.find((i) => i.type.startsWith("image/"));
    if (imgItem) {
      const f = imgItem.getAsFile();
      if (f) {
        e.preventDefault();
        insertImageFile(f);
        return;
      }
    }
    const htmlData = e.clipboardData.getData("text/html");
    if (htmlData) {
      e.preventDefault();
      const clean = sanitizeEditorHtml(htmlData).replace(/<meta[^>]*>/gi, "");
      document.execCommand("insertHTML", false, clean);
      emit();
      return;
    }
    // plain text: let browser handle (it inserts text nodes) but normalize newlines
    const text = e.clipboardData.getData("text/plain");
    if (text && /\n/.test(text)) {
      e.preventDefault();
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
      document.execCommand("insertHTML", false, escaped);
      emit();
    }
  };

  const insertImageFile = (f: File) => {
    if (imageUpload) {
      imageUpload(f)
        .then((url) => insertHtml(`<img src="${url}" alt="${f.name.replace(/"/g, "")}" style="max-width:100%">`))
        .catch(() => {
          /* uploader reports its own errors */
        });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      insertHtml(`<img src="${reader.result as string}" alt="${f.name.replace(/"/g, "")}" style="max-width:100%">`);
    };
    reader.readAsDataURL(f);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    images.forEach(insertImageFile);
    if (others.length) onFiles?.(others);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    linkMenu.close();
    if (!url) return;
    const href = /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`;
    elRef.current?.focus();
    restoreRange();
    const sel = window.getSelection();
    if (sel && sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${href}" target="_blank" rel="noopener">${href}</a>`);
    else document.execCommand("createLink", false, href);
    emit();
    setLinkUrl("");
  };

  return (
    <div className="composer-editor">
      <div
        ref={elRef}
        className="editor-area"
        contentEditable
        suppressContentEditableWarning
        spellCheck={spellcheck}
        data-placeholder={placeholder ?? ""}
        data-empty={empty}
        onInput={emit}
        onBlur={saveRange}
        onKeyUp={saveRange}
        onMouseUp={saveRange}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            saveRange();
            linkMenu.open(e.currentTarget);
          }
          if (e.key === "Tab") {
            e.preventDefault();
            exec(e.shiftKey ? "outdent" : "indent");
          }
        }}
        role="textbox"
        aria-multiline="true"
        aria-label={translate("Message body")}
      />
      {showToolbar && (
        <div className="editor-toolbar" role="toolbar" aria-label={translate("Formatting")}>
          <button type="button" className="icon-btn" title={translate("Undo (Ctrl+Z)")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("undo")}><Undo size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Redo")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("redo")}><Redo size={16} /></button>
          <span className="tb-sep" />
          <select title={translate("Font size")} onMouseDown={saveRange} onChange={(e) => { exec("fontSize", e.target.value); e.target.value = ""; }} defaultValue="">
            <option value="" disabled>{translate("Size")}</option>
            <option value="1">{translate("Small")}</option>
            <option value="3">{translate("Normal")}</option>
            <option value="5">{translate("Large")}</option>
            <option value="7">{translate("Huge")}</option>
          </select>
          <button type="button" className="icon-btn" title={translate("Bold (Ctrl+B)")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")}><Bold size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Italic (Ctrl+I)")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")}><Italic size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Underline (Ctrl+U)")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("underline")}><Underline size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Strikethrough")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("strikeThrough")}><Strikethrough size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Text color")} onMouseDown={(e) => { e.preventDefault(); saveRange(); }} onClick={colorMenu.open}><Palette size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Highlight")} onMouseDown={(e) => { e.preventDefault(); saveRange(); }} onClick={hiliteMenu.open}><Highlighter size={16} /></button>
          <span className="tb-sep" />
          <button type="button" className="icon-btn" title={translate("Align left")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("justifyLeft")}><AlignLeft size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Center")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("justifyCenter")}><AlignCenter size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Align right")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("justifyRight")}><AlignRight size={16} /></button>
          <span className="tb-sep" />
          <button type="button" className="icon-btn" title={translate("Bulleted list")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertUnorderedList")}><List size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Numbered list")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertOrderedList")}><ListOrdered size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Decrease indent")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("outdent")}><Outdent size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Increase indent")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("indent")}><Indent size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Quote")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("formatBlock", "blockquote")}><Quote size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Code block")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("formatBlock", "pre")}><Code size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Normal text")} onMouseDown={(e) => e.preventDefault()} onClick={() => exec("formatBlock", "div")}><Type size={16} /></button>
          <span className="tb-sep" />
          <button type="button" className="icon-btn" title={translate("Insert link (Ctrl+K)")} onMouseDown={(e) => { e.preventDefault(); saveRange(); }} onClick={linkMenu.open}><LinkIcon size={16} /></button>
          <label className="icon-btn" title={translate("Insert image")} onMouseDown={saveRange}>
            <ImageIcon size={16} />
            <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImageFile(f); e.target.value = ""; }} />
          </label>
          <button type="button" className="icon-btn" title={translate("Emoji")} onMouseDown={(e) => { e.preventDefault(); saveRange(); }} onClick={emojiMenu.open}><Smile size={16} /></button>
          <button type="button" className="icon-btn" title={translate("Remove formatting")} onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("removeFormat"); exec("unlink"); }}><Eraser size={16} /></button>
          {toolbarExtra}
        </div>
      )}
      <Popover anchor={emojiMenu.anchor} onClose={emojiMenu.close} side="top" closeOnClick={false} width={290}>
        <div className="emoji-grid">
          {EMOJI.map((e) => (
            <button key={e} type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => { insertHtml(e); emojiMenu.close(); }}>{e}</button>
          ))}
        </div>
      </Popover>
      <Popover anchor={colorMenu.anchor} onClose={colorMenu.close} side="top" closeOnClick={false} width={230}>
        <div className="color-grid">
          {COLORS.map((c) => <button key={c} type="button" style={{ background: c }} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { exec("foreColor", c); colorMenu.close(); }} aria-label={c} />)}
        </div>
      </Popover>
      <Popover anchor={hiliteMenu.anchor} onClose={hiliteMenu.close} side="top" closeOnClick={false} width={230}>
        <div className="color-grid">
          {COLORS.map((c) => <button key={c} type="button" style={{ background: c }} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { exec("hiliteColor", c); hiliteMenu.close(); }} aria-label={c} />)}
        </div>
      </Popover>
      <Popover anchor={linkMenu.anchor} onClose={linkMenu.close} side="top" closeOnClick={false} width={320}>
        <form className="link-popup" onSubmit={(e) => { e.preventDefault(); applyLink(); }}>
          <input className="input sm" autoFocus placeholder={translate("https://…")} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
          <button type="submit" className="btn btn-sm btn-primary">{translate("Link")}</button>
        </form>
      </Popover>
    </div>
  );
});
