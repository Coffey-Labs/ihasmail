import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "@/ui/dialog";
import { ApiError, apiFetch } from "@/jmap/client";
import { clearSignedInData, isDeviceTrusted } from "@/lib/storage";
import { t } from "@/lib/i18n";

/**
 * Sign a second account in beside the one in front. It joins the others and
 * comes to the front, and the app reloads into it.
 *
 * It is remembered on this device exactly as the first one was.
 */
export function AddAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remember = isDeviceTrusted();

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password, remember, add: true }),
      });
      clearSignedInData();
      window.location.reload();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "add_full"
          ? t("You can't add more accounts here.")
          : code === "add_other_server"
            ? t("That account is on another mail server. Only accounts on this server can be added.")
            : (err as Error).message || t("That account couldn't be added."),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Add an account")}
      size="sm"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary" form="add-account" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? t("Working…") : t("Add account")}
          </button>
        </>
      }
    >
      <form id="add-account" onSubmit={(e) => void submit(e)}>
        <p className="hint">{t("Both accounts stay signed in here; switch between them from this menu.")}</p>
        <div className="field">
          <label htmlFor="add-account-user">{t("Email address")}</label>
          <input id="add-account-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="add-account-pw">{t("Password")}</label>
          <input id="add-account-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
  );
}
