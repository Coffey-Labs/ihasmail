import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { apiFetch, ApiError } from "@/jmap/client";
import { useSession } from "@/store/session";
import { formatFullDate } from "@/lib/format";
import { toast } from "@/ui/toast";
import { confirmDialog, Dialog } from "@/ui/dialog";
import { QrCode } from "@/ui/qrcode";

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
  backend: "registry" | "legacy";
  otpEnabled: boolean;
  appPasswords: AppPasswordRow[];
  appPasswordsKeyedByName: boolean;
}

export function SecuritySettings() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [state, setState] = useState<SecurityState | null>(null);
  /** Set when the server has no self-service API at all (pre-0.15 or a proxy). */
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
      <h1>Security & sessions</h1>
      <p className="lead">You're signed in as <b>{session?.username}</b>. Your password is never stored in the browser; the server keeps it encrypted per-session for talking to Stalwart.</p>

      <h2>Password</h2>
      {unsupported ? (
        <p className="hint">{unsupported}</p>
      ) : (
        <PasswordForm otpEnabled={state?.otpEnabled ?? false} onChanged={() => { void load(); }} />
      )}

      <h2>Two-factor authentication</h2>
      {unsupported ? (
        <p className="hint">Two-factor authentication is managed by your mail administrator.</p>
      ) : (
        <TwoFactor state={state} reload={async () => { await loadSecurity(); await load(); }} />
      )}

      <h2>App passwords</h2>
      {unsupported ? (
        <p className="hint">App passwords are managed by your mail administrator.</p>
      ) : (
        <AppPasswords state={state} reload={loadSecurity} />
      )}

      <h2>Active webmail sessions</h2>
      {rows === null ? <p className="hint">Loading…</p> : (
        <table className="sessions-table">
          <thead><tr><th>Device</th><th>IP</th><th>Last active</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><div className="truncate" style={{ maxWidth: 320 }} title={r.userAgent}>{shortUa(r.userAgent)}</div>{r.id === current && <span className="badge" style={{ marginTop: 2 }}>this device</span>}</td>
                <td className="mono small">{r.ip}</td>
                <td>{formatFullDate(new Date(r.lastSeenAt).toISOString())}</td>
                <td>{formatFullDate(new Date(r.expiresAt).toISOString())}{r.remember ? " (remembered)" : ""}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row mt-16">
        <button className="btn" onClick={async () => { if (await confirmDialog({ title: "Sign out other sessions?", confirmLabel: "Sign out others" })) { const r = await apiFetch<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" }); toast.success(`Signed out ${r.revoked} other session(s)`); void load(); } }}>Sign out all other sessions</button>
        <button className="btn btn-ghost" onClick={() => void logout()}>Sign out here</button>
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
      toast.error("The new passwords don't match");
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
      <p className="hint" style={{ marginBottom: 12 }}>Changing your password signs out your other webmail sessions. Any app passwords keep working.</p>
      <div className="field" style={{ maxWidth: 380 }}>
        <label htmlFor="pw-current">Current password</label>
        <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      {otpEnabled && (
        <div className="field" style={{ maxWidth: 380 }}>
          <label htmlFor="pw-code">Code from your authenticator</label>
          <input id="pw-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required />
        </div>
      )}
      <div className="field-row" style={{ maxWidth: 780 }}>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy || !current || !next}>{busy ? "Changing…" : "Change password"}</button>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function TwoFactor({ state, reload }: { state: SecurityState | null; reload: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(false);

  if (!state) return <p className="hint">Loading…</p>;

  const begin = async () => {
    try {
      setSetup(await apiFetch<{ secret: string; url: string }>("/api/account/2fa/begin", { method: "POST", body: "{}" }));
      setCode(""); setPassword("");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const enable = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ sessionKept: boolean }>("/api/account/2fa/enable", {
        method: "POST",
        body: JSON.stringify({ url: setup.url, code, current: password }),
      });
      setSetup(null);
      await reload();
      if (res.sessionKept) {
        toast.success("Two-factor authentication is on. This browser stays signed in.");
      } else {
        toast.success("Two-factor authentication is on. You'll need to sign in again with a code.");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/account/2fa/disable", { method: "POST", body: JSON.stringify({ current: password, code }) });
      setDisabling(false);
      await reload();
      toast.success("Two-factor authentication is off");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginBottom: 12 }}>
        {state.otpEnabled
          ? "Signing in requires a code from your authenticator app as well as your password."
          : "Add a one-time code from an authenticator app to your sign-in, so a stolen password isn't enough on its own."}
      </p>
      <div className="row" style={{ alignItems: "center", gap: 10 }}>
        <ShieldCheck size={18} className={state.otpEnabled ? "" : "muted"} />
        <b>{state.otpEnabled ? "Enabled" : "Not enabled"}</b>
        {state.otpEnabled
          ? <button className="btn btn-sm" onClick={() => { setDisabling(true); setCode(""); setPassword(""); }}>Turn off</button>
          : <button className="btn btn-sm btn-primary" onClick={() => void begin()}>Set up</button>}
      </div>

      <Dialog open={Boolean(setup)} onClose={() => setSetup(null)} title="Set up two-factor authentication" size="md"
        footer={<>
          <button className="btn btn-ghost" onClick={() => setSetup(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || code.length < 6 || !password} onClick={() => void enable()}>{busy ? "Verifying…" : "Turn on"}</button>
        </>}>
        {setup && (
          <div>
            <ol style={{ paddingLeft: 18, marginTop: 0 }}>
              <li>Scan this with your authenticator app.</li>
              <li>Enter the six-digit code it shows, and your password.</li>
            </ol>
            <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <QrCode value={setup.url} size={188} title="Two-factor setup code" />
              <div style={{ minWidth: 220, flex: 1 }}>
                <div className="field">
                  <label>Can't scan? Enter this key by hand</label>
                  <CopyableSecret value={setup.secret} />
                </div>
                <div className="field">
                  <label htmlFor="tfa-code">Code from the app</label>
                  <input id="tfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
                </div>
                <div className="field">
                  <label htmlFor="tfa-pw">Your password</label>
                  <input id="tfa-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
              </div>
            </div>
            <p className="hint">Codes are checked before anything is saved, so a mistyped key can't lock you out.</p>
          </div>
        )}
      </Dialog>

      <Dialog open={disabling} onClose={() => setDisabling(false)} title="Turn off two-factor authentication" size="sm"
        footer={<>
          <button className="btn btn-ghost" onClick={() => setDisabling(false)}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || !password || code.length < 6} onClick={() => void disable()}>{busy ? "Working…" : "Turn off"}</button>
        </>}>
        <p>Your password alone will be enough to sign in again.</p>
        <div className="field">
          <label htmlFor="tfa-off-pw">Your password</label>
          <input id="tfa-off-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tfa-off-code">Current code</label>
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

  if (!state) return <p className="hint">Loading…</p>;

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
      title: `Revoke "${row.description}"?`,
      message: "Anything signed in with this password stops working immediately.",
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch("/api/account/app-passwords/revoke", { method: "POST", body: JSON.stringify({ id: row.id }) });
      await reload();
      toast.success("App password revoked");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginBottom: 12 }}>
        A separate password for a mail app or device, which you can revoke on its own. App passwords skip two-factor codes, so they keep working in apps that can't ask for one.
      </p>
      {state.appPasswords.length > 0 && (
        <table className="sessions-table">
          <thead><tr><th>Name</th>{!state.appPasswordsKeyedByName && <th>Created</th>}<th /></tr></thead>
          <tbody>
            {state.appPasswords.map((row) => (
              <tr key={row.id}>
                <td><KeyRound size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />{row.description}</td>
                {!state.appPasswordsKeyedByName && <td>{row.createdAt ? formatFullDate(row.createdAt) : "—"}</td>}
                <td style={{ textAlign: "right" }}><button className="btn btn-sm btn-ghost" onClick={() => void revoke(row)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={create} className="row mt-16" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label htmlFor="ap-name">New app password for</label>
          <input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Thunderbird on my laptop" required />
        </div>
        <button className="btn" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
      </form>
      {state.appPasswordsKeyedByName && <p className="hint mt-8">This mail server identifies app passwords by name, so give each one a different name.</p>}

      <Dialog open={Boolean(issued)} onClose={() => setIssued(null)} title="Your new app password" size="sm"
        footer={<button className="btn btn-primary" onClick={() => setIssued(null)}>Done</button>}>
        {issued && (
          <div>
            <p>Copy it into <b>{issued.description}</b> now — it isn't shown again.</p>
            <CopyableSecret value={issued.secret} />
            <p className="hint mt-8"><Smartphone size={13} style={{ verticalAlign: "-2px" }} /> Use your usual address as the username.</p>
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
        title="Copy"
        onClick={() => void navigator.clipboard?.writeText(value).then(() => toast.success("Copied"), () => toast.error("Could not copy"))}
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
