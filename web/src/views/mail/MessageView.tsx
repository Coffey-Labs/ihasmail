import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, ExternalLink, Forward, MoreVertical, Printer, Reply, ReplyAll, Star, Trash2, Code, FileText, Image as ImageIcon, File, Eye, Calendar, CalendarPlus, UserPlus, ShieldAlert, Mail, Ban, Clock, CheckCheck, Paperclip, FileArchive, FileSpreadsheet, Film, Music, Filter } from "lucide-react";
import { useLocation } from "wouter";
import { FilterFromMessageDialog } from "./FilterFromMessage";
import type { Email, EmailAddress, EmailBodyPart, Id } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { draftFromMailto, useCompose } from "@/store/compose";
import { useContacts } from "@/store/contacts";
import { useCalendar } from "@/store/calendar";
import { startAppointment } from "@/lib/appointment";
import { client } from "@/jmap/client";
import { formatFullDate, formatListDate, formatSize } from "@/lib/format";
import { displayName, formatAddress } from "@/lib/address";
import { EMAIL_BASE_CSS, TEXT_EMAIL_CSS, htmlDeclaresColors, sanitizeEmailHtml } from "@/lib/html";
import { findQuoteStart, textToHtml } from "@/lib/text";
import { Avatar } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import type { ListActions } from "./MessageList";
import { InviteCard } from "./InviteCard";
import { VCardCard } from "./VCardCard";
import { AddressList, useAddressMenu } from "./AddressMenu";
import { useSession } from "@/store/session";
import { useScheduled } from "@/store/scheduled";
import { formatScheduleTime } from "@/lib/schedule";
import { mdnDecision, refusalText } from "@/lib/mdn";
import { sendReadReceipt } from "@/store/mdn";
import { t as translate, tNode } from "@/lib/i18n";

interface Props {
  email: Email;
  expanded: boolean;
  /** Unread when the conversation was opened, which is what the bar marks. */
  wasUnread?: boolean;
  onToggle: () => void;
  isLast: boolean;
  actions: ListActions;
}

