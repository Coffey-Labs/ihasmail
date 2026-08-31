import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Star, Eye, EyeOff } from "lucide-react";
import { useSettings } from "@/store/settings";
import { useMail } from "@/store/mail";
import type { Identity } from "@/jmap/types";
import { isAlwaysVisible } from "@/lib/identityVisibility";
import { Dialog, confirmDialog } from "@/ui/dialog";
import { RichEditor, type RichEditorHandle } from "../compose/RichEditor";
import { toast } from "@/ui/toast";
import { parseAddressList, formatAddressList } from "@/lib/address";
import { htmlToText } from "@/lib/text";
import { sanitizeEditorHtml } from "@/lib/html";
import { externalizeDataImages, storeSignatureHtml, uploadSignatureImage } from "@/lib/signatureImages";
import { buildMarkerSignature, byteLength, compactHtml, signatureTooLong, SIGNATURE_LIMIT } from "@/lib/signatureHtml";
import { t } from "@/lib/i18n";

export function IdentitiesSettings() {
  const identities = useMail((s) => s.identities);
  const load = useMail((s) => s.loadIdentities);
  const accountId = useMail((s) => s.accountId);
  const setDefault = useMail((s) => s.setDefaultIdentity);
  const defaultId = useSettings((s) => (accountId ? s.settings.defaultIdentityByAccount[accountId] : undefined)) ?? identities[0]?.id;
  const [editing, setEditing] = useState<Partial<Identity> | null>(null);
  const hidden = useSettings((s) => s.settings.hiddenIdentities);
  const updateSettings = useSettings((s) => s.update);
  const toggleHidden = (id: string) =>
    updateSettings({ hiddenIdentities: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id] });
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>{t("Identities & signatures")}</h1>
      <p className="lead">{t("Each identity is a sender address with its own name, Reply-To and signature. The default identity is preselected when you compose; set a Reply-To when replies should go somewhere other than the From address.")}</p>
      {identities.map((i) => (
        <div key={i.id} className="card clickable" onClick={() => setEditing(i)}>
          <div className="card-head">
            <h3>{i.name ? `${i.name} <${i.email}>` : i.email} {i.id === defaultId && <span className="tag" style={{ background: "var(--accent)", color: "var(--accent-fg)", marginLeft: 6 }}>{t("Default")}</span>}</h3>
            {i.id !== defaultId && (
              <button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); setDefault(i.id); toast.success(t("{email} is now your default identity", { email: i.email })); }}><Star size={14} /> {t("Make default")}</button>
            )}
            {/*
              Hiding is presentation only -- the identity still exists and still
              receives, like an unsubscribed folder. The default cannot be
              hidden, because it is what a new draft starts on.
            */}
            <button
              className="btn btn-sm btn-ghost"
              disabled={isAlwaysVisible(i.id, [defaultId])}
              title={isAlwaysVisible(i.id, [defaultId]) ? t("The default identity is always offered when composing") : hidden.includes(i.id) ? t("Show this in the compose picker") : t("Hide this from the compose picker")}
              onClick={(e) => { e.stopPropagation(); toggleHidden(i.id); }}
            >
              {hidden.includes(i.id) ? <><Eye size={14} /> {t("Show when composing")}</> : <><EyeOff size={14} /> {t("Hide when composing")}</>}
            </button>
            {i.mayDelete && (
              <button className="icon-btn sm danger" aria-label={t("Delete identity")} onClick={async (e) => { e.stopPropagation(); if (await confirmDialog({ title: t("Delete this identity?"), confirmLabel: t("Delete"), danger: true })) { try { await useMail.getState().destroyIdentity(i.id); } catch (err) { toast.error((err as Error).message); } } }}><Trash2 size={16} /></button>
            )}
          </div>
          {hidden.includes(i.id) && <div className="hint" style={{ marginTop: 4 }}>{t("Not offered when composing. It still receives mail, and you can still send from it by showing it again.")}</div>}
          {(i.htmlSignature || i.textSignature) && <div className="hint" style={{ marginTop: 4 }}>{htmlToText(i.htmlSignature || i.textSignature).slice(0, 120)}</div>}
          {i.replyTo?.length ? <div className="hint">{t("Reply-To: {addresses}", { addresses: formatAddressList(i.replyTo) })}</div> : null}
        </div>
      ))}
      <button className="btn" onClick={() => setEditing({ name: "", email: identities[0]?.email ?? "", textSignature: "", htmlSignature: "", replyTo: null, bcc: null })}><Plus size={16} /> {t("Add identity")}</button>
      <p className="hint mt-8">{t("New identities must use an address this account is allowed to send from (aliases configured on the server).")}</p>
      {hidden.length > 0 && (
        <p className="hint">
          {`${hidden.length} ${hidden.length === 1 ? "identity is" : "identities are"} hidden from the compose picker. Hiding every one of them would leave nothing to choose from, so in that case they are all offered again.`}
        </p>
      )}
      {editing && <IdentityDialog identity={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function IdentityDialog({ identity, onClose }: { identity: Partial<Identity>; onClose: () => void }) {
  const [name, setName] = useState(identity.name ?? "");
  const [email, setEmail] = useState(identity.email ?? "");
  const [replyTo, setReplyTo] = useState(formatAddressList(identity.replyTo));
  const [html, setHtml] = useState(identity.htmlSignature || (identity.textSignature ? identity.textSignature.replace(/\n/g, "<br>") : ""));
  const [busy, setBusy] = useState(false);
  const ref = useRef<RichEditorHandle>(null);
  const compact = compactHtml(sanitizeEditorHtml(html));
  // The server's limit is on encoded bytes, so that is what to count and show.
  const sigLen = byteLength(compact);
  const tooLong = signatureTooLong(compact, htmlToText(compact));
  const save = async () => {
    setBusy(true);
    try {
      // 1) pasted pictures → stored files, 2) strip cruft, 3) fall back to a stored full copy.
      const externalized = await externalizeDataImages(sanitizeEditorHtml(html));
      const clean = compactHtml(externalized);
      let htmlSignature = clean;
      let textSignature = htmlToText(clean);
      if (signatureTooLong(clean, textSignature)) {
        const blobId = await storeSignatureHtml(clean);
        ({ htmlSignature, textSignature } = buildMarkerSignature(blobId, clean));
      }
      const patch: Partial<Identity> = {
        name,
        replyTo: replyTo.trim() ? parseAddressList(replyTo) : null,
        htmlSignature,
        textSignature,
      };
      if (!identity.id) patch.email = email.trim();
      await useMail.getState().saveIdentity(identity.id ?? null, patch);
      toast.success(t("Identity saved"));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={identity.id ? t("Edit identity") : t("New identity")} size="lg" footer={<><button className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? t("Saving…") : t("Save")}</button></>}>
      <div className="field-row">
        <div className="field"><label>{t("Display name")}</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>{t("Email address")}</label><input className="input" type="email" value={email} disabled={Boolean(identity.id)} onChange={(e) => setEmail(e.target.value)} /></div>
      </div>
      <div className="field"><label>{t("Reply-To (optional)")}</label><input className="input" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder={t("replies@example.com")} /><span className="hint">{t("Replies to mail sent from this identity go here instead of the From address.")}</span></div>
      <div className="field">
        <label>{t("Signature")}</label>
        <div style={{ border: `1px solid ${tooLong ? "var(--danger)" : "var(--border-strong)"}`, borderRadius: 8, minHeight: 180, display: "flex", flexDirection: "column" }}>
          <RichEditor ref={ref} html={html} onChange={setHtml} placeholder={t("Your signature…")} showToolbar imageUpload={uploadSignatureImage} />
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="hint">{t("Images are stored in your Files (folder “ihasmail”) and embedded when you send.")}</span>
          <span className="hint nowrap" style={tooLong ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{sigLen.toLocaleString()} / {SIGNATURE_LIMIT.toLocaleString()}</span>
        </div>
        {tooLong && <div className="warn-box mt-8">{t("This signature is larger than the server's {limit}-byte limit. ihasmail will keep the full version in your Files and store a short text fallback on the server — other mail clients will see the plain-text version.", { limit: SIGNATURE_LIMIT })}</div>}
      </div>
    </Dialog>
  );
}
