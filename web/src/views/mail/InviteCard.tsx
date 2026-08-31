import { useEffect, useState } from "react";
import { Calendar, Check, HelpCircle, MapPin, X } from "lucide-react";
import { useLocation } from "wouter";
import type { CalendarEvent, Email, EmailBodyPart } from "@/jmap/types";
import { useCalendar, toInstance, myParticipantKeys, isAttendee, participantEmail } from "@/store/calendar";
import { formatTimeRange } from "@/lib/dates";
import { toast } from "@/ui/toast";
import { t } from "@/lib/i18n";

export function InviteCard({ email, part }: { email: Email; part: EmailBodyPart }) {
  const cal = useCalendar();
  const [, navigate] = useLocation();
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [existing, setExisting] = useState<CalendarEvent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cal.available || !part.blobId) return;
    let cancelled = false;
    cal
      .parseIcs(part.blobId)
      .then(async (evs) => {
        if (cancelled) return;
        setEvents(evs);
        const first = evs[0];
        if (first?.uid) setExisting(await cal.findByUid(first.uid));
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.blobId, cal.available]);

  if (!cal.available) return null;
  if (error) return null;
  const ev = events?.[0];
  if (!ev) return null;
  const method = (ev.method ?? "").toUpperCase();
  const inst = toInstance({ ...ev, id: "tmp", calendarIds: {} } as CalendarEvent, cal.calendars);
  const organizer = Object.values(ev.participants ?? {}).find((p) => p.roles?.owner);
  const location = Object.values(ev.locations ?? {})[0]?.name;
  const myStatus = existing ? (myParticipantKeys(existing, cal.identities).map((k) => existing.participants?.[k]?.participationStatus)[0] ?? null) : null;
  const attendees = Object.values(ev.participants ?? {}).filter(isAttendee);

  const respond = async (status: "accepted" | "tentative" | "declined") => {
    setBusy(status);
    try {
      let target = existing;
      if (!target) {
        const calId = Object.values(cal.calendars).find((c) => c.isDefault)?.id ?? Object.keys(cal.calendars)[0];
        if (!calId) throw new Error("No calendar available");
        const id = await cal.importEvent(ev, calId);
        target = await cal.getEvent(id);
      }
      if (!target) throw new Error("Could not add the event to your calendar");
      await cal.rsvp(target, status);
      setExisting(await cal.getEvent(target.id));
      toast.success(status === "accepted" ? "Invitation accepted" : status === "declined" ? "Invitation declined" : "Marked as tentative");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addToCalendar = async () => {
    setBusy("add");
    try {
      const calId = Object.values(cal.calendars).find((c) => c.isDefault)?.id ?? Object.keys(cal.calendars)[0];
      if (!calId) throw new Error("No calendar available");
      const id = await cal.importEvent(ev, calId);
      setExisting(await cal.getEvent(id));
      toast.success(t("Added to your calendar"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const title = method === "CANCEL" ? "Cancelled event" : method === "REPLY" ? "Invitation reply" : method === "REQUEST" ? (existing ? "Invitation (in your calendar)" : "Invitation") : "Event";

  return (
    <div className="invite-card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Calendar size={20} style={{ color: "var(--accent)", marginTop: 2 }} />
        <div className="grow">
          <div className="hint" style={{ marginBottom: 2 }}>{title}</div>
          <h4>{ev.title || "(untitled event)"}</h4>
          {inst && <div className="small">{`${formatTimeRange(inst.start, inst.end, inst.allDay)}${ev.timeZone ? ` (${ev.timeZone})` : ""}`}</div>}
          {location && <div className="small muted row gap-4"><MapPin size={13} /> {location}</div>}
          {organizer && <div className="small muted">{t("Organizer: {name}", { name: organizer.name || participantEmail(organizer) })}</div>}
          {attendees.length > 0 && <div className="small muted">{`${attendees.length} attendee${attendees.length === 1 ? "" : "s"}`}</div>}
          {method === "REPLY" && (
            <div className="small" style={{ marginTop: 4 }}>
              {attendees.map((a) => <div key={participantEmail(a) || a.name}>{a.name || participantEmail(a)}: <b>{a.participationStatus ?? "unknown"}</b></div>)}
            </div>
          )}
        </div>
      </div>
      {method !== "REPLY" && method !== "CANCEL" && (
        <div className="rsvp">
          {(method === "REQUEST" || attendees.length > 0) ? (
            <>
              <button className={`btn btn-sm ${myStatus === "accepted" ? "btn-primary" : ""}`} disabled={Boolean(busy)} onClick={() => void respond("accepted")}><Check size={14} /> {myStatus === "accepted" ? "Accepted" : "Yes"}</button>
              <button className={`btn btn-sm ${myStatus === "tentative" ? "btn-primary" : ""}`} disabled={Boolean(busy)} onClick={() => void respond("tentative")}><HelpCircle size={14} /> {myStatus === "tentative" ? "Tentative" : "Maybe"}</button>
              <button className={`btn btn-sm ${myStatus === "declined" ? "btn-danger" : ""}`} disabled={Boolean(busy)} onClick={() => void respond("declined")}><X size={14} /> {myStatus === "declined" ? "Declined" : "No"}</button>
            </>
          ) : (
            !existing && <button className="btn btn-sm" disabled={Boolean(busy)} onClick={() => void addToCalendar()}><Calendar size={14} />  {t("Add to calendar")}</button>
          )}
          {existing && inst && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/calendar/day/${inst.start.toISOString().slice(0, 10)}`)}>{t("Open in calendar")}</button>}
        </div>
      )}
      {method === "CANCEL" && existing && (
        <div className="rsvp">
          <button className="btn btn-sm btn-danger" disabled={Boolean(busy)} onClick={async () => { try { await cal.destroyEvent(existing, false, "series"); setExisting(null); toast.success(t("Removed from calendar")); } catch (err) { toast.error((err as Error).message); } }}>{t("Remove from calendar")}</button>
        </div>
      )}
      <span className="sr-only">{email.id}</span>
    </div>
  );
}