export const MessageView = memo(function MessageView({ email: e, expanded, wasUnread, onToggle, actions }: Props) {
  const accountId = useMail((s) => s.accountId)!;
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);
  const reply = useCompose((s) => s.reply);
  const [details, setDetails] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [allowRemote, setAllowRemote] = useState(false);
  /* Stable, so the body's click handler keeps its identity between renders.
     Passing an inline arrow here is what made the handler change on every
     render in the first place. */
  const showImages = useCallback(() => setAllowRemote(true), []);
  const [filterOpen, setFilterOpen] = useState(false);
  const moreMenu = useMenu();
  const [, navigate] = useLocation();
  /** Only offered where there is a calendar to put the appointment in. */
  const hasCalendar = useCalendar((s) => s.available);
  const addrMenu = useAddressMenu();
  const from = e.from?.[0];
  const senderTrusted = settings.trustedImageSenders.includes((from?.email ?? "").toLowerCase());
  const inContacts = useContacts((s) => Boolean(from && s.loaded && s.lookupByEmail(from.email)));
  const remoteAllowed = allowRemote || settings.imagePolicy === "always" || senderTrusted || (settings.imagePolicy === "contacts" && inContacts);
  const imageProxy = useSession((s) => s.session?.ihasmail?.imageProxy ?? true);
  const scheduled = useScheduled((s) => s.pending[e.id]);
  const receipt = useMemo(() => mdnDecision(e), [e]);
  const [receiptDone, setReceiptDone] = useState<"sending" | "dismissed" | null>(null);
  const cancelScheduled = useScheduled((s) => s.cancel);

  const htmlPart = e.htmlBody?.[0];
  const textPart = e.textBody?.[0];
  const htmlRaw = htmlPart?.partId ? e.bodyValues?.[htmlPart.partId]?.value : undefined;
  const textRaw = textPart?.partId ? e.bodyValues?.[textPart.partId]?.value : undefined;
  const showHtml = Boolean(htmlRaw);
  const themeMessageBody = settings.themeMessageBody;

  // Inline images map
  const cidMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of e.attachments ?? []) if (a.cid && a.blobId) map[a.cid] = client.downloadUrl(accountId, a.blobId, a.name ?? "image", a.type, true);
    const walk = (p?: EmailBodyPart) => {
      if (!p) return;
      if (p.cid && p.blobId && !map[p.cid]) map[p.cid] = client.downloadUrl(accountId, p.blobId, p.name ?? "image", p.type, true);
      p.subParts?.forEach(walk);
    };
    walk(e.bodyStructure);
    return map;
  }, [e.attachments, e.bodyStructure, accountId]);

  const rendered = useMemo(() => {
    if (!expanded) return null;
    if (showHtml) return sanitizeEmailHtml(htmlRaw!, { cidMap, allowRemote: remoteAllowed, proxyRemote: imageProxy });
    return null;
  }, [expanded, showHtml, htmlRaw, cidMap, remoteAllowed, imageProxy]);

  // Mail that paints itself keeps the light card it was designed for; the rest
  // can follow the app theme when the user has asked for that.
  const themed = useMemo(
    () => themeMessageBody && Boolean(rendered) && !htmlDeclaresColors(rendered!.html, rendered!.bodyStyle),
    [themeMessageBody, rendered],
  );

  const attachments = useMemo(() => (e.attachments ?? []).filter((a) => !(a.cid && a.disposition === "inline" && a.type.startsWith("image/") && htmlRaw?.includes(`cid:${a.cid}`))), [e.attachments, htmlRaw]);
  const icsPart = useMemo(() => findPart(e.bodyStructure, (p) => p.type === "text/calendar" || (p.name ?? "").toLowerCase().endsWith(".ics")), [e.bodyStructure]);
  const vcfParts = useMemo(() => (e.attachments ?? []).filter((p) => p.type === "text/vcard" || p.type === "text/x-vcard" || (p.name ?? "").toLowerCase().endsWith(".vcf")), [e.attachments]);
  const unsubscribe = e["header:List-Unsubscribe:asText"];
  const isHighPriority = /^[12]/.test(e["header:X-Priority:asText"] ?? "") || /high/i.test(e["header:Importance:asText"] ?? "");
  const receiptRequested = Boolean(e["header:Disposition-Notification-To:asAddresses"]?.length);
  const authFailed = /\b(dkim|spf|dmarc)=fail\b/i.test(e["header:Authentication-Results:asText"] ?? "");

  const openSource = async () => {
    setShowSource(true);
    if (source === null) {
      try {
        setSource(await client.fetchBlobText(accountId, e.blobId, "message/rfc822"));
      } catch (err) {
        setSource(translate("Could not load source: {error}", { error: (err as Error).message }));
      }
    }
  };

  const downloadEml = () => {
    const a = document.createElement("a");
    a.href = client.downloadUrl(accountId, e.blobId, `${(e.subject || "message").replace(/[^\w.-]+/g, "_")}.eml`, "message/rfc822");
    a.download = "";
    a.click();
  };

  const onUnsubscribe = async () => {
    if (!unsubscribe) return;
    const urls = [...unsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
    const mailto = urls.find((u) => u.startsWith("mailto:"));
    const http = urls.find((u) => /^https?:/i.test(u));
    if (mailto) {
      const fields = draftFromMailto(mailto);
      useCompose.getState().open({ ...fields, subject: fields.subject || "unsubscribe", html: fields.html ?? "<div>unsubscribe</div>", text: fields.text ?? "unsubscribe" });
      toast.show(translate("Unsubscribe message prepared — just hit Send"));
    } else if (http) {
      window.open(http, "_blank", "noopener,noreferrer");
    }
  };

  const collapsedClick = () => {
    if (!expanded) onToggle();
  };

  return (
    /* `wasUnread` rather than `$seen`: the bar marks what was unread when the
       conversation was opened, and keeps marking it after the auto-mark-read
       timer has told the server otherwise. Losing it mid-read was half of #69. */
    <article className={`message ${expanded ? "" : "collapsed"} ${wasUnread ?? !e.keywords.$seen ? "unread-msg" : ""}`} data-msg-id={e.id} onClick={collapsedClick}>
      <header className="message-head" onClick={(ev) => { if (expanded && !(ev.target as HTMLElement).closest("button,a,.message-details")) onToggle(); }}>
        <Avatar who={from ?? null} />
        <div className="who">
          <div className="from" onContextMenu={(ev) => from && addrMenu.open(ev, from)}>
            <span className="addr notranslate" translate="no">{displayName(from)}</span>
            {/* An address, not a sentence. */}
            {expanded && from && <span className="email addr notranslate" translate="no">&lt;{from.email}&gt;</span>}
            {isHighPriority && <span className="tag" style={{ background: "var(--danger)" }}>{translate("Important")}</span>}
            {authFailed && <span className="tag" style={{ background: "var(--warn)" }} title={e["header:Authentication-Results:asText"] ?? ""}><ShieldAlert size={12} />  {translate("Unverified")}</span>}
          </div>
          {expanded ? (
            <div className="to">
              <span className="truncate">{translate("to {recipients}", { recipients: summarizeRecipients(e) })}</span>
              <button onClick={(ev) => { ev.stopPropagation(); setDetails((v) => !v); }} aria-label={translate("Show details")} title={translate("Show details")}>
                {details ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
          ) : (
            <div className="snippet">{e.preview}</div>
          )}
        </div>
        <div className="meta">
          {e.hasAttachment && !expanded && <Paperclip size={14} />}
          <span className="date" title={formatFullDate(e.receivedAt)}>{expanded ? formatFullDate(e.receivedAt) : formatListDate(e.receivedAt)}</span>
          <button className={`icon-btn sm ${e.keywords.$flagged ? "active" : ""}`} style={e.keywords.$flagged ? { color: "var(--star)", background: "transparent" } : undefined} title={translate("Star")} onClick={(ev) => { ev.stopPropagation(); void actions.star(!e.keywords.$flagged, [e.id]); }}>
            <Star size={17} fill={e.keywords.$flagged ? "currentColor" : "none"} />
          </button>
          {expanded && (
            <>
              <button className="icon-btn sm hide-mobile" title={translate("Reply (r)")} onClick={(ev) => { ev.stopPropagation(); void reply(e, "reply"); }}><Reply size={17} /></button>
              <button className="icon-btn sm" onClick={(ev) => { ev.stopPropagation(); moreMenu.open(ev); }} aria-label={translate("More")}><MoreVertical size={17} /></button>
            </>
          )}
        </div>
      </header>
      <Popover anchor={moreMenu.anchor} onClose={moreMenu.close} align="end" width={240}>
        <MenuItem icon={<Reply size={16} />} label={translate("Reply")} onClick={() => void reply(e, "reply")} />
        <MenuItem icon={<ReplyAll size={16} />} label={translate("Reply all")} onClick={() => void reply(e, "replyAll")} />
        <MenuItem icon={<Forward size={16} />} label={translate("Forward")} onClick={() => void reply(e, "forward")} />
        <MenuSep />
        <MenuItem icon={<Mail size={16} />} label={e.keywords.$seen ? "Mark as unread" : "Mark as read"} onClick={() => void useMail.getState().markRead([e.id], !e.keywords.$seen)} />
        <MenuItem icon={<Trash2 size={16} />} label={translate("Delete this message")} onClick={() => void useMail.getState().trash([e.id])} />
        <MenuSep />
        <MenuItem icon={<Eye size={16} />} label={translate("Show original")} onClick={() => void openSource()} />
        <MenuItem icon={<Code size={16} />} label={translate("Show headers")} onClick={() => setShowHeaders(true)} />
        <MenuItem icon={<Download size={16} />} label={translate("Download (.eml)")} onClick={downloadEml} />
        <MenuItem icon={<Printer size={16} />} label={translate("Print")} onClick={() => window.print()} />
        <MenuItem icon={<Filter size={16} />} label={translate("Filter messages like this…")} onClick={() => setFilterOpen(true)} />
        {hasCalendar && <MenuItem icon={<CalendarPlus size={16} />} label={translate("Create event…")} onClick={() => void startAppointment(e, navigate).catch((err: unknown) => toast.error((err as Error).message))} />}
        {from && (
          <>
            <MenuSep />
            <MenuItem icon={<Ban size={16} />} label={senderTrusted ? "Stop trusting sender images" : "Always show images from sender"} onClick={() => updateSettings({ trustedImageSenders: senderTrusted ? settings.trustedImageSenders.filter((x) => x !== from.email.toLowerCase()) : [...settings.trustedImageSenders, from.email.toLowerCase()] })} />
          </>
        )}
      </Popover>

      {expanded && (
        <>
          {details && (
            <dl className="message-details" onClick={(ev) => ev.stopPropagation()}>
              <dt>{translate("From")}</dt><dd><AddressList list={e.from} onContext={addrMenu.open} /></dd>
              {e.sender?.length && !(e.sender.length === 1 && e.from?.some((f) => f.email === e.sender![0]!.email)) ? <><dt>{translate("Sender")}</dt><dd><AddressList list={e.sender} onContext={addrMenu.open} /></dd></> : null}
              {e.replyTo?.length ? <><dt>{translate("Reply-To")}</dt><dd><AddressList list={e.replyTo} onContext={addrMenu.open} /></dd></> : null}
              <dt>{translate("To")}</dt><dd><AddressList list={e.to} onContext={addrMenu.open} /></dd>
              {e.cc?.length ? <><dt>{translate("Cc")}</dt><dd><AddressList list={e.cc} onContext={addrMenu.open} /></dd></> : null}
              {e.bcc?.length ? <><dt>{translate("Bcc")}</dt><dd><AddressList list={e.bcc} onContext={addrMenu.open} /></dd></> : null}
              <dt>{translate("Date")}</dt><dd>{formatFullDate(e.sentAt ?? e.receivedAt)}</dd>
              <dt>{translate("Subject")}</dt><dd>{e.subject || translate("(no subject)")}</dd>
              {e.messageId?.[0] && <><dt>{translate("Message-ID")}</dt><dd className="mono small">{e.messageId[0]}</dd></>}
              {e["header:List-Id:asText"] && <><dt>{translate("List")}</dt><dd>{e["header:List-Id:asText"]}</dd></>}
              <dt>{translate("Size")}</dt><dd>{formatSize(e.size)}</dd>
              {receiptRequested && <><dt>{translate("Receipt")}</dt><dd>{receipt.offer ? `Requested, to ${receipt.to!.email}. Never sent automatically.` : refusalText(receipt.refusal!)}</dd></>}
            </dl>
          )}
          {receipt.offer && settings.readReceiptPolicy !== "never" && receiptDone !== "dismissed" && (
            <div className="receipt-banner" style={{ margin: "0 16px 8px" }}>
              <CheckCheck size={16} />
              <span className="grow">
                
                {translate("The sender asked for a read receipt.")}
                {receipt.redirected && (
                  <>{tNode("It would go to {address}, which is not where the message came from.", { address: <strong className="notranslate" translate="no">{receipt.to!.email}</strong> })}</>
                )}
              </span>
              <button
                disabled={receiptDone === "sending"}
                onClick={async () => {
                  setReceiptDone("sending");
                  try {
                    await sendReadReceipt(e);
                    toast.success(translate("Read receipt sent"));
                  } catch (err) {
                    setReceiptDone(null);
                    toast.error(translate("Could not send the receipt: {error}", { error: (err as Error).message }));
                  }
                }}
              >
                {receiptDone === "sending" ? "Sending…" : "Send receipt"}
              </button>
              <button onClick={() => setReceiptDone("dismissed")}>{translate("Not this time")}</button>
            </div>
          )}
          {scheduled && (
            <div className="scheduled-banner" style={{ margin: "0 16px 8px" }}>
              <Clock size={16} />
              <span className="grow">{translate("Waiting on the server — goes out {when}.", { when: formatScheduleTime(new Date(scheduled.sendAt)) })}</span>
              <button
                onClick={async () => {
                  try {
                    await cancelScheduled(e.id);
                    toast.success(translate("Send cancelled — the message is back in Drafts"));
                  } catch (err) {
                    toast.error(translate("Could not cancel: {error}", { error: (err as Error).message }));
                  }
                }}
              >
                
                {translate("Cancel send")}
              </button>
            </div>
          )}
          {rendered && rendered.remoteCount > 0 && !remoteAllowed && (
            <div className="remote-banner" style={{ margin: "0 16px 8px" }}>
              <ImageIcon size={16} />
              <span className="grow">{translate("Remote images are blocked to protect your privacy.")}</span>
              <button onClick={() => setAllowRemote(true)}>{translate("Show images")}</button>
              {from && <button onClick={() => updateSettings({ trustedImageSenders: [...settings.trustedImageSenders, from.email.toLowerCase()] })}>{translate("Always from {email}", { email: from.email })}</button>}
            </div>
          )}
          {icsPart && <InviteCard email={e} part={icsPart} />}
          {vcfParts.map((p) => <VCardCard key={p.blobId ?? p.partId ?? ""} part={p} accountId={accountId} />)}
          <div className="message-body">
            {showHtml && rendered ? <HtmlBody html={rendered.html} bodyStyle={rendered.bodyStyle} themed={themed} onShowImages={showImages} /> : <TextBody text={textRaw ?? ""} />}
          </div>
          {attachments.length > 0 && <AttachmentList attachments={attachments} accountId={accountId} email={e} />}
          {unsubscribe && (
            <div className="unsubscribe-row">
              <span>{translate("This looks like a mailing list.")}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => void onUnsubscribe()}>{translate("Unsubscribe")}</button>
            </div>
          )}
        </>
      )}
      {addrMenu.node}
      {filterOpen && <FilterFromMessageDialog email={e} mailboxId={Object.keys(e.mailboxIds)[0] ?? null} onClose={() => setFilterOpen(false)} />}
      <Dialog open={showSource} onClose={() => setShowSource(false)} title={translate("Original message")} size="xl">
        {source === null ? <div className="center"><span className="spinner" /></div> : <pre className="code notranslate" translate="no" style={{ minHeight: 300, maxHeight: "65vh" }}>{source}</pre>}
      </Dialog>
      <Dialog open={showHeaders} onClose={() => setShowHeaders(false)} title={translate("Message headers")} size="lg">
        <dl className="message-details" style={{ margin: 0 }}>
          {Object.entries(e).filter(([k]) => k.startsWith("header:")).map(([k, v]) => (
            <>
              <dt key={`${k}-t`}>{k.split(":")[1]}</dt>
              <dd key={`${k}-d`} className="mono small">{Array.isArray(v) ? v.map((x: unknown) => (typeof x === "object" && x ? formatAddress(x as EmailAddress) : String(x))).join(", ") : String(v ?? "—")}</dd>
            </>
          ))}
          <dt>{translate("Received")}</dt><dd>{formatFullDate(e.receivedAt)}</dd>
          {e.inReplyTo?.length ? <><dt>{translate("In-Reply-To")}</dt><dd className="mono small">{e.inReplyTo.join(" ")}</dd></> : null}
          {e.references?.length ? <><dt>{translate("References")}</dt><dd className="mono small">{e.references.join(" ")}</dd></> : null}
        </dl>
        <p className="hint">{translate("Use “Show original” for the complete raw message.")}</p>
      </Dialog>
    </article>
  );
});

