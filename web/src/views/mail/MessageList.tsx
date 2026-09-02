import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArrowLeft, CalendarDays, CalendarRange, CalendarPlus, CheckSquare, FolderInput, PanelRight, PanelBottom, PanelTop, Filter, Inbox, Mail, MailOpen, MailPlus, MoreVertical, Paperclip, RefreshCw, Reply, Search, Star, Tag, Trash2, AlertOctagon, Forward, Eraser, ShieldCheck, X } from "lucide-react";
import { useLocation } from "wouter";
import { useMail, type ListState } from "@/store/mail";
import { dateTimeKey, useSettings } from "@/store/settings";
import type { Email, Id } from "@/jmap/types";
import { formatListDate } from "@/lib/format";
import { mailboxDisplayName } from "@/lib/mailboxName";
import { groupByArchivePath, archivePath, type ArchiveGranularity } from "@/lib/archiveDate";
import { canEmpty, confirmAndEmpty, emptyLabel } from "@/lib/emptyFolder";
import { displayName, shortName } from "@/lib/address";
import { Avatar, Empty, useIsMobile, useIsTouch } from "@/ui/misc";
import { rowClick } from "@/lib/listSelection";
import { MenuItem, MenuSep, MenuTitle, Popover, useMenu } from "@/ui/popover";
import { useCompose } from "@/store/compose";
import { useCalendar } from "@/store/calendar";
import { startAppointment } from "@/lib/appointment";
import { toast } from "@/ui/toast";
import { haptic, usePullToRefresh, useTouchRow, PULL_TRIGGER } from "@/lib/touch";
import { describeSwipe, type SwipeAction, type SwipeDescriptor, type SwipeIcon } from "@/lib/swipe";
import { FilterFromMessageDialog } from "./FilterFromMessage";
import { plural, t } from "@/lib/i18n";

/**
 * The glyph on the strip a swipe reveals. Sized larger than the toolbar's
 * icons: it is read at arm's length, in motion, out of the corner of an eye.
 */
const SWIPE_ICON: Record<SwipeIcon, ReactNode> = {
  archive: <Archive size={22} />,
  delete: <Trash2 size={22} />,
  spam: <AlertOctagon size={22} />,
  "not-spam": <ShieldCheck size={22} />,
  read: <MailOpen size={22} />,
  unread: <Mail size={22} />,
  star: <Star size={22} fill="currentColor" />,
  unstar: <Star size={22} />,
  move: <FolderInput size={22} />,
};

export interface ListActions {
  archive: (rows?: Id[]) => Promise<void>;
  trash: (rows?: Id[]) => Promise<void>;
  spam: (rows?: Id[]) => Promise<void>;
  read: (read: boolean, rows?: Id[]) => Promise<void>;
  star: (on: boolean, rows?: Id[]) => Promise<void>;
  move: (rows?: Id[]) => void;
  label: (rows: Id[] | undefined, anchor: { x: number; y: number }) => void;
  moveTo: (ids: Id[], mailboxId: Id) => Promise<void>;
}

interface Props {
  title: string;
  list: ListState | null;
  openThreadId: Id | null;
  focusId: Id | null;
  setFocusId: (id: Id | null) => void;
  onOpen: (rowId: Id) => void;
  actions: ListActions;
  mailboxId: Id | null;
  isSearch: boolean;
}

