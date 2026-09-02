import { useState } from "react";
import { useSettings, type ReadReceiptPolicy } from "@/store/settings";
import { useMail } from "@/store/mail";
import { domainOf } from "@/lib/address";
import { Switch } from "@/ui/misc";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { isEnforced } from "@/lib/settingsPolicy";

/**
 * Everything about what reaches a sender, and what asks before it happens.
 *
 * These settings were spread through General, which had grown into five
 * unrelated headings -- remote images filed under "Reading", the read-receipt
 * policy under "Composing", the undo-send window beside the default message
 * format. They are the same kind of decision and they belong together, and
 * gathering them leaves General smaller as well.
 *
 * The boundary against **Security & sessions** is worth keeping sharp, since
 * two similar words next to each other in a nav is how a menu becomes
 * something people hunt through: that section is credentials and access --
 * password, two-factor, app passwords, live sessions. This one is how the app
 * behaves towards the reader and towards senders.
 */
export function PrivacySettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const trusted = s.trustedImageSenders;
  const identities = useMail((st) => st.identities);
  const ownDomains = [...new Set(identities.map((i) => domainOf(i.email)).filter(Boolean))];

  return (
    <div>
      <h1>{t("Privacy & safety")}</h1>
      <p className="lead">{t("What reaches a sender, and what asks before it happens.")}</p>

      <h2>{t("Remote content")}</h2>
      <div className="field">
        <label>{t("Remote images")}</label>
        <select disabled={isEnforced("imagePolicy")} className="select" value={s.imagePolicy} onChange={(e) => update({ imagePolicy: e.target.value as typeof s.imagePolicy })}>
          <option value="ask">{t("Ask before showing (recommended)")}</option>
          <option value="contacts">{t("Show automatically from my contacts")}</option>
          <option value="always">{t("Always show")}</option>
        </select>
        <p className="hint">
          {t("An image loaded from a sender's server tells them the message was opened, when, and from roughly where. Approved images are fetched by ihasmail's own server rather than the browser, so the sender learns none of those.")}
        </p>
      </div>
      {trusted.length > 0 && (
        <div className="field">
          <label>{t("Always showing images from")}</label>
          <div className="trusted-senders">
            {trusted.map((addr) => (
              <span key={addr} className="chip">
                <span className="notranslate" translate="no">{addr}</span>
                <button
                  className="chip-x"
                  aria-label={t("Stop trusting {address}", { address: addr })}
                  onClick={() => update({ trustedImageSenders: trusted.filter((x) => x !== addr) })}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
          <p className="hint">{t("Added from a message, and removable here — previously the only way to undo one was to find another message from the same sender.")}</p>
        </div>
      )}

      <h2>{t("Read receipts")}</h2>
      <Switch locked={isEnforced("requestReadReceipt")} checked={s.requestReadReceipt} onChange={(v) => update({ requestReadReceipt: v })} label={t("Always request read receipts")} />
      <div className="field">
        <label>{t("When someone requests a read receipt")}</label>
        <select disabled={isEnforced("readReceiptPolicy")} className="select" value={s.readReceiptPolicy} onChange={(e) => update({ readReceiptPolicy: e.target.value as ReadReceiptPolicy })}>
          <option value="ask">{t("Ask me on each message")}</option>
          <option value="never">{t("Never send one")}</option>
        </select>
        <p className="hint">
          {t("A receipt tells whoever asked that this address is live and when the message was read, and the sender chooses where it goes — so there is no automatic option. Bulk mail, mailing lists and anything marked auto-submitted are never offered one at all.")}
        </p>
      </div>

      <h2>{t("Warnings")}</h2>
      <p className="hint" style={{ marginTop: -8 }}>
        {t("All three start switched off. A client that begins by interrupting is one people learn to click through, and a warning clicked through without reading costs the same attention and buys nothing.")}
      </p>

      <Switch
        checked={s.externalSenderBanner}
        onChange={(v) => update({ externalSenderBanner: v })}
        label={t("Mark messages from outside")}
        hint={t("A banner on any message whose sender is not on one of your own domains.")}
      />
      <Switch
        checked={s.externalRecipientConfirm}
        onChange={(v) => update({ externalRecipientConfirm: v })}
        label={t("Ask before sending outside")}
        hint={t("Names the outside recipients and asks, rather than refusing.")}
      />
      {(s.externalSenderBanner || s.externalRecipientConfirm) && (
        <DomainList
          label={t("Also count these domains as inside")}
          hint={t("Your own identity domains are always inside and do not need listing. A domain here also covers its subdomains.")}
          value={s.internalDomains}
          onChange={(internalDomains) => update({ internalDomains })}
          suggestions={ownDomains}
        />
      )}

      <div className="field">
        <label>{t("Ask before sending to a large group")}</label>
        <select disabled={isEnforced("replyAllThreshold")} className="select" value={String(s.replyAllThreshold)} onChange={(e) => update({ replyAllThreshold: Number(e.target.value) })}>
          <option value="0">{t("Never ask")}</option>
          <option value="5">{t("5 people or more")}</option>
          <option value="10">{t("10 people or more")}</option>
          <option value="20">{t("20 people or more")}</option>
          <option value="50">{t("50 people or more")}</option>
        </select>
        <p className="hint">{t("Counts people rather than headers, so one address in To and nine in Cc is a message to ten. Catches a reply-all onto a long thread.")}</p>
      </div>

      <Switch
        checked={s.externalLinkWarning}
        onChange={(v) => update({ externalLinkWarning: v })}
        label={t("Ask before opening a link in a message")}
        hint={t("A link whose text names one domain and whose destination is another is always flagged, even where the destination is trusted — being trusted is not the same as being the place the text claimed.")}
      />
      {s.externalLinkWarning && (
        <DomainList
          label={t("Open links to these domains without asking")}
          hint={t("Added here, or from the dialog when a link is opened. A domain also covers its subdomains.")}
          value={s.trustedLinkDomains}
          onChange={(trustedLinkDomains) => update({ trustedLinkDomains })}
        />
      )}

      <h2>{t("Before it happens")}</h2>
      <div className="field">
        <label>{t("Undo send window")}</label>
        <select disabled={isEnforced("undoSendSeconds")} className="select" value={String(s.undoSendSeconds)} onChange={(e) => update({ undoSendSeconds: Number(e.target.value) })}>
          <option value="0">{t("Off")}</option>
          <option value="5">{t("5 seconds")}</option>
          <option value="8">{t("8 seconds")}</option>
          <option value="15">{t("15 seconds")}</option>
          <option value="30">{t("30 seconds")}</option>
        </select>
        <p className="hint">{t("The message is held in this browser and has not been submitted yet, so taking it back costs nothing.")}</p>
      </div>
      <Switch locked={isEnforced("attachmentReminder")} checked={s.attachmentReminder} onChange={(v) => update({ attachmentReminder: v })} label={t("Attachment reminder")} hint={t("Warn when the message mentions an attachment but none is attached.")} />
      <Switch locked={isEnforced("confirmDelete")} checked={s.confirmDelete} onChange={(v) => update({ confirmDelete: v })} label={t("Confirm before deleting")} />
    </div>
  );
}

/**
 * A list of domains, added one at a time and removed by their chip.
 *
 * Typed entries are normalised on the way in -- a leading `@`, stray case, a
 * whole address pasted instead of a domain -- because the thing being compared
 * against is a hostname, and a list holding "@Example.com " silently matches
 * nothing at all.
 */
function DomainList({
  label,
  hint,
  value,
  onChange,
  suggestions = [],
}: {
  label: string;
  hint: string;
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const d = raw.trim().toLowerCase().replace(/^@/, "").replace(/^.*@/, "").replace(/^https?:\/\//, "").split("/")[0] ?? "";
    if (!d || value.includes(d)) {
      setDraft("");
      return;
    }
    onChange([...value, d]);
    setDraft("");
  };
  const missing = suggestions.filter((d) => !value.includes(d));
  return (
    <div className="field">
      <label>{label}</label>
      {value.length > 0 && (
        <div className="trusted-senders">
          {value.map((d) => (
            <span key={d} className="chip">
              <span className="notranslate" translate="no">{d}</span>
              <button className="chip-x" aria-label={t("Remove {domain}", { domain: d })} onClick={() => onChange(value.filter((x) => x !== d))}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row gap-4">
        <input
          className="input"
          value={draft}
          placeholder={t("example.com")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <button className="btn btn-sm" disabled={!draft.trim()} onClick={() => add(draft)}>{t("Add")}</button>
      </div>
      {missing.length > 0 && (
        <p className="hint">
          {t("Your own:")}{" "}
          {missing.map((d) => (
            <button key={d} className="link-btn notranslate" translate="no" onClick={() => add(d)}>{d}</button>
          ))}
        </p>
      )}
      <p className="hint">{hint}</p>
    </div>
  );
}
