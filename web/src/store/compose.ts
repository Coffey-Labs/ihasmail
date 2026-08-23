import { create } from "zustand";
import { client, setErrorMessage } from "@/jmap/client";
import type { Email, EmailAddress, EmailBodyPart, Id, Identity, SetResponse } from "@/jmap/types";
import { formatFullDate, uid } from "@/lib/format";
import { formatAddress, parseMailto, sameAddress, uniqueAddresses } from "@/lib/address";
import { escapeHtml, htmlToText, quoteText, replySubject, textToHtml } from "@/lib/text";
import { sanitizeEmailHtml, sanitizeEditorHtml } from "@/lib/html";
import { toast } from "@/ui/toast";
import { useMail, FULL_PROPS, BODY_PROPS } from "./mail";
import { settings } from "./settings";

export interface ComposeAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  blobId: Id | null;
  progress: number;
  error: string | null;
  file?: File;
  cid?: string;
  inline?: boolean;
  abort?: AbortController;
}

export type Priority = "high" | "normal" | "low";

export interface Draft {
  key: string;
  draftId: Id | null;
  identityId: Id | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  /** Per-message Reply-To (defaults to the identity's Reply-To). */
  replyTo: EmailAddress[];
  subject: string;
  html: string;
  text: string;
  format: "html" | "text";
  attachments: ComposeAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
  relatedEmailId: Id | null;
  relatedKeyword: "$answered" | "$forwarded" | null;
  requestReceipt: boolean;
  priority: Priority;
  showCc: boolean;
  showBcc: boolean;
  showReplyTo: boolean;
  minimized: boolean;
  maximized: boolean;
  dirty: boolean;
  savedAt: number | null;
  saving: boolean;
  sending: boolean;
  error: string | null;
  /** Original identity signature HTML currently embedded, to replace on identity switch. */
  signatureHtml: string;
  replyMode: "reply" | "replyAll" | "forward" | null;
  mailboxIdOnSend?: Id | null;
}

interface ComposeState {
  drafts: Draft[];
  activeKey: string | null;
  pendingSends: Record<string, { timer: number; toastId: number; draft: Draft }>;
  open(init?: Partial<Draft>): string;
  openDraftEmail(email: Email): Promise<string>;
  reply(email: Email, mode: "reply" | "replyAll" | "forward", opts?: { all?: boolean }): Promise<string>;
  update(key: string, patch: Partial<Draft>): void;
  close(key: string, opts?: { discard?: boolean }): Promise<void>;
  focus(key: string): void;
  addFiles(key: string, files: File[]): void;
  removeAttachment(key: string, attId: string): void;
  saveDraft(key: string, opts?: { silent?: boolean }): Promise<Id | null>;
  send(key: string): Promise<void>;
  undoSend(key: string): void;
  setIdentity(key: string, identityId: Id): void;
  insertTemplate(key: string, html: string, subject?: string): void;
}

const AUTOSAVE_MS = 20_000;
const autosaveTimers = new Map<string, number>();

function blankDraft(init: Partial<Draft> = {}): Draft {
  const s = settings();
  return {
    key: uid("d"),
    draftId: null,
    identityId: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "",
    html: "",
    text: "",
    format: s.composeFormat,
    attachments: [],
    inReplyTo: null,
    references: null,
    relatedEmailId: null,
    relatedKeyword: null,
    requestReceipt: s.requestReadReceipt,
    priority: "normal",
    showCc: false,
    showBcc: false,
    showReplyTo: false,
    minimized: false,
    maximized: false,
    dirty: false,
    savedAt: null,
    saving: false,
    sending: false,
    error: null,
    signatureHtml: "",
    replyMode: null,
    ...init,
  };
}

export function signatureBlock(identity: Identity | undefined, format: "html" | "text"): string {
  if (!identity) return "";
  if (format === "text") return identity.textSignature ? `\n\n-- \n${identity.textSignature}` : "";
  if (identity.htmlSignature) return `<div class="ihm-signature" data-ihm-sig="1"><br>${sanitizeEditorHtml(identity.htmlSignature)}</div>`;
  if (identity.textSignature) return `<div class="ihm-signature" data-ihm-sig="1"><br>-- <br>${textToHtml(identity.textSignature, { quoteColors: false }).replace(/\n/g, "<br>")}</div>`;
  return "";
}

