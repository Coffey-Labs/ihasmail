import { useSettings, type ReadReceiptPolicy } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";

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

  return (
    <div>
      <h1>{t("Privacy & safety")}</h1>
      <p className="lead">{t("What reaches a sender, and what asks before it happens.")}</p>

      <h2>{t("Remote content")}</h2>
      <div className="field">
        <label>{t("Remote images")}</label>
        <select className="select" value={s.imagePolicy} onChange={(e) => update({ imagePolicy: e.target.value as typeof s.imagePolicy })}>
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
      <Switch checked={s.requestReadReceipt} onChange={(v) => update({ requestReadReceipt: v })} label={t("Always request read receipts")} />
      <div className="field">
        <label>{t("When someone requests a read receipt")}</label>
        <select className="select" value={s.readReceiptPolicy} onChange={(e) => update({ readReceiptPolicy: e.target.value as ReadReceiptPolicy })}>
          <option value="ask">{t("Ask me on each message")}</option>
          <option value="never">{t("Never send one")}</option>
        </select>
        <p className="hint">
          {t("A receipt tells whoever asked that this address is live and when the message was read, and the sender chooses where it goes — so there is no automatic option. Bulk mail, mailing lists and anything marked auto-submitted are never offered one at all.")}
        </p>
      </div>

      <h2>{t("Before it happens")}</h2>
      <div className="field">
        <label>{t("Undo send window")}</label>
        <select className="select" value={String(s.undoSendSeconds)} onChange={(e) => update({ undoSendSeconds: Number(e.target.value) })}>
          <option value="0">{t("Off")}</option>
          <option value="5">{t("5 seconds")}</option>
          <option value="8">{t("8 seconds")}</option>
          <option value="15">{t("15 seconds")}</option>
          <option value="30">{t("30 seconds")}</option>
        </select>
        <p className="hint">{t("The message is held in this browser and has not been submitted yet, so taking it back costs nothing.")}</p>
      </div>
      <Switch checked={s.attachmentReminder} onChange={(v) => update({ attachmentReminder: v })} label={t("Attachment reminder")} hint={t("Warn when the message mentions an attachment but none is attached.")} />
      <Switch checked={s.confirmDelete} onChange={(v) => update({ confirmDelete: v })} label={t("Confirm before deleting")} />
    </div>
  );
}
