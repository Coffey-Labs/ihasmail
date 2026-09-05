import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import {
  addPublicKey,
  isExpired,
  keyExcerpt,
  keyKind,
  keyKindLabel,
  listPublicKeys,
  publicKeysAvailable,
  removePublicKey,
  updatePublicKey,
  type PublicKey,
} from "@/lib/publicKeys";
import { formatFullDate } from "@/lib/format";
import { confirmDialog } from "@/ui/dialog";
import { Empty, Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { t, tc } from "@/lib/i18n";

/**
 * Public keys for this account: the ones other people encrypt to, and the ones
 * a signature is checked against. Nothing here handles a private key, and
 * nothing here asks for one.
 *
 * The page is careful not to overstate what adding a key achieves. Stalwart
 * stores keys, and `encryptionAtRest` on `x:AccountSettings` is the one thing
 * known to consume one; nothing in ihasmail signs, encrypts, decrypts or
 * verifies with them yet. Saying otherwise would be a guess dressed as a
 * feature.
 */
export function KeysSettings() {
  const [keys, setKeys] = useState<PublicKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftName, setDraftName] = useState("");
  const available = publicKeysAvailable();

  const load = useCallback(async () => {
    if (!available) {
      setKeys([]);
      return;
    }
    try {
      setKeys(await listPublicKeys());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setKeys([]);
    }
  }, [available]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!draftKey.trim()) return;
    setBusy(true);
    try {
      // An empty description is left empty rather than filled in with an
      // English default: the description is stored on the server, so a name
      // invented here would be whatever language the adder happened to use.
      // The list labels a blank one at render time instead.
      await addPublicKey(draftKey, draftName);
      setDraftKey("");
      setDraftName("");
      setAdding(false);
      toast.success(t("Key added"));
      await load();
    } catch (err) {
      // Stalwart parsed the key and knows exactly what is wrong with it, in
      // more detail than anything invented here could manage.
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (k: PublicKey, description: string) => {
    if (description === k.description) return;
    try {
      await updatePublicKey(k.id, { description });
      await load();
    } catch (err) {
      toast.error((err as Error).message);
      await load();
    }
  };

  const remove = async (k: PublicKey) => {
    const ok = await confirmDialog({
      title: t("Remove “{name}”?", { name: k.description || t("this key") }),
      message: t("Anyone holding it can still use it — removing it here only stops this account offering it."),
      confirmLabel: t("Remove key"),
      danger: true,
    });
    if (!ok) return;
    try {
      await removePublicKey(k.id);
      toast.success(t("Key removed"));
    } catch (err) {
      toast.error((err as Error).message);
    }
    await load();
  };

  if (!available) {
    return (
      <div>
        <h1>{t("Encryption keys")}</h1>
        <Empty icon={<KeyRound size={40} />} title={t("Not available on this server")}>
          {t("Public keys are kept in Stalwart's registry, which this server does not offer. ihasmail needs Stalwart 0.16 or newer for it.")}
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <h1>{t("Encryption keys")}</h1>
      <p className="lead">
        {t("Public keys for this account — what other people encrypt to, and what a signature is checked against. These are public by nature: no private key is stored, requested, or sent by ihasmail.")}
      </p>

      {error && <div className="error-box mb-16" role="alert">{error}</div>}

      {keys === null ? (
        <div className="center p-16"><Spinner /></div>
      ) : keys.length === 0 && !adding ? (
        <Empty icon={<KeyRound size={40} />} title={t("No keys yet")}>
          {t("Add an OpenPGP public key or an S/MIME certificate to publish it on this account.")}
        </Empty>
      ) : (
        keys.map((k) => {
          const kind = keyKind(k.key);
          const expired = isExpired(k);
          return (
            <div key={k.id} className="card">
              <div className="card-head">
                <KeyRound size={16} />
                {editing === k.id ? (
                  <input
                    className="input sm"
                    aria-label={t("Key description")}
                    autoFocus
                    defaultValue={k.description}
                    style={{ width: 240 }}
                    onBlur={(e) => { void rename(k, e.target.value.trim() || k.description); setEditing(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(null); }}
                  />
                ) : (
                  <h3 style={{ cursor: "text" }} onClick={() => setEditing(k.id)} title={t("Click to rename")}>{k.description || t("Untitled key")}</h3>
                )}
                <span className="chip">{keyKindLabel(kind)}</span>
                {expired && <span className="chip" style={{ color: "var(--danger)" }}>{t("Expired")}</span>}
                <button className="icon-btn sm danger" aria-label={t("Remove key")} onClick={() => void remove(k)}><Trash2 size={16} /></button>
              </div>
              <table className="sessions-table" style={{ marginTop: 8 }}>
                <tbody>
                  <tr><td>{t("Added")}</td><td>{k.createdAt ? formatFullDate(k.createdAt) : "—"}</td></tr>
                  <tr><td>{t("Expires")}</td><td>{k.expiresAt ? formatFullDate(k.expiresAt) : t("No expiry set")}</td></tr>
                  <tr><td>{t("Addresses")}</td><td>{k.emailAddresses.length ? k.emailAddresses.join(", ") : t("Any address on this account")}</td></tr>
                  <tr><td>{tc("cryptography", "Key")}</td><td className="mono" style={{ fontSize: ".85em" }}>{keyExcerpt(k.key)}…</td></tr>
                </tbody>
              </table>
            </div>
          );
        })
      )}

      {adding ? (
        <div className="card">
          <div className="field">
            <label htmlFor="key-name">{t("Description")}</label>
            <input id="key-name" className="input" value={draftName} placeholder={t("Work key")} onChange={(e) => setDraftName(e.target.value)} />
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="key-body">{t("Public key")}</label>
            <textarea
              id="key-body"
              className="input mono"
              rows={8}
              spellCheck={false}
              value={draftKey}
              placeholder={"-----BEGIN PGP PUBLIC KEY BLOCK-----\n…\n-----END PGP PUBLIC KEY BLOCK-----"}
              onChange={(e) => setDraftKey(e.target.value)}
            />
            <p className="hint">
              {t("Paste the whole armoured block, headers included. The server checks it and says what is wrong if it cannot read it.")}
            </p>
          </div>
          <div className="row gap-8" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" disabled={busy || !draftKey.trim()} onClick={() => void add()}>
              {busy ? <span className="spinner" /> : null} {t("Add key")}
            </button>
            <button className="btn" disabled={busy} onClick={() => { setAdding(false); setDraftKey(""); setDraftName(""); }}>{t("Cancel")}</button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setAdding(true)}><Plus size={16} /> {t("Add a key")}</button>
      )}

      <p className="hint mt-8">
        {t("Stalwart stores these keys, and this release does no more than manage them: ihasmail does not yet sign, encrypt, decrypt or verify anything with them. Adding one does not by itself start encrypting your mail.")}
      </p>
    </div>
  );
}