function defaultIdentity(identities: Identity[], email?: Email | null): Identity | undefined {
  if (!identities.length) return undefined;
  if (email) {
    const candidates = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
    for (const c of candidates) {
      const m = identities.find((i) => sameAddress(i.email, c.email));
      if (m) return m;
    }
  }
  return useMail.getState().defaultIdentity() ?? identities[0];
}

export const useCompose = create<ComposeState>((set, get) => ({
  drafts: [],
  activeKey: null,
  pendingSends: {},

  open(init = {}) {
    const identities = useMail.getState().identities;
    const ident = init.identityId ? identities.find((i) => i.id === init.identityId) : useMail.getState().defaultIdentity();
    const d = blankDraft({ identityId: ident?.id ?? null, replyTo: ident?.replyTo ?? [], showReplyTo: Boolean(ident?.replyTo?.length), ...init });
    if (!init.html && !init.text && ident) {
      d.signatureHtml = signatureBlock(ident, "html");
      d.html = `<div><br></div>${d.signatureHtml}`;
      d.text = signatureBlock(ident, "text");
    }
    set((s) => ({ drafts: [...s.drafts.map((x) => ({ ...x, minimized: s.drafts.length >= 1 ? x.minimized : x.minimized })), d], activeKey: d.key }));
    return d.key;
  },

  async openDraftEmail(email) {
    const existing = get().drafts.find((d) => d.draftId === email.id);
    if (existing) {
      get().focus(existing.key);
      return existing.key;
    }
    const full = (await useMail.getState().getEmails([email.id], true))[0] ?? email;
    const identities = useMail.getState().identities;
    const ident = identities.find((i) => full.from?.some((f) => sameAddress(f.email, i.email))) ?? useMail.getState().defaultIdentity() ?? identities[0];
    const htmlPart = full.htmlBody?.[0];
    const textPart = full.textBody?.[0];
    const html = htmlPart?.partId ? (full.bodyValues?.[htmlPart.partId]?.value ?? "") : "";
    const text = textPart?.partId ? (full.bodyValues?.[textPart.partId]?.value ?? "") : "";
    const accountId = useMail.getState().accountId!;
    const cidMap: Record<string, string> = {};
    const attachments: ComposeAttachment[] = [];
    for (const a of full.attachments ?? []) {
      const inline = Boolean(a.cid) && (a.disposition === "inline" || a.type.startsWith("image/"));
      if (inline && a.cid && a.blobId) cidMap[a.cid] = client.downloadUrl(accountId, a.blobId, a.name ?? "image", a.type, true);
      attachments.push({ id: uid("a"), name: a.name ?? "attachment", type: a.type, size: a.size, blobId: a.blobId, progress: 100, error: null, cid: a.cid ?? undefined, inline });
    }
    const d = blankDraft({
      draftId: full.id,
      identityId: ident?.id ?? null,
      to: full.to ?? [],
      cc: full.cc ?? [],
      bcc: full.bcc ?? [],
      replyTo: full.replyTo ?? ident?.replyTo ?? [],
      showReplyTo: Boolean(full.replyTo?.length || ident?.replyTo?.length),
      showCc: Boolean(full.cc?.length),
      showBcc: Boolean(full.bcc?.length),
      subject: full.subject ?? "",
      html: html ? sanitizeEmailHtml(html, { cidMap, allowRemote: true }).html : textToHtml(text).replace(/\n/g, "<br>"),
      text: text || (html ? htmlToText(html) : ""),
      format: html ? "html" : settings().composeFormat,
      attachments,
      inReplyTo: full.inReplyTo ?? null,
      references: full.references ?? null,
      requestReceipt: Boolean(full["header:Disposition-Notification-To:asAddresses"]?.length),
      priority: /^[12]/.test(full["header:X-Priority:asText"] ?? "") ? "high" : /^[45]/.test(full["header:X-Priority:asText"] ?? "") ? "low" : "normal",
    });
    set((s) => ({ drafts: [...s.drafts, d], activeKey: d.key }));
    return d.key;
  },

  async reply(email, mode) {
    const mail = useMail.getState();
    const full = (await mail.getEmails([email.id], true))[0] ?? email;
    const identities = mail.identities.length ? mail.identities : await mail.loadIdentities();
    const ident = defaultIdentity(identities, full);
    const ownEmails = identities.map((i) => i.email.toLowerCase());
    const isOwn = (a: EmailAddress) => ownEmails.includes(a.email.toLowerCase());
    const s = settings();

    let to: EmailAddress[] = [];
    let cc: EmailAddress[] = [];
    if (mode === "reply" || mode === "replyAll") {
      const replyTo = full.replyTo?.length ? full.replyTo : (full.from ?? []);
      to = uniqueAddresses(replyTo);
      if (mode === "replyAll") {
        const others = uniqueAddresses([...(full.to ?? []), ...(full.cc ?? [])]).filter((a) => !isOwn(a) && !to.some((t) => sameAddress(t.email, a.email)));
        cc = others;
        // If the message was sent by me, reply to original recipients instead.
        if (to.every(isOwn) && full.to?.length) {
          to = uniqueAddresses(full.to);
          cc = uniqueAddresses(full.cc ?? []).filter((a) => !isOwn(a));
        }
      } else if (to.every(isOwn) && full.to?.length) {
        to = uniqueAddresses(full.to.filter((a) => !isOwn(a)));
        if (!to.length) to = uniqueAddresses(full.to);
      }
    }

    const htmlPart = full.htmlBody?.[0];
    const textPart = full.textBody?.[0];
    const origHtml = htmlPart?.partId ? (full.bodyValues?.[htmlPart.partId]?.value ?? "") : "";
    const origText = textPart?.partId ? (full.bodyValues?.[textPart.partId]?.value ?? "") : "";
    const accountId = mail.accountId!;
    const attachments: ComposeAttachment[] = [];
    const cidMap: Record<string, string> = {};
    for (const a of full.attachments ?? []) {
      const inline = Boolean(a.cid) && a.type.startsWith("image/");
      if (inline && a.cid && a.blobId) cidMap[a.cid] = client.downloadUrl(accountId, a.blobId, a.name ?? "image", a.type, true);
      if (mode === "forward" || inline) {
        attachments.push({ id: uid("a"), name: a.name ?? "attachment", type: a.type, size: a.size, blobId: a.blobId, progress: 100, error: null, cid: a.cid ?? undefined, inline });
      }
    }
    // Inline images are shown via their blob URLs in the editor and converted back to cid: at send time.
    const quotedHtmlBody = origHtml
      ? sanitizeEmailHtml(origHtml, { cidMap, allowRemote: true, proxyRemote: false }).html
      : textToHtml(origText).replace(/\n/g, "<br>");
    const fromStr = escapeHtml((full.from ?? []).map(formatAddress).join(", "));
    const date = formatFullDate(full.receivedAt);
    let quoteHtml = "";
    let quoteTxt = "";
    if (mode === "forward") {
      const hdr = [
        `From: ${(full.from ?? []).map(formatAddress).join(", ")}`,
        `Date: ${date}`,
        `Subject: ${full.subject ?? ""}`,
        `To: ${(full.to ?? []).map(formatAddress).join(", ")}`,
        ...(full.cc?.length ? [`Cc: ${full.cc.map(formatAddress).join(", ")}`] : []),
      ];
      quoteHtml = `<div class="ihm-quote"><br><div>---------- Forwarded message ---------</div><div>${hdr.map(escapeHtml).join("<br>")}</div><br>${quotedHtmlBody}</div>`;
      quoteTxt = `\n\n---------- Forwarded message ---------\n${hdr.join("\n")}\n\n${origText || (origHtml ? htmlToText(origHtml) : "")}`;
    } else if (s.includeQuote) {
      quoteHtml = `<div class="ihm-quote"><br><div>On ${escapeHtml(date)}, ${fromStr} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quotedHtmlBody}</blockquote></div>`;
      quoteTxt = `\n\nOn ${date}, ${(full.from ?? []).map(formatAddress).join(", ")} wrote:\n${quoteTextOf(origText, origHtml)}`;
    }
    const sigHtml = signatureBlock(ident, "html");
    const sigText = signatureBlock(ident, "text");
    const html = s.signatureAboveQuote ? `<div><br></div>${sigHtml}${quoteHtml}` : `<div><br></div>${quoteHtml}${sigHtml}`;
    const text = s.signatureAboveQuote ? `${sigText}${quoteTxt}` : `${quoteTxt}${sigText}`;
    const messageId = full.messageId?.[0];
    const d = blankDraft({
      identityId: ident?.id ?? null,
      to,
      cc,
      showCc: cc.length > 0,
      replyTo: ident?.replyTo ?? [],
      showReplyTo: Boolean(ident?.replyTo?.length),
      subject: replySubject(full.subject, mode === "forward" ? "Fwd" : "Re"),
      html,
      text,
      format: s.composeFormat,
      attachments,
      inReplyTo: mode === "forward" ? null : messageId ? [messageId] : null,
      references: mode === "forward" ? null : messageId ? [...(full.references ?? []), messageId] : (full.references ?? null),
      relatedEmailId: full.id,
      relatedKeyword: mode === "forward" ? "$forwarded" : "$answered",
      signatureHtml: sigHtml,
      replyMode: mode,
    });
    set((st) => ({ drafts: [...st.drafts, d], activeKey: d.key }));
    return d.key;
  },

  update(key, patch) {
    set((s) => ({ drafts: s.drafts.map((d) => (d.key === key ? { ...d, ...patch, dirty: patch.dirty ?? (d.dirty || isContentPatch(patch)) } : d)) }));
    if (isContentPatch(patch)) scheduleAutosave(key, get);
  },

  async close(key, opts = {}) {
    const d = get().drafts.find((x) => x.key === key);
    if (!d) return;
    const t = autosaveTimers.get(key);
    if (t) window.clearTimeout(t);
    autosaveTimers.delete(key);
    for (const a of d.attachments) a.abort?.abort();
    set((s) => ({ drafts: s.drafts.filter((x) => x.key !== key), activeKey: s.activeKey === key ? (s.drafts.find((x) => x.key !== key)?.key ?? null) : s.activeKey }));
    if (opts.discard) {
      if (d.draftId) {
        try {
          await client.call("Email/set", { accountId: useMail.getState().accountId, destroy: [d.draftId] });
          void useMail.getState().refreshList();
          void useMail.getState().loadMailboxes();
        } catch {
          /* ignore */
        }
      }
      toast.show("Draft discarded");
      return;
    }
    if (d.dirty && (d.to.length || d.subject || hasContent(d))) {
      try {
        await saveDraftInternal(d, get, set, { silent: true, final: true });
        toast.show("Draft saved");
      } catch (err) {
        toast.error(`Could not save draft: ${(err as Error).message}`);
      }
    }
  },

  focus(key) {
    set((s) => ({ activeKey: key, drafts: s.drafts.map((d) => (d.key === key ? { ...d, minimized: false } : d)) }));
  },

  addFiles(key, files) {
    const accountId = useMail.getState().accountId;
    if (!accountId) return;
    const max = client.maxSizeUpload;
    const atts: ComposeAttachment[] = files.map((f) => ({ id: uid("a"), name: f.name, type: f.type || "application/octet-stream", size: f.size, blobId: null, progress: 0, error: f.size > max ? `Larger than ${Math.round(max / 1048576)} MB limit` : null, file: f }));
    get().update(key, { attachments: [...(get().drafts.find((d) => d.key === key)?.attachments ?? []), ...atts] });
    for (const a of atts) {
      if (a.error || !a.file) continue;
      const abort = new AbortController();
      a.abort = abort;
      client
        .upload(accountId, a.file, {
          type: a.type,
          signal: abort.signal,
          onProgress: (loaded, total) => patchAtt(key, a.id, { progress: Math.round((loaded / total) * 100) }, set),
        })
        .then((res) => patchAtt(key, a.id, { blobId: res.blobId, progress: 100, type: res.type || a.type, size: res.size }, set))
        .catch((err) => patchAtt(key, a.id, { error: (err as Error).message || "Upload failed" }, set));
    }
  },

  removeAttachment(key, attId) {
    const d = get().drafts.find((x) => x.key === key);
    const a = d?.attachments.find((x) => x.id === attId);
    a?.abort?.abort();
    get().update(key, { attachments: (d?.attachments ?? []).filter((x) => x.id !== attId) });
  },

  async saveDraft(key, opts = {}) {
    const d = get().drafts.find((x) => x.key === key);
    if (!d) return null;
    try {
      return await saveDraftInternal(d, get, set, { silent: opts.silent ?? false });
    } catch (err) {
      if (!opts.silent) toast.error(`Could not save draft: ${(err as Error).message}`);
      return null;
    }
  },

  async send(key) {
    const d = get().drafts.find((x) => x.key === key);
    if (!d) return;
    const delay = settings().undoSendSeconds;
    // Hide the composer immediately; actually send after the undo window.
    const t = autosaveTimers.get(key);
    if (t) window.clearTimeout(t);
    autosaveTimers.delete(key);
    set((s) => ({ drafts: s.drafts.filter((x) => x.key !== key), activeKey: s.activeKey === key ? null : s.activeKey }));
    const doSend = async () => {
      set((s) => {
        const { [key]: _drop, ...rest } = s.pendingSends;
        return { pendingSends: rest };
      });
      try {
        await sendInternal(d, get);
        toast.success("Message sent");
      } catch (err) {
        toast.error(`Send failed: ${(err as Error).message}`, {
          action: { label: "Open draft", onClick: () => set((s) => ({ drafts: [...s.drafts, { ...d, sending: false, error: (err as Error).message }], activeKey: d.key })) },
          duration: 15000,
        });
      }
    };
    if (delay <= 0) {
      await doSend();
      return;
    }
    const toastId = toast.show("Sending…", { duration: delay * 1000, progress: true, action: { label: "Undo", onClick: () => get().undoSend(key) } });
    const timer = window.setTimeout(() => void doSend(), delay * 1000);
    set((s) => ({ pendingSends: { ...s.pendingSends, [key]: { timer, toastId, draft: d } } }));
  },

  undoSend(key) {
    const p = get().pendingSends[key];
    if (!p) return;
    window.clearTimeout(p.timer);
    toast.dismiss(p.toastId);
    set((s) => {
      const { [key]: _drop, ...rest } = s.pendingSends;
      return { pendingSends: rest, drafts: [...s.drafts, { ...p.draft, sending: false }], activeKey: key };
    });
  },

  setIdentity(key, identityId) {
    const d = get().drafts.find((x) => x.key === key);
    if (!d) return;
    const ident = useMail.getState().identities.find((i) => i.id === identityId);
    const newSig = signatureBlock(ident, "html");
    let html = d.html;
    if (d.signatureHtml && html.includes(d.signatureHtml)) html = html.replace(d.signatureHtml, newSig);
    else if (!d.signatureHtml && newSig) {
      // insert before quote if any, else append
      const idx = html.indexOf('<div class="ihm-quote">');
      html = idx >= 0 ? html.slice(0, idx) + newSig + html.slice(idx) : html + newSig;
    }
    // Plain text: replace trailing signature block
    const oldSigText = signatureBlock(useMail.getState().identities.find((i) => i.id === d.identityId), "text");
    let text = d.text;
    if (oldSigText && text.includes(oldSigText)) text = text.replace(oldSigText, signatureBlock(ident, "text"));
    const oldIdent = useMail.getState().identities.find((i) => i.id === d.identityId);
    const sameList = (a: EmailAddress[], b: EmailAddress[]) => a.length === b.length && a.every((x, i) => sameAddress(x.email, b[i]?.email));
    const replyToPatch = sameList(d.replyTo, oldIdent?.replyTo ?? []) ? { replyTo: ident?.replyTo ?? [], showReplyTo: d.showReplyTo || Boolean(ident?.replyTo?.length) } : {};
    get().update(key, { identityId, html, text, signatureHtml: newSig, ...replyToPatch });
  },

  insertTemplate(key, html, subject) {
    const d = get().drafts.find((x) => x.key === key);
    if (!d) return;
    const patch: Partial<Draft> = { html: `<div>${sanitizeEditorHtml(html)}</div>${d.html}`, text: `${htmlToText(html)}\n${d.text}` };
    if (subject && !d.subject) patch.subject = subject;
    get().update(key, patch);
  },
}));

