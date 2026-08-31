import { useState } from "react";
import { AlignLeft, Bell, Calendar as CalIcon, Check, Clock, HelpCircle, Link2, MapPin, Pencil, Repeat, Trash2, Users, X, Mail } from "lucide-react";
import { useCalendar, myParticipantKeys, isRecurring, isOccurrence, eventRule, participantEmail, type EventInstance, type EventScope } from "@/store/calendar";
import { Popover, type Anchor } from "@/ui/popover";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { askDeleteScope, runScoped } from "./scope";
import { formatTimeRange, humanDuration, parseDuration } from "@/lib/dates";
import { describeRule } from "@/lib/recurrence";
import { useCompose } from "@/store/compose";
import { useSettings } from "@/store/settings";
import { categoryOf, eventColor } from "./CalendarContextMenu";
import { t } from "@/lib/i18n";

export function EventPopover({ inst, anchor, onClose, onEdit }: { inst: EventInstance; anchor: Anchor; onClose: () => void; onEdit: () => void }) {
  const cal = useCalendar();
  const ev = inst.event;
  const [busy, setBusy] = useState(false);
  const categories = useSettings((s) => s.settings.eventCategories);
  const color = eventColor(ev, inst.calendar?.color, categories);
  const category = categoryOf(ev, categories);
  const participants = Object.entries(ev.participants ?? {});
  const myKeys = myParticipantKeys(ev, cal.identities);
  const myStatus = myKeys.length ? ev.participants?.[myKeys[0]!]?.participationStatus : undefined;
  const isOrganizer = ev.isOrigin !== false && (!participants.length || participants.some(([k, p]) => p.roles?.owner && myKeys.includes(k)));
  const canEdit = inst.calendar?.myRights.mayWriteAll || (inst.calendar?.myRights.mayWriteOwn && isOrganizer) || !inst.calendar;
  const location = Object.values(ev.locations ?? {})[0];
  const vloc = Object.values(ev.virtualLocations ?? {})[0];
  const alerts = Object.values(ev.alerts ?? {});
  const openCompose = useCompose((s) => s.open);

  const del = async () => {
    // A series asks which; anything else is a plain confirm. `askDeleteScope`
    // returns null for a dismissed dialog, which is a cancel and not a series.
    let scope: EventScope | null = "series";
    if (isRecurring(ev) && isOccurrence(ev)) {
      scope = await askDeleteScope(ev);
    } else {
      const ok = await confirmDialog({ title: t("Delete this event?"), confirmLabel: t("Delete"), danger: true });
      if (!ok) scope = null;
    }
    if (!scope) return;
    setBusy(true);
    try {
      await runScoped(scope, (s) => cal.destroyEvent(ev, participants.length > 1, s));
      toast.success(scope === "occurrence" ? "Occurrence deleted" : "Event deleted");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rsvp = async (status: "accepted" | "tentative" | "declined") => {
    setBusy(true);
    try {
      await cal.rsvp(ev, status);
      toast.success(t("Response sent"));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="event-popover" closeOnClick={false} side="right" role="dialog" style={{ "--ev-color": color } as React.CSSProperties}>
      <div className="row" style={{ justifyContent: "flex-end", gap: 0, marginBottom: -4 }}>
        {canEdit && <button className="icon-btn sm" title={t("Edit")} onClick={onEdit}><Pencil size={16} /></button>}
        {canEdit && <button className="icon-btn sm danger" title={t("Delete")} onClick={() => void del()} disabled={busy}><Trash2 size={16} /></button>}
        <button className="icon-btn sm" title={t("Close")} onClick={onClose}><X size={16} /></button>
      </div>
      <h3>{ev.title || "(untitled)"}</h3>
      <div className="ev-line"><Clock size={15} /><span>{formatTimeRange(inst.start, inst.end, inst.allDay)}{ev.timeZone && !inst.allDay ? <span className="hint"> · {ev.timeZone}</span> : null}</span></div>
      {eventRule(ev) && <div className="ev-line"><Repeat size={15} /><span>{describeRule(eventRule(ev)!)}</span></div>}
      {location?.name && <div className="ev-line"><MapPin size={15} /><span>{location.name}</span></div>}
      {vloc?.uri && <div className="ev-line"><Link2 size={15} /><a href={vloc.uri} target="_blank" rel="noreferrer" className="truncate">{vloc.name || vloc.uri}</a></div>}
      {ev.description && <div className="ev-line"><AlignLeft size={15} /><span style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{ev.description}</span></div>}
      {alerts.length > 0 && <div className="ev-line"><Bell size={15} /><span>{alerts.map((a) => ("offset" in a.trigger ? humanDuration(parseDuration(a.trigger.offset)) + (parseDuration(a.trigger.offset) < 0 ? " before" : " after") : "at " + a.trigger.when)).join(", ")}</span></div>}
      {category && <div className="ev-line"><span className="label-dot" style={{ background: category.color, width: 12, height: 12, marginTop: 3 }} /><span>{category.name}</span></div>}
      <div className="ev-line"><CalIcon size={15} /><span>{`${inst.calendar?.name ?? "Calendar"}${ev.status === "cancelled" ? " · cancelled" : ev.status === "tentative" ? " · tentative" : ""}${ev.privacy && ev.privacy !== "public" ? ` · ${ev.privacy}` : ""}${ev.freeBusyStatus === "free" ? " · shown as free" : ""}`}</span></div>
      {participants.length > 0 && (
        <div className="ev-line" style={{ flexDirection: "column", gap: 2 }}>
          <div className="row gap-8"><Users size={15} /><span>{`${participants.length} participant${participants.length === 1 ? "" : "s"}`}</span><button className="icon-btn xs" title={t("Email everyone")} onClick={() => openCompose({ to: participants.map(([, p]) => ({ name: p.name ?? null, email: participantEmail(p) })).filter((a) => a.email), subject: ev.title ?? "" })}><Mail size={13} /></button></div>
          <div style={{ paddingLeft: 24, maxHeight: 140, overflow: "auto", width: "100%" }}>
            {participants.map(([k, p]) => (
              <div key={k} className="participant-row">
                <span className={`p-status ${p.participationStatus ?? "needs-action"}`} title={p.participationStatus ?? "needs-action"} />
                <span className="truncate">{p.name || participantEmail(p)}</span>
                {p.roles?.owner && <span className="hint">{t("organizer")}</span>}
                {p.roles?.optional && <span className="hint">{t("optional")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {myKeys.length > 0 && !isOrganizer && (
        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          <span className="hint">{t("Going?")}</span>
          <button className={`btn btn-sm ${myStatus === "accepted" ? "btn-primary" : ""}`} disabled={busy} onClick={() => void rsvp("accepted")}><Check size={14} />  {t("Yes")}</button>
          <button className={`btn btn-sm ${myStatus === "tentative" ? "btn-primary" : ""}`} disabled={busy} onClick={() => void rsvp("tentative")}><HelpCircle size={14} />  {t("Maybe")}</button>
          <button className={`btn btn-sm ${myStatus === "declined" ? "btn-danger" : ""}`} disabled={busy} onClick={() => void rsvp("declined")}><X size={14} />  {t("No")}</button>
        </div>
      )}
    </Popover>
  );
}