function summarizeRecipients(e: Email): string {
  const all = [...(e.to ?? []), ...(e.cc ?? [])];
  if (!all.length) return "(undisclosed recipients)";
  const me = useMail.getState().identities.map((i) => i.email.toLowerCase());
  const names = all.map((a) => (me.includes(a.email.toLowerCase()) ? "me" : displayName(a).split(" ")[0] || a.email));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function findPart(p: EmailBodyPart | undefined, pred: (p: EmailBodyPart) => boolean): EmailBodyPart | null {
  if (!p) return null;
  if (pred(p)) return p;
  for (const s of p.subParts ?? []) {
    const r = findPart(s, pred);
    if (r) return r;
  }
  return null;
}

/* ---------- Body renderers ---------- */

const QUOTE_SELECTORS = [".gmail_quote", "blockquote[type=cite]", ".moz-cite-prefix", "#divRplyFwdMsg", ".yahoo_quoted", "div[id^=appendonsend]", ".ms-outlook-mobile-reference-message", "#OLK_SRC_BODY_SECTION", ".protonmail_quote", ".ihm-quote"];

function HtmlBody({ html, bodyStyle, themed, onShowImages }: { html: string; bodyStyle: string; themed: boolean; onShowImages: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hasQuote, setHasQuote] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const openCompose = useCompose((s) => s.open);

  const onClick = useCallback(
    (ev: Event) => {
      const t = ev.target as HTMLElement;
      const a = t.closest("a");
      if (a) {
        const href = a.getAttribute("href") ?? "";
        if (href.startsWith("mailto:")) {
          ev.preventDefault();
          openCompose(draftFromMailto(href));
          return;
        }
        if (/^(javascript|data|vbscript):/i.test(href)) {
          ev.preventDefault();
          return;
        }
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer nofollow");
      }
      const img = t.closest("img[data-ihm-blocked]");
      if (img) onShowImages();
    },
    [openCompose, onShowImages],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    host.classList.toggle("themed", themed);
    root.innerHTML = `<style>${EMAIL_BASE_CSS}</style><div class="ihm-email-root${themed ? " themed" : ""}" style="${bodyStyle.replace(/"/g, "'")}">${html}</div>`;
    // Collapse quoted content
    const container = root.querySelector(".ihm-email-root") as HTMLElement | null;
    let found = false;
    if (container) {
      let q: Element | null = null;
      for (const sel of QUOTE_SELECTORS) {
        q = container.querySelector(sel);
        if (q) break;
      }
      if (!q) {
        // Heuristic: a blockquote preceded by text ending in "wrote:"
        const bqs = Array.from(container.querySelectorAll("blockquote"));
        for (const bq of bqs) {
          const prev = bq.previousElementSibling;
          if (prev && /wrote:\s*$|Original Message|Von:|De :|From:/i.test(prev.textContent ?? "")) {
            q = prev;
            break;
          }
        }
        if (!q && bqs.length === 1 && (bqs[0]!.textContent?.length ?? 0) > 200) q = bqs[0]!;
      }
      if (q && q.parentElement) {
        // Move q and subsequent siblings into a hidden wrapper (only if q isn't the whole body)
        const parent = q.parentElement;
        const textBefore = (container.textContent ?? "").indexOf((q.textContent ?? "").slice(0, 40));
        if (textBefore > 0 || q.previousElementSibling) {
          const wrap = root.ownerDocument.createElement("div");
          wrap.className = "ihm-quoted";
          wrap.hidden = true;
          const nodes: ChildNode[] = [];
          let n: ChildNode | null = q.classList.contains("moz-cite-prefix") ? q : q;
          while (n) {
            nodes.push(n);
            n = n.nextSibling;
          }
          parent.insertBefore(wrap, q);
          for (const node of nodes) wrap.appendChild(node);
          found = true;
        }
      }
    }
    setHasQuote(found);
    setQuoteOpen(false);
    /*
     * `onClick` is deliberately not a dependency of this effect.
     *
     * This is the effect that writes the body into the shadow root, so anything
     * in its dependencies rebuilds the entire message. The click handler used
     * to be in here, and it changes identity on every render -- it closes over
     * a prop the parent recreates inline -- so every render of the message
     * threw the rendered body away and built it again. Marking as read does
     * exactly that: the store hands back a new email object, the thread
     * re-renders, and the reader watched the message vanish and come back,
     * white to dark to white on an unstyled HTML mail, half a second after they
     * started reading it (#100). The quoted-text toggle reset with it.
     *
     * The listener lives in its own effect below. It is attached to the shadow
     * root rather than to its contents, which survives this rewriting anyway,
     * so a changing handler now costs a listener swap and nothing else.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, bodyStyle, themed]);

  useEffect(() => {
    const root = hostRef.current?.shadowRoot;
    if (!root) return;
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [onClick]);

  useEffect(() => {
    const root = hostRef.current?.shadowRoot;
    const q = root?.querySelector<HTMLElement>(".ihm-quoted");
    if (q) q.hidden = !quoteOpen;
  }, [quoteOpen]);

  return (
    <>
      {/* The sender's content, rendered as-is. Translating it would
          rewrite what someone actually wrote. */}
      <div ref={hostRef} className="body-host notranslate" translate="no" />
      {hasQuote && (
        <button className="quote-toggle" onClick={() => setQuoteOpen((v) => !v)} title={quoteOpen ? translate("Hide quoted text") : translate("Show quoted text")}>
          {quoteOpen ? <ChevronUp size={12} /> : <span style={{ letterSpacing: 2 }}>{translate("•••")}</span>}
          {quoteOpen ? translate("Hide quoted text") : ""}
        </button>
      )}
    </>
  );
}