function quoteTextOf(text: string, html: string): string {
  const base = text || (html ? htmlToText(html) : "");
  return quoteText(base);
}

function isContentPatch(p: Partial<Draft>): boolean {
  return ["to", "cc", "bcc", "replyTo", "subject", "html", "text", "attachments", "identityId", "format", "priority", "requestReceipt"].some((k) => k in p);
}

function hasContent(d: Draft): boolean {
  const body = d.format === "html" ? htmlToText(d.html.replace(/<div class="ihm-quote">[\s\S]*$/, "")) : d.text;
  return body.replace(/--\s*[\s\S]*$/, "").trim().length > 0 || d.attachments.length > 0;
}

function patchAtt(key: string, attId: string, patch: Partial<ComposeAttachment>, set: (fn: (s: ComposeState) => Partial<ComposeState>) => void) {
  set((s) => ({ drafts: s.drafts.map((d) => (d.key === key ? { ...d, dirty: true, attachments: d.attachments.map((a) => (a.id === attId ? { ...a, ...patch } : a)) } : d)) }));
}

function scheduleAutosave(key: string, get: () => ComposeState) {
  const t = autosaveTimers.get(key);
  if (t) window.clearTimeout(t);
  autosaveTimers.set(
    key,
    window.setTimeout(() => {
      autosaveTimers.delete(key);
      const d = get().drafts.find((x) => x.key === key);
      if (d && d.dirty && !d.sending && (d.to.length || d.subject || hasContent(d))) void get().saveDraft(key, { silent: true });
    }, AUTOSAVE_MS),
  );
}

