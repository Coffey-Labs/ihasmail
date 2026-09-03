import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2, Users } from "lucide-react";
import type { BusyPeriod, CalendarEvent, EmailAddress, JSCalendarAlert, JSCalendarParticipant, JSCalendarRecurrenceRule, JSCalendarNDay } from "@/jmap/types";
import { useCalendar, myParticipantKeys, isRecurring, isOccurrence, eventRule, makeParticipant, participantEmail, type EventScope } from "@/store/calendar";
import { useSettings } from "@/store/settings";
import { useSession } from "@/store/session";
import { CAP } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import { Dialog } from "@/ui/dialog";
import { ColorSwatches, Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { RecipientInput } from "../compose/RecipientInput";
import { DateField, DateTimeField } from "@/ui/datefield";
import { browserTimeZone, dateToZonedLocal, formatDuration, fromInputDateTime, listTimeZones, parseDuration, toInputDateTime, toLocalDateOnly, zonedToDate, DAY_MS, humanDuration } from "@/lib/dates";
import { formatClock, formatNumericDate, formatWeekday, formatWeekdayDate } from "@/lib/datetime";
import { WEEKDAY_KEYS, weekdayOptions, describeRule, presetFor, ruleFromPreset, type RecurrencePreset } from "@/lib/recurrence";
import { newKey } from "@/lib/contacts";
import { availabilityWindow } from "@/lib/availabilityWindow";
import { askEditScope, droppedMessage, runScoped } from "./scope";
import { plural, t as translate } from "@/lib/i18n";

export interface EditorInit {
  event?: CalendarEvent;
  start: Date;
  end: Date;
  allDay: boolean;
  /**
   * Values a new event opens with, from wherever it was begun -- a message,
   * so far. Not an event: this is still a form the reader has to finish, so
   * `editing` stays false and the dialog says New event / Create.
   */
  seed?: { title?: string; description?: string; attendees?: EmailAddress[] };
}

const ALERT_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

/**
 * Fields this form always sends that a single occurrence will not take.
 *
 * `useDefaultAlerts` and `calendarIds` are refused with `invalidProperties`;
 * the rest are dropped from the patch while the response still reports
 * success. Both halves are reasons not to send them — the second more so,
 * because nothing would say it had happened.
 */
const OCCURRENCE_OMIT = new Set(["useDefaultAlerts", "calendarIds", "recurrenceRule", "privacy", "organizerCalendarAddress"]);

export function EventEditor({ init, onClose }: { init: EditorInit; onClose: () => void }) {
  const cal = useCalendar();
  const settings = useSettings((s) => s.settings);
  const session = useSession((s) => s.session);
  const [base, setBase] = useState<CalendarEvent | null | undefined>(init.event && !init.event.baseEventId ? init.event : undefined);
  const [scope, setScope] = useState<EventScope | undefined>(init.event?.baseEventId ? undefined : "series");
  const editing = Boolean(init.event);

  /*
   * Which event this form is even about has to be settled before it opens.
   *
   * A form populated from the master shows the series' start date, so editing
   * Wednesday's standup would offer to move Monday's — right for the series and
   * wrong for one date. So the scope is asked first, and the occurrence itself
   * is what the form loads when the answer is "this occurrence".
   */
  /*
   * Asked once per event, and deliberately not tied to the effect's lifetime.
   *
   * Two things make the obvious version wrong. A dialog is queued in a store
   * the moment it is requested, so it outlives the effect that asked for it: a
   * re-run queues a second prompt the first answer cannot retract, and the
   * reader is asked the same question twice. And gating the *answer* on a
   * cleanup flag is worse — React's StrictMode runs mount, cleanup, mount, so
   * the flag is already set by the time anyone clicks and the editor never
   * opens at all. The ref is what makes this once; the answer is applied
   * whenever it arrives.
   */
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const ev = init.event;
    if (!ev) { setBase(null); setScope("series"); return; }
    if (!ev.baseEventId) { setBase(ev); setScope("series"); return; }
    if (asked.current === ev.id) return;
    asked.current = ev.id;
    void (async () => {
      const chosen = isRecurring(ev) && isOccurrence(ev) ? await askEditScope(ev) : "series";
      if (!chosen) { onClose(); return; }
      setScope(chosen);
      if (chosen === "occurrence") setBase(ev);
      else void cal.getEvent(ev.baseEventId!).then(setBase);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init.event?.id]);

  if (base === undefined || scope === undefined) return null;
  return <EventForm key={base?.id ?? "new"} init={init} base={base} scope={scope} editing={editing} onClose={onClose} settingsTz={settings.timeZone ?? browserTimeZone} defaultAlert={settings.defaultAlertMinutes} myEmail={session?.username ?? ""} />;
}

function EventForm({ init, base, scope, editing, onClose, settingsTz, defaultAlert, myEmail }: { init: EditorInit; base: CalendarEvent | null; scope: EventScope; editing: boolean; onClose: () => void; settingsTz: string; defaultAlert: number; myEmail: string }) {
  /** This form is editing one date rather than the series behind it. */
  const oneDate = scope === "occurrence";
  const cal = useCalendar();
  const contacts = useContacts();
  const ev = base;
  const calendars = Object.values(cal.calendars).filter((c) => c.myRights.mayWriteAll || c.myRights.mayWriteOwn);
  const initialCal = ev ? Object.keys(ev.calendarIds)[0] : (calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id);
  const evTz = ev?.timeZone ?? settingsTz;
  const baseStart = ev ? zonedToDate(ev.start, ev.showWithoutTime ? null : evTz) : init.start;
  const baseEnd = ev ? new Date(baseStart.getTime() + (parseDuration(ev.duration) || (ev.showWithoutTime ? 86400 : 3600)) * 1000) : init.end;

  const [title, setTitle] = useState(ev?.title ?? init.seed?.title ?? "");
  const [calendarId, setCalendarId] = useState(initialCal ?? "");
  const [allDay, setAllDay] = useState(ev ? Boolean(ev.showWithoutTime) : init.allDay);
  const [start, setStart] = useState(baseStart);
  const [end, setEnd] = useState(baseEnd);
  const [tz, setTz] = useState(evTz);
  const [location, setLocation] = useState(Object.values(ev?.locations ?? {})[0]?.name ?? "");
  const [vurl, setVurl] = useState(Object.values(ev?.virtualLocations ?? {})[0]?.uri ?? "");
  const [description, setDescription] = useState(ev?.description ?? init.seed?.description ?? "");
  const [status, setStatus] = useState<NonNullable<CalendarEvent["status"]>>(ev?.status ?? "confirmed");
  const [privacy, setPrivacy] = useState<NonNullable<CalendarEvent["privacy"]>>(ev?.privacy ?? "public");
  const [freeBusy, setFreeBusy] = useState<NonNullable<CalendarEvent["freeBusyStatus"]>>(ev?.freeBusyStatus ?? "busy");
  const [color, setColor] = useState<string | null>(ev?.color ?? null);
  const categories = useSettings((s) => s.settings.eventCategories);
  const [category, setCategory] = useState<string>(() => Object.keys(ev?.categories ?? {}).find((n) => categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) ?? "");
  const [rule, setRule] = useState<JSCalendarRecurrenceRule | undefined>(ev ? eventRule(ev) : undefined);
  const [preset, setPreset] = useState<RecurrencePreset>(presetFor(ev ? eventRule(ev) : undefined));
  const [alerts, setAlerts] = useState<number[]>(() => {
    const a = Object.values(ev?.alerts ?? {}).map((x) => ("offset" in x.trigger ? -parseDuration(x.trigger.offset) / 60 : 0)).filter((n) => n >= 0);
    if (ev) return a;
    return defaultAlert >= 0 ? [defaultAlert] : [];
  });
  const myKeys = ev ? myParticipantKeys(ev, cal.identities) : [];
  const [attendees, setAttendees] = useState<EmailAddress[]>(() =>
    ev
      ? Object.entries(ev.participants ?? {})
          .filter(([k, p]) => !myKeys.includes(k) && !(p.roles?.owner && !p.roles?.attendee))
          .map(([, p]) => ({ name: p.name ?? null, email: participantEmail(p) }))
          .filter((a) => a.email)
      : (init.seed?.attendees ?? []),
  );
  /*
   * Off when the guest list was not typed but inherited -- from a message, so
   * far -- and on everywhere else, which is every event whose guests somebody
   * chose one at a time.
   *
   * A reminder made out of a bill carries the biller and everyone else the
   * mail went to. Left on, the primary button reads Send invites, and the
   * first press mails all of them an invitation to the reader's private note
   * to self. The switch is right there and says what it does, so inviting them
   * is one deliberate click; un-sending is not.
   */
  const [sendInvites, setSendInvites] = useState(!init.seed?.attendees?.length);
  const [busy, setBusy] = useState(false);
  /** By address: the busy periods, or `null` for "there is no free/busy to read". */
  const [fb, setFb] = useState<Record<string, BusyPeriod[] | null>>({});
  /** Days the panel has been stepped away from the event, for looking around it. */
  const [fbOffset, setFbOffset] = useState(0);
  /** Where the pointer is over the grid, so the time a click would set is visible before it does. */
  const [fbHover, setFbHover] = useState<Date | null>(null);
  const [showMore, setShowMore] = useState(Boolean(ev && (ev.privacy !== "public" || ev.freeBusyStatus === "free" || ev.color || ev.status !== "confirmed" || Object.keys(ev.categories ?? {}).length)));

  const identity = cal.identities.find((i) => i.isDefault) ?? cal.identities[0];
  const myAddress = identity?.calendarAddress ?? (myEmail.includes("@") ? `mailto:${myEmail}` : "");
  const myPlainEmail = myAddress.replace(/^mailto:/i, "");

  /*
   * What the bars cover: whole days, from the day the event starts to the day
   * it ends. It used to be the start day and nothing else, which meant an event
   * spanning two days showed availability for one of them without saying so.
   */
  const fbWindow = useMemo(() => availabilityWindow(start, end, { offsetDays: fbOffset }), [start, end, fbOffset]);
  /** Stalwart answers for your own account under its own id, which is the fallback when the directory does not list you. */
  const selfPrincipalId = useSession((st) => st.accountFor(CAP.principals));

  /*
   * Everyone the event concerns, you first. Scheduling around the other people
   * and not around yourself is how two things end up at the same time, and the
   * organiser's own calendar was the one row the panel never showed.
   */
  const people = useMemo(() => {
    const seen = new Set<string>();
    const out: { email: string; name: string; self: boolean }[] = [];
    if (myPlainEmail) {
      seen.add(myPlainEmail.toLowerCase());
      out.push({ email: myPlainEmail, name: translate("You"), self: true });
    }
    for (const a of attendees) {
      if (seen.has(a.email.toLowerCase())) continue;
      seen.add(a.email.toLowerCase());
      out.push({ email: a.email, name: a.name ?? a.email, self: false });
    }
    return out;
  }, [myPlainEmail, attendees]);

  /*
   * Free/busy, for everyone we can read it for.
   *
   * Only people the directory knows have any: free/busy is answered per
   * principal, and somebody outside the server -- a customer, anyone at another
   * domain -- is not one. Those are recorded as `null` rather than left out,
   * because a row that is missing from a grid reads as a row with nothing in
   * it, which is to say "free", which is the one thing we do not know.
   */
  useEffect(() => {
    if (!people.length || !contacts.principalsLoaded) {
      if (!contacts.principalsLoaded) void contacts.loadPrincipals();
      return;
    }
    let cancelled = false;
    (async () => {
      const out: Record<string, BusyPeriod[] | null> = {};
      for (const person of people) {
        /*
         * Your own row is never unknown. If the directory does not list you
         * under the address the identity sends from -- an alias, a name that
         * differs from the login -- the account is still yours to read, and
         * Stalwart answers for it under the account's own id.
         */
        const principalId =
          contacts.principals.find((x) => x.email?.toLowerCase() === person.email.toLowerCase())?.id ??
          (person.self ? selfPrincipalId : undefined);
        if (!principalId) {
          out[person.email] = null;
          continue;
        }
        try {
          out[person.email] = await cal.availability(principalId, fbWindow.start, fbWindow.end);
        } catch {
          out[person.email] = null;
        }
      }
      if (!cancelled) setFb(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people.map((p) => p.email).join(","), fbWindow.start.getTime(), fbWindow.end.getTime(), contacts.principalsLoaded, selfPrincipalId]);

  const onStartChange = (d: Date) => {
    if (Number.isNaN(d.getTime())) return;
    const dur = end.getTime() - start.getTime();
    setStart(d);
    setEnd(new Date(d.getTime() + Math.max(dur, allDay ? DAY_MS : 15 * 60_000)));
  };

  const save = async () => {
    if (!calendarId) {
      toast.error(translate("Choose a calendar"));
      return;
    }
    if (end <= start) {
      toast.error(translate("End must be after start"));
      return;
    }
    setBusy(true);
    try {
      const s = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : start;
      let e = allDay ? new Date(end.getFullYear(), end.getMonth(), end.getDate()) : end;
      if (allDay && e <= s) e = new Date(s.getTime() + DAY_MS);
      const participants: Record<string, JSCalendarParticipant> = {};
      if (attendees.length && myAddress) {
        participants.me = makeParticipant(myPlainEmail, identity?.name, "owner");
        for (const a of attendees) {
          // preserve existing status if the attendee was already there
          const existing = Object.values(ev?.participants ?? {}).find((p) => participantEmail(p).toLowerCase() === a.email.toLowerCase());
          participants[newKey("p")] = makeParticipant(a.email, a.name, "attendee", existing?.participationStatus);
        }
      }
      const alertObj: Record<string, JSCalendarAlert> = {};
      for (const m of alerts) alertObj[newKey("a")] = { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: formatDuration(-m * 60), relativeTo: "start" }, action: "display" };
      const obj: Record<string, unknown> = {
        title: title.trim() || "(untitled)",
        description: description.trim() || undefined,
        showWithoutTime: allDay,
        start: allDay ? `${toLocalDateOnly(s)}T00:00:00` : dateToZonedLocal(s, tz),
        timeZone: allDay ? null : tz,
        duration: formatDuration(Math.round((e.getTime() - s.getTime()) / 1000)),
        locations: location.trim() ? { [newKey("l")]: { "@type": "Location", name: location.trim() } } : undefined,
        virtualLocations: vurl.trim() ? { [newKey("v")]: { "@type": "VirtualLocation", uri: vurl.trim(), name: "Online meeting" } } : undefined,
        participants: Object.keys(participants).length ? participants : undefined,
        // Stalwart 0.16 names the organizer here; RFC 8984's replyTo is ignored.
        organizerCalendarAddress: Object.keys(participants).length && myAddress ? myAddress : undefined,
        alerts: Object.keys(alertObj).length ? alertObj : undefined,
        useDefaultAlerts: false,
        // Singular, and no array: Stalwart 0.16 rejects `recurrenceRules` outright (#30).
        recurrenceRule: rule ?? undefined,
        status,
        privacy,
        freeBusyStatus: freeBusy,
        color: color ?? (category ? categories.find((c) => c.name === category)?.color : undefined),
        categories: category ? { [category]: true } : undefined,
      };
      const invites = sendInvites && attendees.length > 0;
      if (ev) {
        /*
         * A single occurrence takes less than the series does. Four of the
         * fields this form always sends are among them — `useDefaultAlerts`
         * and `calendarIds` are refused outright, `recurrenceRule`,
         * `privacy` and `organizerCalendarAddress` are dropped in silence —
         * so they are left out here rather than sent and believed. The store
         * still checks; this is what stops it having to complain.
         */
        const source = oneDate
          ? Object.fromEntries(Object.entries(obj).filter(([k]) => !OCCURRENCE_OMIT.has(k)))
          : obj;
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(source)) patch[k] = v === undefined ? null : v;
        if (!oneDate && Object.keys(ev.calendarIds)[0] !== calendarId) patch.calendarIds = { [calendarId]: true };
        const dropped = await runScoped(scope, (s) => cal.updateEvent(ev, patch, invites, s));
        if (!dropped) { setBusy(false); return; }
        toast.success(droppedMessage(dropped) ?? (oneDate ? "This occurrence updated" : "Event updated"));
      } else {
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) if (v !== undefined) clean[k] = v;
        await cal.createEvent(clean as Partial<CalendarEvent>, calendarId, invites);
        toast.success(invites ? "Event created and invitations sent" : "Event created");
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const customRule = rule ?? { "@type": "RecurrenceRule", frequency: "weekly" as const };

  return (
    <Dialog open onClose={onClose} title={editing ? translate("Edit event") : translate("New event")} size="lg" footer={<><button className="btn" onClick={onClose}>{translate("Cancel")}</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? translate("Saving…") : editing ? translate("Save") : attendees.length && sendInvites ? translate("Send invites") : translate("Create")}</button></>}>
      <div className="event-form">
        {ev && isRecurring(ev) && (
          <div className="info-box mb-16">
            {oneDate
              ? `Editing ${formatNumericDate(start)} only — the rest of the series is unchanged. Repeat, calendar and privacy belong to the series and are not shown.`
              : "This is a recurring event — changes apply to the whole series."}
          </div>
        )}
        <div className="field"><input className="input" style={{ fontSize: "1.1em", height: 44 }} placeholder={translate("Add title")} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="time-row mb-8">
          {allDay ? (
            <>
              <DateField aria-label={translate("Starts")} value={toLocalDateOnly(start)} onChange={(v) => v && onStartChange(new Date(`${v}T00:00:00`))} />
              <span className="muted center">{translate("to")}</span>
              <DateField aria-label={translate("Ends")} value={toLocalDateOnly(new Date(end.getTime() - 1))} onChange={(v) => v && setEnd(new Date(new Date(`${v}T00:00:00`).getTime() + DAY_MS))} />
            </>
          ) : (
            <>
              <DateTimeField aria-label={translate("Starts")} value={toInputDateTime(start)} onChange={(v) => v && onStartChange(fromInputDateTime(v))} />
              <span className="muted center">{translate("to")}</span>
              <DateTimeField aria-label={translate("Ends")} value={toInputDateTime(end)} onChange={(v) => v && setEnd(fromInputDateTime(v))} />
            </>
          )}
        </div>
        <div className="row wrap" style={{ gap: 16, marginBottom: 8 }}>
          <label className="check"><input type="checkbox" checked={allDay} onChange={(e) => { setAllDay(e.target.checked); if (e.target.checked) { const s = new Date(start); s.setHours(0, 0, 0, 0); setStart(s); setEnd(new Date(s.getTime() + Math.max(DAY_MS, Math.ceil((end.getTime() - s.getTime()) / DAY_MS) * DAY_MS))); } }} />  {translate("All day")}</label>
          {!allDay && (
            <select className="select" style={{ width: "auto", height: 32 }} value={tz} onChange={(e) => setTz(e.target.value)} title={translate("Time zone")}>
              {!listTimeZones().includes(tz) && <option value={tz}>{tz}</option>}
              {listTimeZones().map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {!oneDate && (
          <select className="select" style={{ width: "auto", height: 32 }} value={preset} onChange={(e) => { const p = e.target.value as RecurrencePreset; setPreset(p); if (p === "custom") setRule(rule ?? { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ "@type": "NDay", day: WEEKDAY_KEYS[(start.getDay() + 6) % 7]! }] }); else setRule(ruleFromPreset(p, start)); }}>
            <option value="none">{translate("Does not repeat")}</option>
            <option value="daily">{translate("Daily")}</option>
            <option value="weekly">{translate("Weekly on {weekday}", { weekday: formatWeekday(start, "long") })}</option>
            <option value="weekdays">{translate("Every weekday")}</option>
            <option value="monthly">{translate("Monthly on day {day}", { day: start.getDate() })}</option>
            <option value="yearly">{translate("Yearly")}</option>
            <option value="custom">{translate("Custom…")}</option>
          </select>
          )}
        </div>
        {!oneDate && preset === "custom" && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <span>{translate("Repeat every")}</span>
              <input className="input" type="number" min={1} style={{ width: 70 }} value={customRule.interval ?? 1} onChange={(e) => setRule({ ...customRule, interval: Math.max(1, Number(e.target.value)) })} />
              <select className="select" style={{ width: "auto" }} value={customRule.frequency} onChange={(e) => setRule({ ...customRule, frequency: e.target.value as JSCalendarRecurrenceRule["frequency"], byDay: e.target.value === "weekly" ? customRule.byDay : undefined, byMonthDay: e.target.value === "monthly" ? [start.getDate()] : undefined })}>
                <option value="daily">{translate("day(s)")}</option><option value="weekly">{translate("week(s)")}</option><option value="monthly">{translate("month(s)")}</option><option value="yearly">{translate("year(s)")}</option>
              </select>
            </div>
            {customRule.frequency === "weekly" && (
              <div className="row" style={{ gap: 4, marginTop: 8 }}>
                {weekdayOptions().map((w) => {
                  const on = customRule.byDay?.some((d) => d.day === w.key);
                  return <button key={w.key} type="button" className={`btn btn-sm btn-pill ${on ? "btn-primary" : ""}`} style={{ width: 36, padding: 0 }} title={w.label} onClick={() => { const cur = customRule.byDay ?? []; const next: JSCalendarNDay[] = on ? cur.filter((d) => d.day !== w.key) : [...cur, { "@type": "NDay", day: w.key }]; setRule({ ...customRule, byDay: next.length ? next : undefined }); }}>{w.short}</button>;
                })}
              </div>
            )}
            <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
              <span>{translate("Ends")}</span>
              <select className="select" style={{ width: "auto" }} value={customRule.until ? "until" : customRule.count ? "count" : "never"} onChange={(e) => { const v = e.target.value; setRule({ ...customRule, until: v === "until" ? `${toLocalDateOnly(new Date(start.getTime() + 30 * DAY_MS))}T23:59:59` : undefined, count: v === "count" ? 10 : undefined }); }}>
                <option value="never">{translate("never")}</option><option value="until">{translate("on date")}</option><option value="count">{translate("after N times")}</option>
              </select>
              {customRule.until && <DateField aria-label={translate("Repeat until")} className="w-auto" value={customRule.until.slice(0, 10)} onChange={(v) => v && setRule({ ...customRule, until: `${v}T23:59:59` })} />}
              {customRule.count && <input className="input" type="number" min={1} style={{ width: 80 }} value={customRule.count} onChange={(e) => setRule({ ...customRule, count: Math.max(1, Number(e.target.value)) })} />}
            </div>
            <div className="hint mt-8">{describeRule(customRule)}</div>
          </div>
        )}
        <div className="field-row">
          <div className="field"><label>{translate("Calendar")}</label>
            <select className="select" value={calendarId} disabled={oneDate} title={oneDate ? translate("An occurrence cannot be moved to another calendar on its own") : undefined} onChange={(e) => setCalendarId(e.target.value)}>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field"><label>{translate("Location")}</label><input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={translate("Add location")} /></div>
        </div>
        <div className="field"><label>{translate("Meeting link")}</label><input className="input" value={vurl} onChange={(e) => setVurl(e.target.value)} placeholder={translate("https://meet.example.com/…")} /></div>
        <div className="field">
          <label><Users size={13} />  {translate("Guests")}</label>
          <div className="input" style={{ height: "auto", minHeight: 38, padding: "4px 8px" }}>
            <RecipientInput value={attendees} onChange={setAttendees} placeholder={translate("Add guests by name or email")} />
          </div>
          {attendees.length > 0 && (
            <>
              <Switch checked={sendInvites} onChange={setSendInvites} label={translate("Send invitation emails to guests")} />
              {people.length > 1 && (() => {
                /** Everything on a bar is placed as a fraction of the span it covers. */
                const pct = (from: number, to: number) => ({
                  left: `${((from - fbWindow.start.getTime()) / fbWindow.span) * 100}%`,
                  width: `${((to - from) / fbWindow.span) * 100}%`,
                });
                /** Where along the window a pointer is, as a moment. */
                const timeAt = (e: { clientX: number; currentTarget: Element }) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const frac = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
                  // Half-hourly: a bar is a few hundred pixels wide, and a
                  // minute of it is not something anybody can aim at.
                  const SNAP = 30 * 60_000;
                  return new Date(Math.round((fbWindow.start.getTime() + frac * fbWindow.span) / SNAP) * SNAP);
                };
                const known = people.filter((p) => fb[p.email]);
                // You are not a guest, so you are not counted as one -- and if
                // your own row cannot be read, that is not what this sentence
                // is about.
                const unknown = people.filter((p) => !p.self && fb[p.email] === null);
                const rangeLabel = fbWindow.days === 1
                  ? formatWeekdayDate(fbWindow.start)
                  : `${formatNumericDate(fbWindow.start)} – ${formatNumericDate(new Date(fbWindow.end.getTime() - 1))}`;
                return (
                  <div className="freebusy">
                    <div className="fb-head">
                      <button type="button" className="icon-btn sm" aria-label={translate("Earlier")} onClick={() => setFbOffset(fbOffset - fbWindow.days)}><ChevronLeft size={16} /></button>
                      <span className="fb-range">{rangeLabel}</span>
                      <button type="button" className="icon-btn sm" aria-label={translate("Later")} onClick={() => setFbOffset(fbOffset + fbWindow.days)}><ChevronRight size={16} /></button>
                      {fbOffset !== 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFbOffset(0)}>{translate("Back to the event")}</button>}
                      <span className="spacer" />
                      {/* The time a click would set, so placing an event is aimed rather than guessed. */}
                      <span className="hint">{fbHover ? (fbWindow.days === 1 ? formatClock(fbHover) : `${formatWeekday(fbHover, "short")} ${formatClock(fbHover)}`) : translate("Click to move the event")}</span>
                    </div>
                    <div className="fb-row fb-axis-row">
                      <span style={{ width: 140, flex: "none" }} />
                      <div className="fb-axis">
                        {fbWindow.ticks.filter((tk) => tk.major).map((tk) => (
                          <span key={tk.time.getTime()} className="fb-axis-label" style={{ left: `${tk.at * 100}%` }}>
                            {fbWindow.scale === "hours" ? formatClock(tk.time) : formatWeekday(tk.time, "short")}
                          </span>
                        ))}
                        <span className="fb-axis-label end">{fbWindow.scale === "hours" ? formatClock(fbWindow.end) : formatNumericDate(new Date(fbWindow.end.getTime() - 1))}</span>
                      </div>
                    </div>
                    {people.map((person) => {
                      const periods = fb[person.email];
                      const noData = periods === null;
                      return (
                        <div key={person.email} className="fb-row">
                          <span className={`truncate ${person.self ? "fb-self" : ""}`} style={{ width: 140, flex: "none" }} title={person.email}>{person.name}</span>
                          <div
                            className={`fb-bar ${noData ? "no-data" : ""}`}
                            role="button"
                            tabIndex={-1}
                            title={noData ? translate("No availability information for {who}", { who: person.email }) : undefined}
                            onMouseMove={(e) => setFbHover(timeAt(e))}
                            onMouseLeave={() => setFbHover(null)}
                            onClick={(e) => { onStartChange(timeAt(e)); setFbOffset(0); }}
                          >
                            {fbWindow.ticks.map((tk) => (
                              tk.at === 0 ? null : <span key={tk.time.getTime()} className={`fb-tick ${tk.major ? "major" : ""}`} style={{ left: `${tk.at * 100}%` }} />
                            ))}
                            {(periods ?? []).map((b, i) => {
                              const bs = Math.max(new Date(b.utcStart).getTime(), fbWindow.start.getTime());
                              const be = Math.min(new Date(b.utcEnd).getTime(), fbWindow.end.getTime());
                              if (be <= bs) return null;
                              return <span key={i} className="fb-busy" style={pct(bs, be)} title={`${b.busyStatus}: ${formatClock(new Date(b.utcStart))} – ${formatClock(new Date(b.utcEnd))}`} />;
                            })}
                            {fbHover && <span className="fb-guide" style={{ left: `${((fbHover.getTime() - fbWindow.start.getTime()) / fbWindow.span) * 100}%` }} />}
                            {!allDay && <span className="fb-window" style={pct(start.getTime(), end.getTime())} />}
                          </div>
                        </div>
                      );
                    })}
                    {fbWindow.daysHidden > 0 && (
                      <div className="hint">{plural(fbWindow.daysHidden, { one: "The event runs {n} day longer than this shows.", other: "The event runs {n} days longer than this shows." })}</div>
                    )}
                    {/* Said once, under the grid, rather than repeated on every
                        row that has nothing to show. */}
                    {unknown.length > 0 && (
                      <div className="hint">
                        {known.length === 0
                          ? translate("Nobody here has free/busy on this server, so none of these rows can say whether anyone is free.")
                          : plural(unknown.length, {
                              one: "{n} guest is not on this server, so there is no free/busy to read for them.",
                              other: "{n} guests are not on this server, so there is no free/busy to read for them.",
                            })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </div>
        <div className="field"><label>{translate("Description")}</label><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></div>
        <div className="field">
          <label>{translate("Reminders")}</label>
          <div className="alerts-list">
            {alerts.map((m, i) => (
              <div key={i} className="row">
                <select className="select" style={{ width: "auto" }} value={String(m)} onChange={(e) => setAlerts(alerts.map((x, j) => (j === i ? Number(e.target.value) : x)))}>
                  {[...new Set([...ALERT_OPTIONS, m])].sort((a, b) => a - b).map((o) => <option key={o} value={o}>{o === 0 ? "At time of event" : `${humanDuration(o * 60)} before`}</option>)}
                </select>
                <button className="icon-btn sm danger" onClick={() => setAlerts(alerts.filter((_, j) => j !== i))} aria-label={translate("Remove reminder")}><Trash2 size={16} /></button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setAlerts([...alerts, 10])}><Plus size={14} />  {translate("Add reminder")}</button>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowMore((v) => !v)}>{showMore ? "Fewer options" : "More options"}</button>
        {showMore && (
          <div className="mt-8">
            <div className="field-row">
              <div className="field"><label>{translate("Status")}</label><select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="confirmed">{translate("Confirmed")}</option><option value="tentative">{translate("Tentative")}</option><option value="cancelled">{translate("Cancelled")}</option></select></div>
              <div className="field"><label>{translate("Show as")}</label><select className="select" value={freeBusy} onChange={(e) => setFreeBusy(e.target.value as typeof freeBusy)}><option value="busy">{translate("Busy")}</option><option value="free">{translate("Free")}</option></select></div>
              {!oneDate && <div className="field"><label>{translate("Visibility")}</label><select className="select" value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)}><option value="public">{translate("Default")}</option><option value="private">{translate("Private")}</option><option value="secret">{translate("Secret")}</option></select></div>}
            </div>
            <div className="field"><label>{translate("Category")}</label>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">{translate("None")}</option>
                {categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div className="field"><label>{translate("Color")}</label><div className="row wrap"><ColorSwatches value={color} onChange={setColor} />{color && <button className="btn btn-ghost btn-sm" onClick={() => setColor(null)}>{category ? translate("Use category color") : translate("Use calendar color")}</button>}</div></div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
