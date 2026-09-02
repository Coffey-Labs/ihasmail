import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertOctagon, Archive, ArrowLeft, ChevronDown, ChevronUp, FolderInput, Forward, Mail, MailOpen, MailPlus, MoreVertical, Printer, Reply, ReplyAll, ShieldCheck, Star, Tag, Trash2, Download , Paperclip} from "lucide-react";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { useCompose } from "@/store/compose";
import type { Email, Id } from "@/jmap/types";
import { MessageView } from "./MessageView";
import type { ListActions } from "./MessageList";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { Spinner, useIsNarrow, useIsTouch } from "@/ui/misc";
import { client } from "@/jmap/client";
import { LabelPicker } from "./LabelPicker";
import { threadScrollTarget } from "@/lib/threadScroll";
import { useEdgeBack } from "@/lib/touch";
import { plural, t } from "@/lib/i18n";

/** How long the opening scroll keeps its place while bodies and images land. */
const HOLD_MS = 2000;

interface Props {
  threadId: Id;
  mailboxId: Id | null;
  onBack: () => void;
  actions: ListActions;
  onNavigate: (delta: number) => void;
  hasPrev: boolean;
  hasNext: boolean;
}

export function ThreadView({ threadId, mailboxId, onBack, actions, onNavigate, hasPrev, hasNext }: Props) {
  const loadThread = useMail((s) => s.loadThread);
  const thread = useMail((s) => s.threads[threadId]);
  const emails = useMail((s) => s.emails);
  const fullIds = useMail((s) => s.fullIds);
  const loading = useMail((s) => Boolean(s.loadingThreads[threadId]));
  const mailboxes = useMail((s) => s.mailboxes);
  const settings = useSettings((s) => s.settings);
  const labels = settings.labels;
  const reply = useCompose((s) => s.reply);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<Id, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(false);
  const [labelAnchor, setLabelAnchor] = useState<{ x: number; y: number } | null>(null);
  const moreMenu = useMenu();
  /** The overflow on the reply strip, which is the only per-message menu a phone offers easily. */
  const replyMore = useMenu();
  const scrollRef = useRef<HTMLDivElement>(null);
  const markTimer = useRef<number | null>(null);
  const isTouch = useIsTouch();
  const narrow = useIsNarrow();
  /*
   * Drag in from the left edge to go back to the list.
   *
   * Only where back means something: on a wide screen the list is still
   * beside the conversation and there is nowhere to go. The toolbar's arrow
   * stays regardless — a gesture with no visible control is a gesture only
   * the people who already know about it can use.
   */
  const [viewEl, setViewEl] = useState<HTMLDivElement | null>(null);
  useEdgeBack(viewEl, onBack, isTouch && narrow);

  // Load
  useEffect(() => {
    setError(null);
    useMail.getState().setOpenThread(threadId);
    loadThread(threadId).catch((err) => setError((err as Error).message));
    return () => {
      if (useMail.getState().openThreadId === threadId) useMail.getState().setOpenThread(null);
    };
  }, [threadId, loadThread]);

  const messages = useMemo(() => {
    if (!thread) return [] as Email[];
    const all = thread.emailIds.map((id) => emails[id]).filter((e): e is Email => Boolean(e && fullIds[e.id]));
    // Conversation view: hide trash/junk messages unless we're in that folder.
    const mail = useMail.getState();
    const trash = mail.roleId("trash");
    const junk = mail.roleId("junk");
    const filtered = all.filter((e) => {
      if (mailboxId && (mailboxId === trash || mailboxId === junk)) return true;
      if (trash && e.mailboxIds[trash]) return false;
      if (junk && e.mailboxIds[junk]) return false;
      return true;
    });
    return (filtered.length ? filtered : all).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }, [thread, emails, fullIds, mailboxId]);

  /*
   * Which messages were unread when this conversation was opened.
   *
   * Expansion and the unread bar used to read `$seen` directly, so the moment
   * the auto-mark-read timer fired, every message expanded *because* it was
   * unread collapsed again -- all but the last -- and the only record of which
   * ones they were disappeared with them (#69). Opening a thread with several
   * unread messages gave you a few seconds before the view rearranged itself
   * underneath you.
   *
   * Marking read on the server is still right: opening the thread is the signal
   * that you are reading it. What was wrong was letting that change the shape
   * of what you are looking at. The set only ever grows while a thread is open
   * -- a message that arrives unread joins it -- and is discarded on the way to
   * another thread.
   *
   * Accumulated during render rather than in an effect because it is derived
   * purely from `messages`, and adding an id twice does nothing. An effect
   * would repaint a frame later, which is the flicker this exists to remove.
   */
  const threadKey = thread?.id ?? null;
  const unreadAtOpen = useRef<{ key: Id | null; ids: Set<Id> }>({ key: null, ids: new Set() });
  if (unreadAtOpen.current.key !== threadKey) unreadAtOpen.current = { key: threadKey, ids: new Set() };
  for (const m of messages) if (!m.keywords.$seen) unreadAtOpen.current.ids.add(m.id);
  const wasUnread = unreadAtOpen.current.ids;

  // Default expansion: unread when opened + last message expanded, others collapsed
  const lastId = messages[messages.length - 1]?.id;
  const isExpanded = useCallback(
    (e: Email) => {
      if (e.id in expanded) return expanded[e.id]!;
      if (allExpanded) return true;
      return wasUnread.has(e.id) || e.id === lastId || messages.length === 1;
    },
    [expanded, allExpanded, lastId, messages.length, wasUnread],
  );

  // Mark as read after delay
  useEffect(() => {
    if (!messages.length) return;
    const unread = messages.filter((e) => !e.keywords.$seen && isExpanded(e)).map((e) => e.id);
    if (!unread.length || settings.markReadDelay < 0) return;
    if (markTimer.current) window.clearTimeout(markTimer.current);
    markTimer.current = window.setTimeout(() => void useMail.getState().markRead(unread, true), settings.markReadDelay * 1000);
    return () => {
      if (markTimer.current) window.clearTimeout(markTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.map((m) => m.id + (m.keywords.$seen ? "1" : "0")).join(","), settings.markReadDelay]);

  /*
   * Open on the first unread message rather than the newest one (#87).
   *
   * Scrolling once is not enough. Message bodies are written into shadow roots
   * by child effects, and the images in them load later still, so the pane goes
   * on growing after the scroll -- and `scrollIntoView` clamps to the scroll
   * range as it stands the moment it is called. The read-thread fallback always
   * aims at the last message, which no thread has the room to lift to the top,
   * so that clamp is the whole of the range: measuring it before the images
   * landed stopped 39px short of the bottom, every time (#89).
   *
   * So the target is held against the top of the pane while the thread settles,
   * and let go the moment the reader touches it. A pane that re-scrolls under
   * someone who has started reading is worse than one that lands short, which
   * is why the hold ends on the first sign of them rather than when the content
   * stops changing.
   */
  useEffect(() => {
    const sc = scrollRef.current;
    if (!messages.length || !sc) return;
    const target = threadScrollTarget(messages, wasUnread);
    if (!target) return;

    let held = true;
    const align = () => {
      if (held) sc.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "start" });
    };
    const release = () => {
      held = false;
    };

    align();

    // The messages and the reply box: what grows is one of their heights.
    const ro = new ResizeObserver(align);
    for (const child of sc.children) ro.observe(child);
    // `scroll` is not in here: the aligning does that itself.
    for (const ev of ["wheel", "pointerdown", "touchstart"]) sc.addEventListener(ev, release, { passive: true });
    window.addEventListener("keydown", release);
    const settled = window.setTimeout(release, HOLD_MS);

    return () => {
      release();
      ro.disconnect();
      for (const ev of ["wheel", "pointerdown", "touchstart"]) sc.removeEventListener(ev, release);
      window.removeEventListener("keydown", release);
      window.clearTimeout(settled);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, messages.length > 0]);

  // Keyboard: reply/forward events from MailView
  useEffect(() => {
    const onReply = (ev: Event) => {
      const mode = (ev as CustomEvent<"reply" | "replyAll" | "forward">).detail;
      const last = messages[messages.length - 1];
      if (last) void reply(last, mode);
    };
    const onNav = (ev: Event) => {
      const delta = (ev as CustomEvent<number>).detail;
      const els = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-msg-id]") ?? []);
      if (!els.length) return;
      const top = scrollRef.current!.getBoundingClientRect().top;
      let idx = els.findIndex((el) => el.getBoundingClientRect().top - top > 8);
      if (idx < 0) idx = els.length;
      const target = els[Math.max(0, Math.min(els.length - 1, (delta > 0 ? idx : idx - 2)))];
      if (target) {
        const id = target.dataset.msgId!;
        setExpanded((x) => ({ ...x, [id]: true }));
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    };
    window.addEventListener("ihm:reply", onReply);
    window.addEventListener("ihm:msg-nav", onNav);
    return () => {
      window.removeEventListener("ihm:reply", onReply);
      window.removeEventListener("ihm:msg-nav", onNav);
    };
  }, [messages, reply]);

  const subject = messages[0]?.subject || emails[thread?.emailIds[0] ?? ""]?.subject || "(no subject)";
  const rowIds = thread ? thread.emailIds.filter((id) => emails[id]) : [];
  const anyUnread = messages.some((e) => !e.keywords.$seen);
  const anyStarred = messages.some((e) => e.keywords.$flagged);
  const inJunk = Boolean(mailboxId && mailboxes[mailboxId]?.role === "junk");
  const threadLabels = labels.filter((l) => messages.some((m) => m.keywords[l.keyword]));
  const threadMailboxes = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) for (const id of Object.keys(m.mailboxIds)) if (mailboxes[id] && id !== mailboxId) set.add(mailboxes[id]!.name);
    return [...set];
  }, [messages, mailboxes, mailboxId]);

  const last = messages[messages.length - 1];
  const accountId = useMail((s) => s.accountId);

  return (
    <div className="thread-view" ref={setViewEl}>
      <div className="thread-toolbar">
        <button className="icon-btn" onClick={onBack} aria-label={t("Back to list")} title={t("Back (u)")}>
          <ArrowLeft size={20} />
        </button>
        <button className="icon-btn" title={t("Archive (e)")} onClick={() => void actions.archive(rowIds)}><Archive size={19} /></button>
        <button className="icon-btn" title={inJunk ? "Not spam" : "Report spam (!)"} onClick={() => void actions.spam(rowIds)}>{inJunk ? <ShieldCheck size={19} /> : <AlertOctagon size={19} />}</button>
        <button className="icon-btn" title={t("Delete (#)")} onClick={() => void actions.trash(rowIds)}><Trash2 size={19} /></button>
        <span className="tb-sep hide-mobile" />
        <button className="icon-btn hide-mobile" title={anyUnread ? "Mark as read" : "Mark as unread"} onClick={() => void actions.read(anyUnread, rowIds)}>{anyUnread ? <MailOpen size={19} /> : <Mail size={19} />}</button>
        <button className="icon-btn hide-mobile" title={t("Move to (v)")} onClick={() => actions.move(rowIds)}><FolderInput size={19} /></button>
        <button className="icon-btn hide-mobile" title={t("Labels (l)")} onClick={(e) => setLabelAnchor({ x: e.clientX, y: e.clientY })}><Tag size={19} /></button>
        <button className="icon-btn" onClick={moreMenu.open} aria-label={t("More")}><MoreVertical size={19} /></button>
        <Popover anchor={moreMenu.anchor} onClose={moreMenu.close} align="start" width={240}>
          <MenuItem icon={<Star size={16} />} label={anyStarred ? "Remove star" : "Add star"} onClick={() => void actions.star(!anyStarred, rowIds)} />
          <MenuItem icon={<Tag size={16} />} label={t("Label…")} onClick={() => setLabelAnchor({ x: window.innerWidth / 2, y: 100 })} />
          <MenuItem icon={allExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />} label={allExpanded ? "Collapse all" : "Expand all"} onClick={() => { setAllExpanded((v) => !v); setExpanded({}); }} />
          <MenuSep />
          <MenuItem icon={<Printer size={16} />} label={t("Print conversation")} onClick={() => window.print()} />
          {last && accountId && (
            <MenuItem icon={<Download size={16} />} label={t("Download latest as .eml")} onClick={() => { const a = document.createElement("a"); a.href = client.downloadUrl(accountId, last.blobId, `${(last.subject || "message").replace(/[^\w.-]+/g, "_")}.eml`, "message/rfc822"); a.download = ""; a.click(); }} />
          )}
        </Popover>
        <div className="thread-nav hide-mobile">
          <button className="icon-btn sm" disabled={!hasPrev} onClick={() => onNavigate(-1)} title={t("Newer (k)")}><ChevronUp size={18} /></button>
          <button className="icon-btn sm" disabled={!hasNext} onClick={() => onNavigate(1)} title={t("Older (j)")}><ChevronDown size={18} /></button>
        </div>
      </div>
      <div className="thread-scroll" ref={scrollRef}>
        <div className="thread-subject">
          <div className="grow">
            <h1 className="notranslate" translate="no">{subject}</h1>
            {(threadLabels.length > 0 || threadMailboxes.length > 0) && (
              <div className="labels">
                {threadMailboxes.map((n) => <span key={n} className="chip">{n}</span>)}
                {threadLabels.map((l) => <span key={l.keyword} className="tag" style={{ background: l.color }}>{l.name}</span>)}
              </div>
            )}
          </div>
          {messages.length > 1 && <span className="muted small nowrap" style={{ marginTop: 6 }}>{plural(messages.length, { one: "{n} message", other: "{n} messages" })}</span>}
        </div>
        {error && <div className="error-box" style={{ margin: 16 }}>{error}</div>}
        {loading && !messages.length && <Spinner label={t("Loading conversation…")} />}
        {messages.map((e, i) => (
          <MessageView
            key={e.id}
            email={e}
            expanded={isExpanded(e)}
            wasUnread={wasUnread.has(e.id)}
            onToggle={() => setExpanded((x) => ({ ...x, [e.id]: !isExpanded(e) }))}
            isLast={i === messages.length - 1}
            actions={actions}
          />
        ))}
        {last && (
          <div className="reply-box">
            <div className="reply-prompt">
              <button onClick={() => void reply(last, "reply")}><Reply size={16} />  {t("Reply")}</button>
              <button onClick={() => void reply(last, "replyAll")}><ReplyAll size={16} />  {t("Reply all")}</button>
              <button onClick={() => void reply(last, "forward")}><Forward size={16} />  {t("Forward")}</button>
              {/*
                On a phone this strip is where a thumb goes, and the per-message
                menu at the top of a card is not somewhere anybody looks for
                "send this again" -- which is how compose-as-new came to be
                reported missing on mobile when it was there all along (#181).
                A fourth full button does not fit at 500px; this does, and it
                spells the action out once opened.
              */}
              <span className="spacer" />
              <button className="icon-btn" onClick={replyMore.open} aria-label={t("More ways to send this")}><MoreVertical size={18} /></button>
              <Popover anchor={replyMore.anchor} onClose={replyMore.close} align="end" width={220}>
                <MenuItem icon={<Paperclip size={16} />} label={t("Forward as attachment")} onClick={() => useCompose.getState().forwardAsAttachment(last)} />
                <MenuItem icon={<MailPlus size={16} />} label={t("Compose as new")} onClick={() => void useCompose.getState().composeAsNew(last)} />
              </Popover>
            </div>
          </div>
        )}
      </div>
      {labelAnchor && <LabelPicker ids={rowIds} anchor={labelAnchor} onClose={() => setLabelAnchor(null)} />}
    </div>
  );
}