/** Build the JMAP Email creation object from a draft. */
async function buildEmailObject(d: Draft, opts: { forSend: boolean }): Promise<Record<string, unknown>> {
  const mail = useMail.getState();
  const accountId = mail.accountId!;
  const ident = mail.identities.find((i) => i.id === d.identityId) ?? mail.identities[0];
  if (!ident) throw new Error("No sending identity available");
  const from: EmailAddress = { name: ident.name || null, email: ident.email };

  let html = d.format === "html" ? d.html : "";
  const text = d.format === "html" ? htmlToText(d.html) : d.text;

  // Inline attachments shown via blob URLs in the editor → back to cid: references.
  for (const a of d.attachments) {
    if (a.inline && a.cid && a.blobId && html) {
      const re = new RegExp(`/api/blob/[^"' )]*${a.blobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"' )]*`, "g");
      html = html.replace(re, `cid:${a.cid}`);
    }
  }
  // Inline images (data: URLs from the editor) → upload and reference by cid.
  const related: EmailBodyPart[] = [];
  const relatedInline: Array<{ blobId: Id; type: string; name: string; cid: string }> = [];
  // Images referencing stored blobs (e.g. signature logos kept in Files) → inline cid parts.
  if (html && html.includes("/api/blob/")) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const m = /^\/api\/blob\/([^/]+)\/([^/]+)\/([^?]+)(?:\?([^#]*))?/.exec(src);
      if (!m) continue;
      const blobId = decodeURIComponent(m[2]!);
      const name = decodeURIComponent(m[3]!);
      const type = new URLSearchParams(m[4] ?? "").get("accept") ?? "image/png";
      const cid = `${uid("img")}@ihasmail`;
      img.setAttribute("src", `cid:${cid}`);
      relatedInline.push({ blobId, type, name, cid });
    }
    html = doc.body.innerHTML;
  }
  if (html && html.includes("data:image/")) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = Array.from(doc.querySelectorAll("img")).filter((i) => i.getAttribute("src")?.startsWith("data:image/"));
    for (const img of imgs) {
      const src = img.getAttribute("src")!;
      const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src);
      if (!m) continue;
      const bin = atob(m[2]!);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const up = await client.upload(accountId, new Blob([bytes], { type: m[1]! }), { type: m[1]! });
      const cid = `${uid("img")}@ihasmail`;
      img.setAttribute("src", `cid:${cid}`);
      relatedInline.push({ blobId: up.blobId, type: m[1]!, name: `image.${m[1]!.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`, cid });
    }
    html = doc.body.innerHTML;
  }
  // Existing inline attachments referenced via cid (from reply/forward/draft) stay as related parts.
  for (const a of d.attachments) {
    if (a.inline && a.cid && a.blobId && html.includes(`cid:${a.cid}`)) relatedInline.push({ blobId: a.blobId, type: a.type, name: a.name, cid: a.cid });
  }
  for (const r of relatedInline) {
    related.push({ partId: null, blobId: r.blobId, size: 0, name: r.name, type: r.type, charset: null, disposition: "inline", cid: r.cid });
  }

  const bodyValues: Record<string, { value: string }> = {};
  const alternative: Record<string, unknown>[] = [];
  bodyValues.text = { value: text };
  alternative.push({ partId: "text", type: "text/plain" });
  if (html) {
    bodyValues.html = { value: wrapHtmlDocument(html) };
    const htmlPart: Record<string, unknown> = { partId: "html", type: "text/html" };
    if (related.length) alternative.push({ type: "multipart/related", subParts: [htmlPart, ...related.map(stripPart)] });
    else alternative.push(htmlPart);
  }
  const regular = d.attachments.filter((a) => !a.inline && a.blobId && !a.error);
  let bodyStructure: Record<string, unknown>;
  const alt = html ? { type: "multipart/alternative", subParts: alternative } : alternative[0]!;
  if (regular.length) {
    bodyStructure = { type: "multipart/mixed", subParts: [alt, ...regular.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: "attachment" }))] };
  } else bodyStructure = alt;

  const obj: Record<string, unknown> = {
    from: [from],
    to: d.to.length ? d.to : null,
    cc: d.cc.length ? d.cc : null,
    bcc: d.bcc.length ? d.bcc : null,
    replyTo: d.replyTo.length ? d.replyTo : ident.replyTo?.length ? ident.replyTo : null,
    subject: d.subject,
    sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    inReplyTo: d.inReplyTo,
    references: d.references,
    bodyStructure,
    bodyValues,
    "header:User-Agent:asText": "ihasmail/2.0",
  };
  if (d.priority === "high") {
    obj["header:X-Priority:asText"] = "1 (Highest)";
    obj["header:Importance:asText"] = "High";
  } else if (d.priority === "low") {
    obj["header:X-Priority:asText"] = "5 (Lowest)";
    obj["header:Importance:asText"] = "Low";
  }
  if (d.requestReceipt) obj["header:Disposition-Notification-To:asAddresses"] = [from];
  if (!opts.forSend) {
    const draftsId = mail.roleId("drafts");
    obj.mailboxIds = draftsId ? { [draftsId]: true } : { [mail.roleId("inbox")!]: true };
    obj.keywords = { $draft: true, $seen: true };
  } else {
    const sentId = mail.roleId("sent") ?? mail.roleId("inbox");
    obj.mailboxIds = { [sentId!]: true };
    obj.keywords = { $seen: true };
  }
  return obj;
}