export function MessageList({ title, list, openThreadId, focusId, setFocusId, onOpen, actions, mailboxId, isSearch }: Props) {
  const [, navigate] = useLocation();
  const emails = useMail((s) => s.emails);
  const threads = useMail((s) => s.threads);
  const selected = useMail((s) => s.selected);
  const select = useMail((s) => s.select);
  const selectAll = useMail((s) => s.selectAll);
  const clearSelection = useMail((s) => s.clearSelection);
  const loadMore = useMail((s) => s.loadMore);
  const refreshList = useMail((s) => s.refreshList);
  const mailboxes = useMail((s) => s.mailboxes);
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);
  const parentRef = useRef<HTMLDivElement>(null);
  // The same element as `parentRef`, held in state as well: the pull-to-refresh
  // listeners have to be bound in an effect that re-runs when the element
  // arrives, and a ref does not tell anybody it has been filled in.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const isTouch = useIsTouch();
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setPaneWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollEl]);
  const twoLine = isMobile || (paneWidth > 0 && paneWidth < 640);
  const ctxMenu = useMenu();
  const [ctxRow, setCtxRow] = useState<Id | null>(null);
  /** Only offered where there is a calendar to put the appointment in. */
  const hasCalendar = useCalendar((s) => s.available);
  const moreMenu = useMenu();
  const [refreshing, setRefreshing] = useState(false);
  const [filterFrom, setFilterFrom] = useState<Email | null>(null);
  const lastClick = useRef<Id | null>(null);
  const selMenu = useMenu();
  /** The one row currently under a finger, and what letting go would do. */
  const [swiping, setSwiping] = useState<{ id: Id; dir: -1 | 1; armed: boolean; desc: SwipeDescriptor } | null>(null);
  /** How far the list has been pulled down, and whether that is far enough. */
  const [pull, setPull] = useState<{ y: number; armed: boolean; live: boolean }>({ y: 0, armed: false, live: false });

  const ids = list?.ids ?? [];
  const selCount = Object.keys(selected).length;
  const mailbox = mailboxId ? mailboxes[mailboxId] : undefined;
  const isTrashOrJunk = mailbox?.role === "trash" || mailbox?.role === "junk";
  const isDrafts = mailbox?.role === "drafts";

  const rowHeight = twoLine ? (settings.density === "compact" ? 56 : settings.density === "comfortable" ? 78 : 66) : settings.density === "compact" ? 36 : settings.density === "comfortable" ? 52 : 44;
  const virtualizer = useVirtualizer({
    count: ids.length + (list && !list.exhausted ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Re-measure when the row height changes (one-line ↔ two-line, density).
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight]);

  // Infinite scroll
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (!last || !list) return;
    if (last.index >= ids.length - 5 && !list.loadingMore && !list.exhausted && !list.loading) void loadMore();
  }, [items, ids.length, list, loadMore]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshList();
    await useMail.getState().loadMailboxes();
    setRefreshing(false);
  }, [refreshList]);

  /*
   * Pull the top of the list down to refresh it.
   *
   * The toolbar button stays: it is the only way to do this with a mouse, and
   * on a phone it is the way that works when the list is already scrolled down
   * a thousand messages. This is the one a thumb reaches for first.
   */
  usePullToRefresh(scrollEl, doRefresh, {
    enabled: isTouch,
    onPull: useCallback((y: number, armed: boolean, live: boolean) => setPull({ y, armed, live }), []),
  });

  const onRowClick = useCallback(
    (e: MouseEvent, rowId: Id) => {
      const action = rowClick({
        rowId, ids, anchor: lastClick.current, selected,
        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey },
        isMobile,
      });
      if (action.kind === "open") {
        lastClick.current = rowId;
        onOpen(rowId);
        return;
      }
      select(action.ids, action.on);
      if (action.moveAnchor) lastClick.current = rowId;
      // Shift-clicking a list also drags a text selection across it, which
      // leaves the rows looking smeared blue over the selection they meant.
      else window.getSelection()?.removeAllRanges();
    },
    [ids, select, selected, isMobile, onOpen],
  );

  const onContext = useCallback(
    (e: MouseEvent, rowId: Id) => {
      e.preventDefault();
      setCtxRow(rowId);
      setFocusId(rowId);
      ctxMenu.openAt(e.clientX, e.clientY);
    },
    [ctxMenu, setFocusId],
  );

  /*
   * Hold a row to select it, the way the mail app the phone came with does.
   *
   * Selection was reachable on a touchscreen already -- the checkboxes are
   * always visible where there is no hover -- but a checkbox is a small target
   * beside an avatar, and nobody aims for it, because on a phone holding the
   * row *is* how you select it. Once one row is selected, plain taps toggle
   * the rest (see `onRowClick`), so this only has to open the mode.
   */
  const onLongPress = useCallback(
    (rowId: Id) => {
      haptic(15);
      setFocusId(rowId);
      lastClick.current = rowId;
      select([rowId], !useMail.getState().selected[rowId]);
    },
    [select, setFocusId],
  );

  const onSwipeState = useCallback((rowId: Id, state: { dir: -1 | 1; armed: boolean; desc: SwipeDescriptor } | null) => {
    // A row clearing itself must not clear a gesture that has since moved on
    // to another row -- rows unmount as the list scrolls, at any moment.
    setSwiping((cur) => (state ? { id: rowId, ...state } : cur?.id === rowId ? null : cur));
  }, []);

  const fireSwipe = useCallback(
    async (rowId: Id, d: SwipeDescriptor) => {
      switch (d.action) {
        case "archive": await actions.archive([rowId]); break;
        case "delete": await actions.trash([rowId]); break;
        case "spam": await actions.spam([rowId]); break;
        // `on` rather than a fresh look at the row: fire what the strip said.
        case "read": await actions.read(d.on === true, [rowId]); break;
        case "star": await actions.star(d.on === true, [rowId]); break;
        case "move": actions.move([rowId]); break;
      }
    },
    [actions],
  );

  const ctxTargets = useMemo(() => (ctxRow ? (selected[ctxRow] ? Object.keys(selected) : [ctxRow]) : []), [ctxRow, selected]);

  /*
   * Name the destination where there is only one, so the menu says where the
   * mail is actually going rather than describing the rule. A selection that
   * spans months has no single answer, and claiming one would be worse than
   * naming the rule -- so that case falls back to it.
   */
  const archiveDateLabel = useCallback(
    (granularity: ArchiveGranularity) => {
      const groups = groupByArchivePath(ctxTargets.map((id) => ({ id, receivedAt: emails[id]?.receivedAt })), granularity);
      const only = groups.length === 1 ? groups[0]! : null;
      if (only?.segments.length) return t("Archive to {folder}", { folder: archivePath(only.segments) });
      return granularity === "year" ? t("Archive by year") : t("Archive by month");
    },
    [ctxTargets, emails],
  );
  const allSelected = ids.length > 0 && ids.every((id) => selected[id]);
  const selectedAll = useMail((st) => st.selectedAll);
  const selectAllMatching = useMail((st) => st.selectAllMatching);
  const someUnread = ctxTargets.some((id) => !emails[id]?.keywords.$seen);
  const someUnstarred = ctxTargets.some((id) => !emails[id]?.keywords.$flagged);

  return (
    <div className="mail-list-pane">
      <div className="list-toolbar">
        {isMobile && isSearch && (
          <button className="icon-btn" onClick={() => navigate("/mail")} aria-label={t("Back")}>
            <ArrowLeft size={20} />
          </button>
        )}
        <input
          type="checkbox"
          className="select-all"
          aria-label={t("Select all")}
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = selCount > 0 && !allSelected;
          }}
          onChange={() => (allSelected || selCount > 0 ? clearSelection() : selectAll())}
        />
        {selCount > 0 ? (
          <>
            <span className="tb-count">{plural(selectedAll ? (list?.total ?? selCount) : selCount, { one: "{n} selected", other: "{n} selected" })}</span>
            <span className="tb-sep" />
            <button className="icon-btn" title={t("Archive (e)")} onClick={() => void actions.archive()}><Archive size={19} /></button>
            <button className="icon-btn" title={isTrashOrJunk ? t("Delete forever") : t("Delete (#)")} onClick={() => void actions.trash()}><Trash2 size={19} /></button>
            <button className="icon-btn hide-mobile" title={mailbox?.role === "junk" ? t("Not spam") : t("Report spam (!)")} onClick={() => void actions.spam()}>{mailbox?.role === "junk" ? <ShieldCheck size={19} /> : <AlertOctagon size={19} />}</button>
            <span className="tb-sep" />
            <button className="icon-btn" title={t("Mark as read (Shift+I)")} onClick={() => void actions.read(true)}><MailOpen size={19} /></button>
            <button className="icon-btn hide-mobile" title={t("Mark as unread (Shift+U)")} onClick={() => void actions.read(false)}><Mail size={19} /></button>
            <button className="icon-btn" title={t("Move to (v)")} onClick={() => actions.move()}><FolderInput size={19} /></button>
            <button className="icon-btn hide-mobile" title={t("Labels (l)")} onClick={(e) => actions.label(undefined, { x: e.clientX, y: e.clientY })}><Tag size={19} /></button>
            {/*
              The three buttons above marked hide-mobile have nowhere to go on
              a phone, and used to simply not exist there: selecting mail on a
              touchscreen could archive, delete, mark read and move, and could
              not report spam, mark unread or label. Now that holding a row is
              how selection starts, that gap is the first thing a thumb finds.
            */}
            {isMobile && (
              <>
                <span className="spacer" />
                <button className="icon-btn" onClick={selMenu.open} aria-label={t("More actions")}><MoreVertical size={19} /></button>
                <Popover anchor={selMenu.anchor} onClose={selMenu.close} align="end" width={240}>
                  <MenuItem
                    icon={mailbox?.role === "junk" ? <ShieldCheck size={16} /> : <AlertOctagon size={16} />}
                    label={mailbox?.role === "junk" ? "Not spam" : "Report spam"}
                    onClick={() => void actions.spam()}
                  />
                  <MenuItem icon={<Mail size={16} />} label={t("Mark as unread")} onClick={() => void actions.read(false)} />
                  <MenuItem icon={<Tag size={16} />} label={t("Label…")} onClick={() => actions.label(undefined, { x: window.innerWidth / 2, y: 100 })} />
                  {/*
                    A phone reaches this menu by holding a row, which is also
                    the only way it reaches per-message actions at all -- there
                    is no right-click. Offered for one message only: the draft
                    is one message's subject and body, and there is no sensible
                    event to make out of five of them.
                  */}
                  {hasCalendar && selCount === 1 && (
                    <MenuItem
                      icon={<CalendarPlus size={16} />}
                      label={t("Create event…")}
                      onClick={() => { const e = emails[Object.keys(selected)[0] as Id]; if (e) void startAppointment(e, navigate).catch((err: unknown) => toast.error((err as Error).message)); }}
                    />
                  )}
                  <MenuSep />
                  <MenuItem icon={<CheckSquare size={16} />} label={t("Select all")} onClick={selectAll} />
                  <MenuItem icon={<X size={16} />} label={t("Clear selection")} onClick={clearSelection} />
                </Popover>
              </>
            )}
          </>
        ) : (
          <>
            <span className="tb-title">{title}</span>
            {list && !list.loading && <span className="tb-count">{list.total.toLocaleString()}</span>}
            <span className="spacer" />
            <button className={`icon-btn ${refreshing ? "active" : ""}`} title={t("Refresh")} onClick={() => void doRefresh()} aria-label={t("Refresh")}>
              <RefreshCw size={18} className={refreshing ? "spin" : ""} style={refreshing ? { animation: "spin .8s linear infinite" } : undefined} />
            </button>
            <button className="icon-btn" onClick={moreMenu.open} aria-label={t("More")}>
              <MoreVertical size={18} />
            </button>
            <Popover anchor={moreMenu.anchor} onClose={moreMenu.close} align="end" width={240}>
              <MenuTitle>{t("Reading pane")}</MenuTitle>
              <MenuItem icon={<PanelRight size={16} />} label={t("Right of the list")} checked={settings.readingPane === "right"} onClick={() => updateSettings({ readingPane: "right" })} />
              <MenuItem icon={<PanelBottom size={16} />} label={t("Below the list")} checked={settings.readingPane === "bottom"} onClick={() => updateSettings({ readingPane: "bottom" })} />
              <MenuItem icon={<PanelTop size={16} />} label={t("Hidden (open full width)")} checked={settings.readingPane === "off"} onClick={() => updateSettings({ readingPane: "off" })} />
              <MenuSep />
              <MenuItem icon={<CheckSquare size={16} />} label={t("Select all")} onClick={selectAll} />
              <MenuItem icon={<MailOpen size={16} />} label={t("Mark all as read")} onClick={() => mailboxId && void useMail.getState().markMailboxRead(mailboxId)} disabled={!mailboxId} />
              {mailbox && canEmpty(mailbox.role) && (
                <>
                  <MenuSep />
                  <MenuItem
                    danger
                    icon={<Eraser size={16} />}
                    label={emptyLabel(mailbox)}
                    disabled={!mailbox.totalEmails}
                    onClick={() => void confirmAndEmpty(mailbox)}
                  />
                </>
              )}
            </Popover>
          </>
        )}
      </div>
      {/*
        The step past the checkbox. Ticking it selects the rows that are
        loaded, which on a folder of ten thousand is fifty of them -- and a
        checkbox that silently meant all ten thousand would be the worst of
        both. So the wider selection is offered here, in a line that says what
        each of the two actually covers, and taken deliberately.
      */}
      {allSelected && !selectedAll && (list?.total ?? 0) > ids.length && (
        <div className="list-hint select-all-hint">
          <span className="grow">{t("All {n} on this page are selected.", { n: String(ids.length) })}</span>
          <button onClick={() => selectAllMatching()}>
            {t("Select all {n} in {folder}", { n: String(list!.total), folder: mailbox ? mailboxDisplayName(mailbox) : t("this view") })}
          </button>
        </div>
      )}
      {selectedAll && (
        <div className="list-hint select-all-hint">
          <span className="grow">
            {t("All {n} in {folder} are selected.", { n: String(list?.total ?? 0), folder: mailbox ? mailboxDisplayName(mailbox) : t("this view") })}
          </span>
          <button onClick={() => clearSelection()}>{t("Clear selection")}</button>
        </div>
      )}
      {list?.error && (
        <div className="list-hint">
          <span className="grow" style={{ color: "var(--danger)" }}>{list.error}</span>
          <button onClick={() => void doRefresh()}>{t("Retry")}</button>
        </div>
      )}
      {/*
        Junk Mail's own banner, the way every other mail client offers it:
        clearing spam is the one thing people come to this folder to do, and
        making them find it in a menu is making them hunt for it.

        Only here, and only with something to delete. It says "permanently"
        because that is the part worth knowing before clicking — these do not
        pass through Deleted Items on the way out.
      */}
      {mailbox?.role === "junk" && !!mailbox.totalEmails && !selCount && (
        <div className="list-hint">
          <span className="grow">
            
            {t("Deleting spam is permanent — it does not go to Deleted Items first.")}
          </span>
          <button onClick={() => void confirmAndEmpty(mailbox)}>{t("Delete all spam now")}</button>
        </div>
      )}
      <div
        ref={(el) => {
          parentRef.current = el;
          setScrollEl(el);
        }}
        className={`mail-list ${selCount ? "has-selection" : ""} ${twoLine ? "two-line" : ""} ${settings.density === "compact" ? "compact" : ""}`}
        tabIndex={-1}
      >
        {/*
          The pull dial. Zero-height and sticky, so it rides the top of the
          scroller without taking a row's worth of space from the list when
          nobody is pulling — and so it stays put while the content below it
          comes down.
        */}
        {isTouch && (
          <div className="ptr" aria-hidden="true">
            <span
              className={`ptr-dial ${pull.armed || refreshing ? "armed" : ""}`}
              style={{ transform: `translate(-50%, ${Math.max(0, pull.y - 36)}px)`, opacity: Math.min(1, pull.y / 20), transition: pull.live ? "none" : "transform .22s var(--ease), opacity .22s" }}
            >
              <RefreshCw size={18} className={refreshing ? "spin" : ""} style={refreshing ? undefined : { transform: `rotate(${Math.round((pull.y / PULL_TRIGGER) * 270)}deg)` }} />
            </span>
          </div>
        )}
        <div
          className="mail-list-pull"
          style={pull.y ? { transform: `translateY(${pull.y}px)`, transition: pull.live ? "none" : "transform .22s var(--ease)" } : { transition: "transform .22s var(--ease)" }}
        >
          {list?.loading && ids.length === 0 ? (
            <div style={{ padding: 8 }}>
              {[...Array(12)].map((_, i) => (
                <div key={i} className="row" style={{ height: rowHeight, padding: "0 8px", gap: 12 }}>
                  <span className="skeleton" style={{ width: 32, height: 32, borderRadius: 16 }} />
                  <span className="skeleton" style={{ width: 140, height: 14 }} />
                  <span className="skeleton grow" style={{ height: 14 }} />
                  <span className="skeleton" style={{ width: 50, height: 12 }} />
                </div>
              ))}
            </div>
          ) : ids.length === 0 && list && !list.loading ? (
            <Empty icon={isSearch ? <Search size={40} /> : <Inbox size={40} />} title={isSearch ? t("No results") : mailbox?.role === "inbox" ? t("You're all caught up") : t("Nothing here")}>
              {isSearch ? t("Try different keywords or filters.") : mailbox?.role === "inbox" ? t("No new mail in your inbox.") : t("This folder is empty.")}
            </Empty>
          ) : (
            <div className="mail-list-inner" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((vi) => {
                const id = ids[vi.index];
                if (!id) {
                  return (
                    <div key="loader" className="list-footer" style={{ position: "absolute", top: vi.start, left: 0, right: 0, height: vi.size }}>
                      {list?.loadingMore ? <span className="spinner" style={{ display: "inline-block" }} /> : ""}
                    </div>
                  );
                }
                const e = emails[id];
                if (!e) return <div key={id} style={{ position: "absolute", top: vi.start, height: vi.size }} />;
                const thread = list?.collapseThreads ? threads[e.threadId] : undefined;
                const strip = swiping?.id === id ? swiping : null;
                return (
                  <Fragment key={id}>
                    {/*
                      What the row is sliding off to reveal. Only ever one of
                      these exists, under the row being dragged, painted into the
                      same slot the row occupies — the row's own background is
                      opaque, so it covers this until the finger moves it.
                    */}
                    {strip && (
                      <div
                        className={`msg-swipe ${strip.desc.tone} ${strip.armed ? "armed" : ""} ${strip.dir === 1 ? "from-left" : "from-right"}`}
                        style={{ top: vi.start, height: vi.size }}
                        aria-hidden="true"
                      >
                        <span className="msg-swipe-act">
                          {SWIPE_ICON[strip.desc.icon]}
                          <span>{t(strip.desc.label)}</span>
                        </span>
                      </div>
                    )}
                    <Row
                      email={e}
                      threadEmails={thread ? thread.emailIds.map((x) => emails[x]).filter((x): x is Email => Boolean(x)) : undefined}
                      top={vi.start}
                      height={vi.size}
                      selected={Boolean(selected[id])}
                      focused={focusId === id}
                      open={openThreadId === e.threadId}
                      twoLine={twoLine}
                      showAvatar={settings.showAvatars}
                      showPreview={settings.showPreview}
                      isDrafts={isDrafts}
                      mailboxId={mailboxId}
                      isSent={mailbox?.role === "sent"}
                      onClick={onRowClick}
                      onContext={onContext}
                      onSelect={(rowId, on) => { select([rowId], on); lastClick.current = rowId; }}
                      onStar={(rowId, on) => void actions.star(on, [rowId])}
                      onArchive={(rowId) => void actions.archive([rowId])}
                      onTrash={(rowId) => void actions.trash([rowId])}
                      onRead={(rowId, read) => void actions.read(read, [rowId])}
                      selectedIds={selected}
                      touch={isTouch}
                      role={mailbox?.role ?? null}
                      swipeLeft={settings.swipeLeft}
                      swipeRight={settings.swipeRight}
                      onLongPress={onLongPress}
                      onSwipeState={onSwipeState}
                      onSwipeFire={fireSwipe}
                    />
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <Popover anchor={ctxMenu.anchor} onClose={ctxMenu.close} width={250}>
        <MenuItem icon={<Reply size={16} />} label={t("Reply")} onClick={() => { const e = ctxRow ? emails[ctxRow] : undefined; if (e) void useCompose.getState().reply(e, "reply"); }} />
        <MenuItem icon={<Forward size={16} />} label={t("Forward")} onClick={() => { const e = ctxRow ? emails[ctxRow] : undefined; if (e) void useCompose.getState().reply(e, "forward"); }} />
        <MenuItem icon={<Paperclip size={16} />} label={t("Forward as attachment")} onClick={() => { const e = ctxRow ? emails[ctxRow] : undefined; if (e) useCompose.getState().forwardAsAttachment(e); }} />
        <MenuItem icon={<MailPlus size={16} />} label={t("Compose as new")} onClick={() => { const e = ctxRow ? emails[ctxRow] : undefined; if (e) void useCompose.getState().composeAsNew(e); }} />
        <MenuSep />
        <MenuItem icon={<Archive size={16} />} label={t("Archive")} kbd="e" onClick={() => void actions.archive(ctxTargets)} />
        <MenuItem icon={<CalendarRange size={16} />} label={archiveDateLabel("year")} onClick={() => void useMail.getState().archiveByDate(ctxTargets, "year")} />
        <MenuItem icon={<CalendarDays size={16} />} label={archiveDateLabel("month")} onClick={() => void useMail.getState().archiveByDate(ctxTargets, "month")} />
        <MenuItem icon={<Trash2 size={16} />} label={t("Delete")} kbd="#" onClick={() => void actions.trash(ctxTargets)} />
        <MenuItem icon={<AlertOctagon size={16} />} label={mailbox?.role === "junk" ? "Not spam" : "Report spam"} kbd="!" onClick={() => void actions.spam(ctxTargets)} />
        <MenuSep />
        <MenuItem icon={someUnread ? <MailOpen size={16} /> : <Mail size={16} />} label={someUnread ? "Mark as read" : "Mark as unread"} onClick={() => void actions.read(someUnread, ctxTargets)} />
        <MenuItem icon={<Star size={16} />} label={someUnstarred ? "Add star" : "Remove star"} kbd="s" onClick={() => void actions.star(someUnstarred, ctxTargets)} />
        <MenuItem icon={<FolderInput size={16} />} label={t("Move to…")} kbd="v" onClick={() => actions.move(ctxTargets)} />
        <MenuItem icon={<Tag size={16} />} label={t("Label…")} kbd="l" onClick={() => actions.label(ctxTargets, ctxMenu.anchor ?? { x: 0, y: 0 })} />
        <MenuSep />
        <MenuItem icon={<Filter size={16} />} label={t("Filter messages like this…")} onClick={() => { const e = ctxRow ? emails[ctxRow] : undefined; if (e) setFilterFrom(e); }} />
        {hasCalendar && <MenuItem icon={<CalendarPlus size={16} />} label={t("Create event…")} onClick={() => { const e = ctxRow ? emails[ctxRow] : undefined; if (e) void startAppointment(e, navigate).catch((err: unknown) => toast.error((err as Error).message)); }} />}
      </Popover>
      {filterFrom && <FilterFromMessageDialog email={filterFrom} mailboxId={mailboxId} onClose={() => setFilterFrom(null)} />}
    </div>
  );
}

interface RowProps {
  email: Email;
  threadEmails?: Email[];
  top: number;
  height: number;
  selected: boolean;
  focused: boolean;
  open: boolean;
  twoLine: boolean;
  showAvatar: boolean;
  showPreview: boolean;
  isDrafts: boolean;
  isSent: boolean;
  mailboxId: Id | null;
  selectedIds: Record<Id, true>;
  onClick: (e: MouseEvent, id: Id) => void;
  onContext: (e: MouseEvent, id: Id) => void;
  onSelect: (id: Id, on: boolean) => void;
  onStar: (id: Id, on: boolean) => void;
  onArchive: (id: Id) => void;
  onTrash: (id: Id) => void;
  onRead: (id: Id, read: boolean) => void;
  /** Whether this list is being pointed at with a finger. */
  touch: boolean;
  role: string | null;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  onLongPress: (id: Id) => void;
  onSwipeState: (id: Id, state: { dir: -1 | 1; armed: boolean; desc: SwipeDescriptor } | null) => void;
  onSwipeFire: (id: Id, desc: SwipeDescriptor) => Promise<void>;
}

const Row = memo(function Row({ email: e, threadEmails, top, height, selected, focused, open, twoLine, showAvatar, showPreview, isDrafts, isSent, mailboxId, selectedIds, onClick, onContext, onSelect, onStar, onArchive, onTrash, onRead, touch, role, swipeLeft, swipeRight, onLongPress, onSwipeState, onSwipeFire }: RowProps) {
  const labels = useSettings((s) => s.settings.labels);
  // Subscribed purely so the row re-renders when the date format changes.
  useSettings((s) => dateTimeKey(s.settings));
  const inScope = threadEmails ? threadEmails.filter((x) => (mailboxId ? x.mailboxIds[mailboxId] : true)) : [e];
  const scope = inScope.length ? inScope : [e];
  const unread = scope.some((x) => !x.keywords.$seen);
  const starred = scope.some((x) => x.keywords.$flagged);
  const hasAtt = scope.some((x) => x.hasAttachment);
  const answered = e.keywords.$answered;
  const forwarded = e.keywords.$forwarded;
  const latest = scope.reduce((a, b) => (a.receivedAt > b.receivedAt ? a : b), scope[0]!);
  const count = threadEmails ? scope.length : 0;
  // Participants: Gmail-style "Ann, Bob, Me (3)"
  const names = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const src = isSent || isDrafts ? scope.flatMap((x) => x.to ?? []) : scope.map((x) => x.from?.[0]).filter(Boolean);
    for (const a of src) {
      if (!a) continue;
      const k = a.email.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(count > 1 ? shortName(a) : displayName(a));
    }
    return out;
  }, [scope, isSent, isDrafts, count]);
  const who = (isSent || isDrafts ? (names.length ? `To: ${names.join(", ")}` : "(no recipients)") : names.join(", ")) || "(unknown)";
  const rowLabels = labels.filter((l) => scope.some((x) => x.keywords[l.keyword]));

  /*
   * How far this row has been dragged from home, and whether it is currently
   * animating back. Kept here rather than in the list so that a moving finger
   * re-renders one row instead of the whole virtualised list; the list is told
   * only the three things the strip behind the row needs -- which row, which
   * way, and whether letting go now would fire.
   */
  const [dx, setDx] = useState(0);
  const [gliding, setGliding] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const descFor = useCallback(
    (dir: -1 | 1) => describeSwipe(dir === 1 ? swipeRight : swipeLeft, { role, unread, starred }),
    [swipeLeft, swipeRight, role, unread, starred],
  );
  // A row that scrolls out from under a live gesture takes its strip with it.
  useEffect(() => () => onSwipeState(e.id, null), [e.id, onSwipeState]);

  const gesture = useTouchRow({
    enabled: touch,
    onLongPress: () => onLongPress(e.id),
    canSwipe: (dir) => Boolean(descFor(dir)),
    onSwipeMove: (offset, dir, armed) => {
      const desc = descFor(dir);
      if (!desc) return;
      setGliding(false);
      setDx(offset);
      onSwipeState(e.id, { dir, armed, desc });
    },
    onSwipeEnd: (dir) => {
      setGliding(true);
      const desc = dir ? descFor(dir) : null;
      if (!desc) {
        setDx(0);
        onSwipeState(e.id, null);
        return;
      }
      const settle = () => {
        setDx(0);
        onSwipeState(e.id, null);
      };
      if (!desc.removes) {
        settle();
        void onSwipeFire(e.id, desc);
        return;
      }
      /*
       * An action that empties the row sees it out first: the row leaves the
       * way the finger was taking it, and the list closes the gap behind it.
       * Snapping home and vanishing a frame later reads as a misfire.
       *
       * It still settles afterwards, because "removes" is what the action
       * means to do rather than what it did -- a delete the reader cancels at
       * the confirmation leaves the row here, and it has to come back.
       */
      setDx(dir * (rowRef.current?.offsetWidth ?? 400));
      window.setTimeout(() => {
        void Promise.resolve(onSwipeFire(e.id, desc)).finally(settle);
      }, 160);
    },
  });

  const onDragStart = (ev: DragEvent) => {
    const ids = selectedIds[e.id] ? Object.keys(selectedIds) : [e.id];
    // include thread emails in scope
    const all = new Set<Id>();
    for (const id of ids) {
      all.add(id);
    }
    for (const x of scope) all.add(x.id);
    ev.dataTransfer.setData("application/x-ihasmail-emails", JSON.stringify([...all]));
    ev.dataTransfer.effectAllowed = "move";
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = ids.length > 1 ? plural(ids.length, { one: "{n} conversation", other: "{n} conversations" }) : e.subject || t("(no subject)");
    document.body.appendChild(ghost);
    ev.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove(), 0);
  };

  return (
    <div
      ref={rowRef}
      className={`msg-row ${unread ? "unread" : ""} ${selected ? "selected" : ""} ${focused ? "focused" : ""} ${open ? "open" : ""} ${dx ? "swiping" : ""}`}
      style={{ top, height, ...(dx ? { transform: `translateX(${dx}px)` } : {}), transition: gliding ? "transform .18s var(--ease)" : "none" }}
      data-row-id={e.id}
      onClick={(ev) => onClick(ev, e.id)}
      onContextMenu={(ev) => onContext(ev, e.id)}
      /*
       * Dragging a row into a folder is a mouse gesture, and on a touchscreen
       * it is the browser's idea of a long press — the same press that now
       * opens selection. Only one of them can have it.
       */
      draggable={!touch}
      onDragStart={onDragStart}
      {...gesture}
      role="row"
      aria-selected={selected}
    >
      <input type="checkbox" className="msg-check" checked={selected} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => onSelect(e.id, ev.target.checked)} aria-label={t("Select")} />
      {!twoLine && (
        <button className={`msg-star ${starred ? "on" : ""}`} onClick={(ev) => { ev.stopPropagation(); onStar(e.id, !starred); }} aria-label={starred ? "Unstar" : "Star"}>
          <Star size={18} fill={starred ? "currentColor" : "none"} />
        </button>
      )}
      {showAvatar && <Avatar who={isSent || isDrafts ? (e.to?.[0] ?? null) : (latest.from?.[0] ?? null)} />}
      {twoLine ? (
        <div className="msg-body">
          <div className="msg-line1">
            <span className="msg-from truncate notranslate" translate="no">
              <span className="truncate">{who}</span>
              {count > 1 && <span className="thread-count"> {count}</span>}
            </span>
            <span className="msg-meta">
              {hasAtt && <Paperclip size={14} className="msg-attach" />}
              <span className="msg-date">{formatListDate(latest.receivedAt)}</span>
            </span>
          </div>
          <div className="msg-main">
            {isDrafts && <span style={{ color: "var(--danger)" }}>{t("Draft")}</span>}
            <span className="msg-subject notranslate" translate="no">{e.subject || t("(no subject)")}</span>
            {showPreview && <span className="msg-preview notranslate" translate="no">{latest.preview}</span>}
            <button className={`msg-star ${starred ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={(ev) => { ev.stopPropagation(); onStar(e.id, !starred); }} aria-label={t("Star")}>
              <Star size={16} fill={starred ? "currentColor" : "none"} />
            </button>
          </div>
          {rowLabels.length > 0 && <div className="msg-labels">{rowLabels.map((l) => <span key={l.keyword} className="tag" style={{ background: l.color }}>{l.name}</span>)}</div>}
        </div>
      ) : (
        <>
          <span className="msg-from notranslate" translate="no" title={who}>
            <span className="truncate">{who}</span>
            {count > 1 && <span className="thread-count">{count}</span>}
          </span>
          <span className="msg-main">
            {isDrafts && <span style={{ color: "var(--danger)", flex: "0 0 auto" }}>{t("Draft")}</span>}
            {rowLabels.length > 0 && <span className="msg-labels">{rowLabels.map((l) => <span key={l.keyword} className="tag" style={{ background: l.color }}>{l.name}</span>)}</span>}
            <span className="msg-subject notranslate" translate="no">{e.subject || t("(no subject)")}</span>
            {showPreview && <span className="msg-preview notranslate" translate="no">{latest.preview}</span>}
          </span>
          <span className="msg-meta">
            {(answered || forwarded) && <span className="msg-answered" title={answered ? t("Replied") : t("Forwarded")}>{answered ? <Reply size={14} /> : <Forward size={14} />}</span>}
            {hasAtt && <Paperclip size={14} className="msg-attach" />}
            <span className="msg-date">{formatListDate(latest.receivedAt)}</span>
            <span className="msg-actions">
              <button className="icon-btn sm" title={t("Archive")} onClick={(ev) => { ev.stopPropagation(); onArchive(e.id); }}><Archive size={16} /></button>
              <button className="icon-btn sm" title={t("Delete")} onClick={(ev) => { ev.stopPropagation(); onTrash(e.id); }}><Trash2 size={16} /></button>
              <button className="icon-btn sm" title={unread ? t("Mark as read") : t("Mark as unread")} onClick={(ev) => { ev.stopPropagation(); onRead(e.id, unread); }}>{unread ? <MailOpen size={16} /> : <Mail size={16} />}</button>
            </span>
          </span>
        </>
      )}
    </div>
  );
});
