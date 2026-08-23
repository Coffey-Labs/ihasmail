import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { DEFAULT_SORT, useMail, type ListQuery } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { useCompose } from "@/store/compose";
import { buildFilter, describeFilter, parseQuery } from "@/lib/search";
import { keyboard } from "@/lib/keyboard";
import { useIsNarrow } from "@/ui/misc";
import { Splitter } from "@/ui/Splitter";
import { MessageList } from "./MessageList";
import { ThreadView } from "./ThreadView";
import { MailboxPicker } from "./MailboxPicker";
import { LabelPicker } from "./LabelPicker";
import type { Id } from "@/jmap/types";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

export function MailView({ mailboxId, threadId, search }: { mailboxId?: string; threadId?: string; search?: boolean }) {
  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const mailboxes = useMail((s) => s.mailboxes);
  const mailboxesLoaded = useMail((s) => s.mailboxesLoaded);
  const inboxId = useMail((s) => s.roleId("inbox"));
  const query = useMail((s) => s.query);
  const list = useMail((s) => s.list);
  const settings = useSettings((s) => s.settings);
  const narrow = useIsNarrow();
  const [focusId, setFocusId] = useState<Id | null>(null);
  const [movePicker, setMovePicker] = useState<{ ids: Id[] } | null>(null);
  const [labelPicker, setLabelPicker] = useState<{ ids: Id[]; anchor: { x: number; y: number } } | null>(null);

  const q = useMemo(() => (search ? (new URLSearchParams(searchStr).get("q") ?? "") : ""), [search, searchStr]);

  // Redirect /mail → inbox
  useEffect(() => {
    if (!search && !mailboxId && inboxId) navigate(`/mail/${inboxId}`, { replace: true });
  }, [search, mailboxId, inboxId, navigate]);

  // Build & run the list query
  const listQuery = useMemo<ListQuery | null>(() => {
    if (search) {
      if (!q) return null;
      const parsed = parseQuery(q);
      const filter = buildFilter(parsed, mailboxes, null);
      const inMb = parsed.in ? (Object.values(mailboxes).find((m) => m.name.toLowerCase() === parsed.in!.toLowerCase())?.id ?? null) : null;
      return { key: "", filter, sort: DEFAULT_SORT, collapseThreads: settings.conversationMode, mailboxId: inMb, label: describeFilter(parsed) };
    }
    if (!mailboxId) return null;
    const mb = mailboxes[mailboxId];
    const isDraftsOrSent = mb?.role === "drafts" || mb?.role === "sent";
    return { key: "", filter: { inMailbox: mailboxId }, sort: DEFAULT_SORT, collapseThreads: settings.conversationMode && !isDraftsOrSent, mailboxId };
  }, [search, q, mailboxId, mailboxes, settings.conversationMode]);

  useEffect(() => {
    if (listQuery && mailboxesLoaded) void query(listQuery);
  }, [listQuery, query, mailboxesLoaded]);

  const openThread = useCallback(
    (tid: Id | null) => {
      const base = search ? `/search` : `/mail/${mailboxId}`;
      const qs = search ? `?q=${encodeURIComponent(q)}` : "";
      navigate(tid ? `${base}/${tid}${qs}` : `${base}${qs}`);
    },
    [navigate, search, mailboxId, q],
  );

  // Row ids in list + helpers for keyboard nav
  const ids = list?.ids ?? [];
  const emails = useMail((s) => s.emails);
  const threads = useMail((s) => s.threads);
  const selected = useMail((s) => s.selected);

  const rowThreadId = useCallback((rowId: Id) => emails[rowId]?.threadId, [emails]);
  const currentRowIndex = useMemo(() => {
    if (focusId) {
      const i = ids.indexOf(focusId);
      if (i >= 0) return i;
    }
    if (threadId) return ids.findIndex((id) => rowThreadId(id) === threadId);
    return -1;
  }, [ids, focusId, threadId, rowThreadId]);

  /** Email ids affected by an action on rows (selection or focused/open row). */
  const targetIds = useCallback(
    (rowIds?: Id[]): Id[] => {
      const rows = rowIds ?? (Object.keys(selected).length ? Object.keys(selected) : focusId ? [focusId] : threadId ? ids.filter((id) => rowThreadId(id) === threadId) : []);
      const out = new Set<Id>();
      for (const r of rows) {
        const e = emails[r];
        if (!e) continue;
        if (list?.collapseThreads) {
          const t = threads[e.threadId];
          const inScope = t ? t.emailIds.filter((id) => (list.mailboxId ? emails[id]?.mailboxIds[list.mailboxId] : true)) : [r];
          for (const id of inScope.length ? inScope : [r]) out.add(id);
        } else out.add(r);
      }
      return [...out];
    },
    [selected, focusId, threadId, ids, rowThreadId, emails, threads, list],
  );

  const afterAction = useCallback(
    (removed: boolean) => {
      useMail.getState().clearSelection();
      if (!removed) return;
      // auto-advance
      if (threadId) {
        const idx = currentRowIndex;
        const adv = settings.autoAdvance;
        if (adv === "list" || idx < 0) openThread(null);
        else {
          const next = adv === "older" ? ids[idx + 1] : ids[idx - 1];
          const nt = next ? rowThreadId(next) : undefined;
          if (nt) openThread(nt);
          else openThread(null);
        }
      }
    },
    [threadId, currentRowIndex, settings.autoAdvance, ids, rowThreadId, openThread],
  );

  const actions = useMemo(
    () => ({
      archive: async (rows?: Id[]) => {
        const t = targetIds(rows);
        if (!t.length) return;
        await useMail.getState().archive(t);
        afterAction(true);
      },
      trash: async (rows?: Id[]) => {
        const t = targetIds(rows);
        if (!t.length) return;
        const mail = useMail.getState();
        const trashId = mail.roleId("trash");
        const permanent = t.every((id) => trashId && mail.emails[id]?.mailboxIds[trashId]);
        if (permanent || settings.confirmDelete) {
          const ok = await confirmDialog({ title: permanent ? "Delete forever?" : "Delete?", message: permanent ? `${t.length} message(s) will be permanently deleted.` : `Move ${t.length} message(s) to Trash?`, confirmLabel: "Delete", danger: permanent });
          if (!ok) return;
        }
        await mail.trash(t);
        afterAction(true);
      },
      spam: async (rows?: Id[]) => {
        const t = targetIds(rows);
        if (!t.length) return;
        const mail = useMail.getState();
        const junk = mail.roleId("junk");
        const inJunk = t.every((id) => junk && mail.emails[id]?.mailboxIds[junk]);
        await mail.spam(t, !inJunk);
        afterAction(true);
      },
      read: async (read: boolean, rows?: Id[]) => {
        const t = targetIds(rows);
        if (t.length) await useMail.getState().markRead(t, read);
        useMail.getState().clearSelection();
      },
      star: async (on: boolean, rows?: Id[]) => {
        const t = targetIds(rows);
        if (t.length) await useMail.getState().star(t, on);
      },
      move: (rows?: Id[]) => {
        const t = targetIds(rows);
        if (t.length) setMovePicker({ ids: t });
      },
      label: (rows: Id[] | undefined, anchor: { x: number; y: number }) => {
        const t = targetIds(rows);
        if (t.length) setLabelPicker({ ids: t, anchor });
      },
      moveTo: async (ids: Id[], mailboxId: Id) => {
        await useMail.getState().move(ids, mailboxId);
        afterAction(true);
      },
    }),
    [targetIds, afterAction, settings.confirmDelete],
  );

  // Keyboard shortcuts for the list/thread
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  useEffect(() => {
    const moveFocus = (delta: number) => {
      const cur = focusRef.current ? ids.indexOf(focusRef.current) : currentRowIndex;
      const next = Math.max(0, Math.min(ids.length - 1, (cur < 0 ? (delta > 0 ? -1 : 0) : cur) + delta));
      const id = ids[next];
      if (!id) return;
      setFocusId(id);
      if (threadId && settings.readingPane !== "off") {
        const t = rowThreadId(id);
        if (t) openThread(t);
      }
      document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    return keyboard.pushScope("mail", [
      { keys: "j", description: "Next conversation", group: "Mail", handler: () => moveFocus(1) },
      { keys: "k", description: "Previous conversation", group: "Mail", handler: () => moveFocus(-1) },
      { keys: "arrowdown", description: "", group: "Mail", handler: () => moveFocus(1) },
      { keys: "arrowup", description: "", group: "Mail", handler: () => moveFocus(-1) },
      { keys: "o", description: "Open conversation", group: "Mail", handler: () => { const id = focusRef.current; const t = id ? rowThreadId(id) : undefined; if (t) openThread(t); } },
      { keys: "enter", description: "", group: "Mail", handler: () => { const id = focusRef.current; const t = id ? rowThreadId(id) : undefined; if (t) { openThread(t); return; } return false; } },
      { keys: "u", description: "Back to list", group: "Mail", handler: () => openThread(null) },
      { keys: "esc", description: "Back to list / clear selection", group: "Mail", handler: () => { if (Object.keys(useMail.getState().selected).length) useMail.getState().clearSelection(); else openThread(null); } },
      { keys: "x", description: "Select conversation", group: "Mail", handler: () => { const id = focusRef.current ?? ids[currentRowIndex]; if (id) useMail.getState().select([id], !useMail.getState().selected[id]); } },
      { keys: "e", description: "Archive", group: "Actions", handler: () => void actions.archive() },
      { keys: "y", description: "", group: "Actions", handler: () => void actions.archive() },
      { keys: "#", description: "Delete", group: "Actions", handler: () => void actions.trash() },
      { keys: "delete", description: "", group: "Actions", handler: () => void actions.trash() },
      { keys: "!", description: "Report spam / not spam", group: "Actions", handler: () => void actions.spam() },
      { keys: "s", description: "Star / unstar", group: "Actions", handler: () => { const t = targetIds(); const on = !t.every((id) => emails[id]?.keywords.$flagged); void actions.star(on); } },
      { keys: "shift+i", description: "Mark as read", group: "Actions", handler: () => void actions.read(true) },
      { keys: "shift+u", description: "Mark as unread", group: "Actions", handler: () => void actions.read(false) },
      { keys: "v", description: "Move to…", group: "Actions", handler: () => actions.move() },
      { keys: "l", description: "Label…", group: "Actions", handler: () => actions.label(undefined, { x: window.innerWidth / 2, y: 80 }) },
      { keys: "*+a", description: "", group: "Actions", handler: () => useMail.getState().selectAll() },
      { keys: "mod+a", description: "Select all", group: "Mail", handler: () => { useMail.getState().selectAll(); } },
      { keys: "r", description: "Reply", group: "Conversation", handler: () => window.dispatchEvent(new CustomEvent("ihm:reply", { detail: "reply" })) },
      { keys: "a", description: "Reply all", group: "Conversation", handler: () => window.dispatchEvent(new CustomEvent("ihm:reply", { detail: "replyAll" })) },
      { keys: "f", description: "Forward", group: "Conversation", handler: () => window.dispatchEvent(new CustomEvent("ihm:reply", { detail: "forward" })) },
      { keys: "n", description: "Next message in conversation", group: "Conversation", handler: () => window.dispatchEvent(new CustomEvent("ihm:msg-nav", { detail: 1 })) },
      { keys: "p", description: "Previous message in conversation", group: "Conversation", handler: () => window.dispatchEvent(new CustomEvent("ihm:msg-nav", { detail: -1 })) },
      { keys: "]", description: "Archive and next", group: "Conversation", handler: () => void actions.archive() },
    ]);
  }, [ids, currentRowIndex, threadId, settings.readingPane, rowThreadId, openThread, actions, targetIds, emails]);

  const openDraft = useCompose((s) => s.openDraftEmail);
  const onOpenRow = useCallback(
    (rowId: Id) => {
      const e = emails[rowId];
      if (!e) return;
      setFocusId(rowId);
      const mb = mailboxId ? mailboxes[mailboxId] : undefined;
      if (mb?.role === "drafts" && e.keywords.$draft) {
        void openDraft(e);
        return;
      }
      openThread(e.threadId);
    },
    [emails, mailboxId, mailboxes, openThread, openDraft],
  );

  const title = search ? `Search: ${listQuery?.label ?? q}` : (mailboxId && mailboxes[mailboxId]?.name) || "Mail";
  const reading = Boolean(threadId);
  const paneClass = settings.readingPane === "bottom" ? "pane-bottom" : settings.readingPane === "off" ? "pane-off" : "pane-right";
  const showList = !(settings.readingPane === "off" && reading) && !(narrow && reading);
  const showReading = settings.readingPane !== "off" || reading;
  const layoutRef = useRef<HTMLDivElement>(null);
  const updateSettings = useSettings((s) => s.update);
  const [liveSize, setLiveSize] = useState<number | null>(null);
  const paneSize = liveSize ?? (settings.readingPane === "bottom" ? settings.listPaneHeight : settings.listPaneWidth);
  const onSplit = (delta: number) => {
    const el = layoutRef.current;
    const total = el ? (settings.readingPane === "bottom" ? el.clientHeight : el.clientWidth) : 1200;
    const min = settings.readingPane === "bottom" ? 160 : 320;
    const max = Math.max(min, total - (settings.readingPane === "bottom" ? 200 : 420));
    setLiveSize((cur) => Math.min(max, Math.max(min, (cur ?? paneSize) + delta)));
  };
  const onSplitEnd = () => {
    if (liveSize == null) return;
    updateSettings(settings.readingPane === "bottom" ? { listPaneHeight: liveSize } : { listPaneWidth: liveSize });
    setLiveSize(null);
  };

  return (
    <div ref={layoutRef} className={`mail-layout ${paneClass} ${reading ? "reading" : ""}`} style={{ "--list-size": `${paneSize}px` } as React.CSSProperties}>
      {showList && (
        <MessageList
          title={title}
          list={list}
          openThreadId={threadId ?? null}
          focusId={focusId}
          setFocusId={setFocusId}
          onOpen={onOpenRow}
          actions={actions}
          mailboxId={mailboxId ?? null}
          isSearch={Boolean(search)}
        />
      )}
      {showList && showReading && settings.readingPane !== "off" && !narrow && (
        <Splitter direction={settings.readingPane === "bottom" ? "horizontal" : "vertical"} onResize={onSplit} onEnd={onSplitEnd} onReset={() => updateSettings(settings.readingPane === "bottom" ? { listPaneHeight: 340 } : { listPaneWidth: 520 })} ariaLabel="Resize message list" />
      )}
      {showReading && (
        <div className="mail-reading-pane">
          {threadId ? (
            <ThreadView key={threadId} threadId={threadId} mailboxId={mailboxId ?? null} onBack={() => openThread(null)} actions={actions} onNavigate={(delta) => { const idx = currentRowIndex; const next = ids[idx + delta]; const t = next ? rowThreadId(next) : undefined; if (t) { setFocusId(next!); openThread(t); } }} hasPrev={currentRowIndex > 0} hasNext={currentRowIndex >= 0 && currentRowIndex < ids.length - 1} />
          ) : (
            <div className="no-thread">
              <img src="/img/logo.png" alt="" />
              <div>{list?.total ? `${list.total} conversation${list.total === 1 ? "" : "s"}` : "No conversation selected"}</div>
              <div className="hint">Select a conversation to read it here · Press <kbd className="kbd">?</kbd> for shortcuts</div>
            </div>
          )}
        </div>
      )}
      {movePicker && (
        <MailboxPicker
          title={`Move ${movePicker.ids.length} message${movePicker.ids.length === 1 ? "" : "s"} to…`}
          onClose={() => setMovePicker(null)}
          onPick={(mbId) => {
            setMovePicker(null);
            void actions.moveTo(movePicker.ids, mbId);
          }}
        />
      )}
      {labelPicker && (
        <LabelPicker
          ids={labelPicker.ids}
          anchor={labelPicker.anchor}
          onClose={() => setLabelPicker(null)}
          onApplied={() => toast.show("Labels updated")}
        />
      )}
    </div>
  );
}