function stripPart(p: EmailBodyPart): Record<string, unknown> {
  return { blobId: p.blobId, type: p.type, name: p.name, disposition: p.disposition, cid: p.cid };
}

function wrapHtmlDocument(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;">${body}</body></html>`;
}

async function saveDraftInternal(d: Draft, get: () => ComposeState, set: (fn: (s: ComposeState) => Partial<ComposeState>) => void, opts: { silent: boolean; final?: boolean }): Promise<Id | null> {
  const mail = useMail.getState();
  const accountId = mail.accountId!;
  if (!opts.final) set((s) => ({ drafts: s.drafts.map((x) => (x.key === d.key ? { ...x, saving: true } : x)) }));
  try {
    const email = await buildEmailObject(d, { forSend: false });
    const args: Record<string, unknown> = { accountId, create: { draft: email } };
    if (d.draftId) args.destroy = [d.draftId];
    const res = await client.call<SetResponse<Email>>("Email/set", args);
    const err = res.notCreated?.draft;
    if (err) throw new Error(setErrorMessage(err));
    const newId = res.created?.draft?.id ?? null;
    if (!opts.final) set((s) => ({ drafts: s.drafts.map((x) => (x.key === d.key ? { ...x, draftId: newId, saving: false, dirty: false, savedAt: Date.now(), error: null } : x)) }));
    void mail.loadMailboxes();
    if (mail.list?.mailboxId && mail.list.mailboxId === mail.roleId("drafts")) void mail.refreshList();
    return newId;
  } catch (err) {
    if (!opts.final) set((s) => ({ drafts: s.drafts.map((x) => (x.key === d.key ? { ...x, saving: false, error: (err as Error).message } : x)) }));
    throw err;
  }
}