function TextBody({ text }: { text: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const openCompose = useCompose((s) => s.open);
  const { main, quoted } = useMemo(() => {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const idx = findQuoteStart(lines);
    if (idx > 2) return { main: lines.slice(0, idx).join("\n"), quoted: lines.slice(idx).join("\n") };
    return { main: text, quoted: "" };
  }, [text]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${TEXT_EMAIL_CSS}</style><div class="ihm-text-root">${textToHtml(main)}${quoted ? `<div class="ihm-quoted" ${quoteOpen ? "" : "hidden"}>\n${textToHtml(quoted)}</div>` : ""}</div>`;
    const onClick = (ev: Event) => {
      const a = (ev.target as HTMLElement).closest("a");
      if (a && a.getAttribute("href")?.startsWith("mailto:")) {
        ev.preventDefault();
        openCompose({ to: [{ name: null, email: a.getAttribute("href")!.slice(7) }] });
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [main, quoted, quoteOpen, openCompose]);

  return (
    <>
      {/* The sender's content, rendered as-is. Translating it would
          rewrite what someone actually wrote. */}
      <div ref={hostRef} className="body-host notranslate" translate="no" />
      {quoted && (
        <button className="quote-toggle" onClick={() => setQuoteOpen((v) => !v)}>
          {quoteOpen ? <ChevronUp size={12} /> : <span style={{ letterSpacing: 2 }}>{translate("•••")}</span>}
          {quoteOpen ? translate("Hide quoted text") : ""}
        </button>
      )}
    </>
  );
}

/* ---------- Attachments ---------- */

export function attachmentIcon(type: string, name?: string | null) {
  const t = type.toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (t.startsWith("image/")) return <ImageIcon size={18} />;
  if (t.startsWith("video/")) return <Film size={18} />;
  if (t.startsWith("audio/")) return <Music size={18} />;
  if (t === "application/pdf") return <FileText size={18} />;
  if (/zip|tar|gzip|7z|rar|compressed/.test(t) || /\.(zip|tgz|gz|7z|rar)$/.test(n)) return <FileArchive size={18} />;
  if (/spreadsheet|excel|csv/.test(t) || /\.(xlsx?|csv)$/.test(n)) return <FileSpreadsheet size={18} />;
  if (t === "text/calendar") return <Calendar size={18} />;
  if (t.includes("vcard")) return <UserPlus size={18} />;
  if (t.startsWith("text/") || /word|document/.test(t)) return <FileText size={18} />;
  return <File size={18} />;
}

function AttachmentList({ attachments, accountId, email }: { attachments: EmailBodyPart[]; accountId: Id; email: Email }) {
  const [preview, setPreview] = useState<EmailBodyPart | null>(null);
  const viewable = (a: EmailBodyPart) => (a.type.startsWith("image/") && a.type !== "image/svg+xml") || a.type === "application/pdf" || a.type === "text/plain";
  return (
    <>
      <div className="attachments">
        {attachments.map((a, i) => {
          const url = a.blobId ? client.downloadUrl(accountId, a.blobId, a.name ?? "attachment", a.type) : "#";
          const inlineUrl = a.blobId ? client.downloadUrl(accountId, a.blobId, a.name ?? "attachment", a.type, true) : "#";
          return (
            <a key={a.blobId ?? i} className="attachment" href={url} download={a.name ?? undefined} title={`${a.name ?? "attachment"} (${formatSize(a.size)})`} onClick={(ev) => { if (viewable(a)) { ev.preventDefault(); setPreview(a); } }}>
              <span className="att-icon">{a.type.startsWith("image/") && a.type !== "image/svg+xml" && a.blobId ? <img src={inlineUrl} alt="" loading="lazy" /> : attachmentIcon(a.type, a.name)}</span>
              <span className="att-text">
                <span className="att-name">{a.name ?? "(unnamed)"}</span>
                <span className="att-size">{formatSize(a.size)}</span>
                <span className="att-actions">
                  <button className="icon-btn xs" title={translate("Download")} onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); const l = document.createElement("a"); l.href = url; l.download = a.name ?? ""; l.click(); }}><Download size={14} /></button>
                  {viewable(a) && <button className="icon-btn xs" title={translate("Open in new tab")} onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); window.open(inlineUrl, "_blank", "noopener"); }}><ExternalLink size={14} /></button>}
                </span>
              </span>
            </a>
          );
        })}
        {attachments.length > 1 && (
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: "center" }} onClick={() => { for (const a of attachments) { if (!a.blobId) continue; const l = document.createElement("a"); l.href = client.downloadUrl(accountId, a.blobId, a.name ?? "attachment", a.type); l.download = a.name ?? ""; l.click(); } }}>
            <Download size={14} />  {translate("Download all")}
          </button>
        )}
      </div>
      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name ?? translate("Preview")} size="xl" footer={preview && <a className="btn" href={client.downloadUrl(accountId, preview.blobId!, preview.name ?? "file", preview.type)} download><Download size={16} />  {translate("Download")}</a>}>
        {preview?.type.startsWith("image/") && <img src={client.downloadUrl(accountId, preview.blobId!, preview.name ?? "image", preview.type, true)} alt={preview.name ?? ""} style={{ maxHeight: "70vh", display: "block", margin: "0 auto" }} />}
        {preview?.type === "application/pdf" && <iframe title={translate("PDF")} src={client.downloadUrl(accountId, preview.blobId!, preview.name ?? "file.pdf", preview.type, true)} style={{ width: "100%", height: "70vh", border: 0 }} />}
        {preview?.type === "text/plain" && <TextAttachment url={client.downloadUrl(accountId, preview.blobId!, preview.name ?? "file.txt", preview.type, true)} />}
        <p className="hint" style={{ marginTop: 8 }}>{translate("From: {sender}", { sender: displayName(email.from?.[0]) })}</p>
      </Dialog>
    </>
  );
}

function TextAttachment({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch(url, { credentials: "same-origin" }).then((r) => r.text()).then(setText).catch(() => setText("Could not load."));
  }, [url]);
  return <pre className="code notranslate" translate="no" style={{ maxHeight: "65vh" }}>{text ?? "Loading…"}</pre>;
}
