import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { apiFetch, ApiError } from "@/jmap/client";
import { useSession } from "@/store/session";
import { formatFullDate } from "@/lib/format";
import { toast } from "@/ui/toast";
import { confirmDialog, Dialog } from "@/ui/dialog";
import { plural, t, tNode } from "@/lib/i18n";

interface SessionRow {
  id: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  userAgent: string;
  ip: string;
}

interface AppPasswordRow {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
}

interface SecurityState {
  otpEnabled: boolean;
  appPasswords: AppPasswordRow[];
}

export function SecuritySettings() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [state, setState] = useState<SecurityState | null>(null);
  /** Set when the server has no self-service API at all (a proxy, say). */
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);

  const load = () => apiFetch<{ current: string; sessions: SessionRow[] }>("/api/auth/sessions").then((r) => { setRows(r.sessions); setCurrent(r.current); }).catch(() => setRows([]));

  const loadSecurity = useCallback(async () => {
    try {
      setState(await apiFetch<SecurityState>("/api/account/security"));
      setUnsupported(null);
    } catch (err) {
      setState(null);
      setUnsupported(err instanceof ApiError && err.status === 501 ? err.message : (err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSecurity();
  }, [loadSecurity]);

  return (
    <div>
      <h1>{t("Security & sessions")}</h1>
      <p className="lead">{tNode("You're signed in as {user}. Your password is never stored in the browser; the server keeps it encrypted per-session for talking to Stalwart.", { user: <b className="notranslate" translate="no">{session?.username}</b> })}</p>

      <h2>{t("Password")}</h2>
      {unsupported ? (
        <p className="hint">{unsupported}</p>
      ) : (
        <PasswordForm otpEnabled={state?.otpEnabled ?? false} onChanged={() => { void load(); }} />
      )}

      {!unsupported && state?.otpEnabled && (
        <>
          <h2>{t("Two-factor authentication")}</h2>
          <TwoFactorOff reload={async () => { await loadSecurity(); await load(); }} />
        </>
      )}

      <h2>{t("App passwords")}</h2>
      {unsupported ? (
        <p className="hint">{t("App passwords are managed by your mail administrator.")}</p>
      ) : (
        <AppPasswords state={state} reload={loadSecurity} />
      )}

      <h2>{t("Active webmail sessions")}</h2>
      {rows === null ? <p className="hint">{t("Loading…")}</p> : (
        <table className="sessions-table">
          <thead><tr><th>{t("Device")}</th><th>{t("IP")}</th><th>{t("Last active")}</th><th>{t("Expires")}</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><div className="truncate" style={{ maxWidth: 320 }} title={r.userAgent}>{shortUa(r.userAgent)}</div>{r.id === current && <span className="badge" style={{ marginTop: 2 }}>{t("this device")}</span>}</td>
                <td className="mono small">{r.ip}</td>
                <td>{formatFullDate(new Date(r.lastSeenAt).toISOString())}</td>
                <td>{`${formatFullDate(new Date(r.expiresAt).toISOString())}${r.remember ? " (remembered)" : ""}`}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row mt-16">
        <button className="btn" onClick={async () => { if (await confirmDialog({ title: t("Sign out other sessions?"), confirmLabel: t("Sign out others") })) { const r = await apiFetch<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" }); toast.success(plural(r.revoked, { one: "Signed out {n} other session", other: "Signed out {n} other sessions" })); void load(); } }}>{t("Sign out all other sessions")}</button>
        <button className="btn btn-ghost" onClick={() => void logout()}>{t("Sign out here")}</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PasswordForm({ otpEnabled, onChanged }: { otpEnabled: boolean; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast.error(t("The new passwords don't match"));
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ revokedSessions: number }>("/api/account/password", {
        method: "POST",
        body: JSON.stringify({ current, next, otpCode: code || undefined }),
      });
      setCurrent(""); setNext(""); setConfirm(""); setCode("");
      toast.success(res.revokedSessions ? `Password changed. ${res.revokedSessions} other session(s) signed out.` : "Password changed");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="hint" style={{ marginBottom: 12 }}>{t("Changing your password signs out your other webmail sessions. Any app passwords keep working.")}</p>
      <div className="field" style={{ maxWidth: 380 }}>
        <label htmlFor="pw-current">{t("Current password")}</label>
        <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      {otpEnabled && (
        <div className="field" style={{ maxWidth: 380 }}>
          <label htmlFor="pw-code">{t("Code from your authenticator")}</label>
          <input id="pw-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required />
        </div>
      )}
      <div className="field-row" style={{ maxWidth: 780 }}>
        <div className="field">
          <label htmlFor="pw-new">{t("New password")}</label>
          <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">{t("Confirm new password")}</label>
          <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy || !current || !next}>{busy ? "Changing…" : "Change password"}</button>
    </form>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Only the way *out*. Setting two-factor authentication up is gone until
 * signing in with a code works: Stalwart takes a TOTP code through an OAuth
 * flow alone and offers no password grant, so ihasmail has nowhere to send one
 * (#75). Turning it on here would lock the account out of webmail on its next
 * sign-in. Turning it off is a plain registry write, works today, and has to
 * stay — whoever is already enrolled needs a way back.
 */
function TwoFactorOff({ reload }: { reload: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const disable = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/account/2fa/disable", { method: "POST", body: JSON.stringify({ current: password, code }) });
      setDisabling(false);
      await reload();
      toast.success(t("Two-factor authentication is off"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginBottom: 12 }}>
        
        {t("This account has two-factor authentication on. ihasmail can't sign you in with a code yet, so signing in on another device needs an app password — or you can turn two-factor authentication off here.")}
      </p>
      <div className="row" style={{ alignItems: "center", gap: 10 }}>
        <ShieldCheck size={18} />
        <b>{t("Enabled")}</b>
        <button className="btn btn-sm" onClick={() => { setDisabling(true); setCode(""); setPassword(""); }}>{t("Turn off")}</button>
      </div>

      <Dialog open={disabling} onClose={() => setDisabling(false)} title={t("Turn off two-factor authentication")} size="sm"
        footer={<>
          <button className="btn btn-ghost" onClick={() => setDisabling(false)}>{t("Cancel")}</button>
          <button className="btn btn-danger" disabled={busy || !password || code.length < 6} onClick={() => void disable()}>{busy ? "Working…" : "Turn off"}</button>
        </>}>
        <p>{t("Your password alone will be enough to sign in again.")}</p>
        <div className="field">
          <label htmlFor="tfa-off-pw">{t("Your password")}</label>
          <input id="tfa-off-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tfa-off-code">{t("Current code")}</label>
          <input id="tfa-off-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
        </div>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AppPasswords({ state, reload }: { state: SecurityState | null; reload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ description: string; secret: string } | null>(null);

  if (!state) return <p className="hint">{t("Loading…")}</p>;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch<{ id: string; secret: string }>("/api/account/app-passwords", {
        method: "POST",
        body: JSON.stringify({ description: name }),
      });
      setIssued({ description: name, secret: res.secret });
      setName("");
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: AppPasswordRow) => {
    const ok = await confirmDialog({
      title: t("Revoke “{name}”?", { name: row.description }),
      message: t("Anything signed in with this password stops working immediately."),
      confirmLabel: t("Revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch("/api/account/app-passwords/revoke", { method: "POST", body: JSON.stringify({ id: row.id }) });
      await reload();
      toast.success(t("App password revoked"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginBottom: 12 }}>
        
        {t("A separate password for a mail app or device, which you can revoke on its own. App passwords skip two-factor codes, so they keep working in apps that can't ask for one.")}
      </p>
      {state.appPasswords.length > 0 && (
        <table className="sessions-table">
          <thead><tr><th>{t("Name")}</th><th>{t("Created")}</th><th /></tr></thead>
          <tbody>
            {state.appPasswords.map((row) => (
              <tr key={row.id}>
                <td><KeyRound size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />{row.description}</td>
                <td>{row.createdAt ? formatFullDate(row.createdAt) : "—"}</td>
                <td style={{ textAlign: "right" }}><button className="btn btn-sm btn-ghost" onClick={() => void revoke(row)}>{t("Revoke")}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={create} className="row mt-16" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label htmlFor="ap-name">{t("New app password for")}</label>
          <input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Thunderbird on my laptop")} required />
        </div>
        <button className="btn" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
      </form>

      <Dialog open={Boolean(issued)} onClose={() => setIssued(null)} title={t("Your new app password")} size="sm"
        footer={<button className="btn btn-primary" onClick={() => setIssued(null)}>{t("Done")}</button>}>
        {issued && (
          <div>
            <p>{tNode("Copy it into {name} now — it isn't shown again.", { name: <b>{issued.description}</b> })}</p>
            <CopyableSecret value={issued.secret} />
            <p className="hint mt-8"><Smartphone size={13} style={{ verticalAlign: "-2px" }} />  {t("Use your usual address as the username.")}</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function CopyableSecret({ value }: { value: string }) {
  return (
    <div className="row" style={{ gap: 6, alignItems: "center" }}>
      <code className="mono" style={{ userSelect: "all", wordBreak: "break-all", flex: 1, padding: "6px 8px", background: "var(--bg-hover)", borderRadius: 6 }}>{value}</code>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        title={t("Copy")}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => toast.success(t("Copied")), () => toast.error(t("Could not copy")))}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

function shortUa(ua: string): string {
  const browser = /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` : /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` : /Safari\/(\d+)/.exec(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}