async function sendInternal(d: Draft, _get: () => ComposeState): Promise<void> {
  const mail = useMail.getState();
  const accountId = mail.accountId!;
  const ident = mail.identities.find((i) => i.id === d.identityId) ?? mail.identities[0];
  if (!ident) throw new Error("No sending identity available");
  if (d.attachments.some((a) => !a.blobId && !a.error)) throw new Error("Attachments are still uploading");
  const email = await buildEmailObject(d, { forSend: true });
  const sentId = mail.roleId("sent");
  const draftsId = mail.roleId("drafts");
  const onSuccess: Record<string, unknown> = { "keywords/$draft": null, "keywords/$seen": true };
  if (sentId) onSuccess[`mailboxIds/${sentId}`] = true;
  if (draftsId) onSuccess[`mailboxIds/${draftsId}`] = null;
  const rcpts = uniqueAddresses([...d.to, ...d.cc, ...d.bcc]).map((a) => ({ email: a.email }));
  if (!rcpts.length) throw new Error("No recipients");
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ["Email/set", { accountId, create: { m: email }, ...(d.draftId ? { destroy: [d.draftId] } : {}) }, "e"],
    [
      "EmailSubmission/set",
      {
        accountId,
        create: { s: { identityId: ident.id, emailId: "#m", envelope: { mailFrom: { email: ident.email }, rcptTo: rcpts } } },
        onSuccessUpdateEmail: { "#s": onSuccess },
      },
      "s",
    ],
  ];
  if (d.relatedEmailId && d.relatedKeyword) {
    calls.push(["Email/set", { accountId, update: { [d.relatedEmailId]: { [`keywords/${d.relatedKeyword}`]: true } } }, "k"]);
  }
  const res = await client.chain(calls, { allowErrors: true });
  const e = res.get("e")?.[0] as unknown as SetResponse<Email> & { __error?: { type: string; description?: string } };
  if (e.__error) throw new Error(setErrorMessage(e.__error));
  if (e.notCreated?.m) throw new Error(setErrorMessage(e.notCreated.m));
  const s = res.get("s")?.[0] as unknown as SetResponse & { __error?: { type: string; description?: string } };
  if (s.__error) throw new Error(setErrorMessage(s.__error));
  if (s.notCreated?.s) {
    const err = s.notCreated.s;
    // Clean up the created (unsent) email so it doesn't linger in Sent.
    const created = e.created?.m?.id;
    if (created) void client.call("Email/set", { accountId, destroy: [created] });
    throw new Error(setErrorMessage(err));
  }
  if (d.relatedEmailId && d.relatedKeyword) {
    useMail.setState((st) => {
      const cur = st.emails[d.relatedEmailId!];
      return cur ? { emails: { ...st.emails, [d.relatedEmailId!]: { ...cur, keywords: { ...cur.keywords, [d.relatedKeyword!]: true } } } } : {};
    });
  }
  void mail.loadMailboxes();
  void mail.refreshList();
}

export { FULL_PROPS, BODY_PROPS };

/** Composer fields for a `mailto:` URL, including cc/bcc and a quoted body. */
export function draftFromMailto(url: string): Partial<Draft> {
  const m = parseMailto(url);
  const body = m.body ? `<div>${escapeHtml(m.body).replace(/\n/g, "<br>")}</div>` : "";
  return {
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    showCc: m.cc.length > 0,
    showBcc: m.bcc.length > 0,
    subject: m.subject,
    ...(body ? { html: body, text: m.body } : {}),
  };
}
