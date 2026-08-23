import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { useSession } from "@/store/session";
import { formatFullDate } from "@/lib/format";
import { toast } from "@/ui/toast";
import { confirmDialog } from "@/ui/dialog";

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

export function SecuritySettings() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string>("");
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);
  const load = () => apiFetch<{ current: string; sessions: SessionRow[] }>("/api/auth/sessions").then((r) => { setRows(r.sessions); setCurrent(r.current); }).catch(() => setRows([]));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div>
      <h1>Security & sessions</h1>
      <p className="lead">You're signed in as <b>{session?.username}</b>. Your password is never stored in the browser; the server keeps it encrypted per-session for talking to Stalwart.</p>
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
      <h2>Password & two-factor</h2>
      <p className="hint">Password changes, app passwords and 2FA are managed by your mail administrator or via Stalwart's self-service portal.</p>
    </div>
  );
}

function shortUa(ua: string): string {
  const browser = /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` : /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` : /Safari\/(\d+)/.exec(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}
