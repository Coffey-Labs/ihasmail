import { useEffect, useState } from "react";
import { useMail } from "@/store/mail";
import { Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { toInputDateTime, fromInputDateTime, toUTCDate } from "@/lib/dates";
import { DateTimeField } from "@/ui/datefield";
import { client, CAP } from "@/jmap/client";
import { t } from "@/lib/i18n";

export function VacationSettings() {
  const vacation = useMail((s) => s.vacation);
  const load = useMail((s) => s.loadVacation);
  const save = useMail((s) => s.saveVacation);
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const available = client.hasCapability(CAP.vacation);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!vacation) return;
    setEnabled(vacation.isEnabled);
    setSubject(vacation.subject ?? "");
    setBody(vacation.textBody ?? "");
    setFrom(vacation.fromDate ? toInputDateTime(new Date(vacation.fromDate)) : "");
    setTo(vacation.toDate ? toInputDateTime(new Date(vacation.toDate)) : "");
  }, [vacation]);

  if (!available) return <div><h1>{t("Out of office")}</h1><p className="lead">{t("Vacation responses are not available for this account.")}</p></div>;

  const submit = async () => {
    setBusy(true);
    try {
      await save({
        isEnabled: enabled,
        subject: subject || null,
        textBody: body || null,
        htmlBody: null,
        fromDate: from ? toUTCDate(fromInputDateTime(from)) : null,
        toDate: to ? toUTCDate(fromInputDateTime(to)) : null,
      });
      toast.success(enabled ? "Auto-reply is on" : "Auto-reply saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>{t("Out of office")}</h1>
      <p className="lead">{t("Automatically reply to people who email you while you're away. Each sender gets at most one reply.")}</p>
      <Switch checked={enabled} onChange={setEnabled} label={t("Auto-reply enabled")} />
      <div className="field-row mt-16">
        <div className="field"><label>{t("Starts (optional)")}</label><DateTimeField aria-label={t("Starts")} value={from} onChange={setFrom} /></div>
        <div className="field"><label>{t("Ends (optional)")}</label><DateTimeField aria-label={t("Ends")} value={to} onChange={setTo} /></div>
      </div>
      <div className="field"><label>{t("Subject")}</label><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("Out of office")} /></div>
      <div className="field"><label>{t("Message")}</label><textarea className="textarea" rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("Thanks for your message. I'm away until … and will reply when I'm back.")} /></div>
      <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{t("Save")}</button>
    </div>
  );
}
