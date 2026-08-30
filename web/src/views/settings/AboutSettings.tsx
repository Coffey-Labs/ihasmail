import { useSession } from "@/store/session";
import { client } from "@/jmap/client";
import { DEFAULT_SOURCE_URL } from "@/lib/source";
import { APP_VERSION } from "@/lib/version";

export function AboutSettings() {
  const session = useSession((s) => s.session);
  const caps = Object.keys(session?.capabilities ?? {});
  // A deployment running modified code should offer its own source, not ours.
  const sourceUrl = session?.ihasmail?.sourceUrl ?? DEFAULT_SOURCE_URL;
  return (
    <div>
      <h1>About ihasmail</h1>
      <p className="lead">A fast, friendly, open-source webmail for <a href="https://stalw.art" target="_blank" rel="noreferrer">Stalwart Mail Server</a>, built on JMAP.</p>
      <div className="row" style={{ gap: 16, alignItems: "center", marginBottom: 16 }}>
        <img src="/img/logo.png" alt="ihasmail" width={96} />
        <div>
          <div style={{ fontWeight: 700, fontSize: "1.2em" }}>ihasmail v{APP_VERSION}</div>
          <div className="hint">AGPL-3.0-or-later · <a href={sourceUrl} target="_blank" rel="noreferrer">{sourceUrl.replace(/^https?:\/\//, "")}</a></div>
        </div>
      </div>
      <h2>Server</h2>
      <table className="sessions-table">
        <tbody>
          <tr><td>Signed in as</td><td>{session?.username}</td></tr>
          <tr><td>Stalwart</td><td>{describeServer(session?.ihasmail?.server)}</td></tr>
          <tr><td>Accounts</td><td>{Object.values(session?.accounts ?? {}).map((a) => a.name).join(", ")}</td></tr>
          <tr><td>Max upload</td><td>{Math.round(client.maxSizeUpload / 1048576)} MB</td></tr>
          <tr><td>Image privacy proxy</td><td>{session?.ihasmail?.imageProxy ? "enabled" : "disabled"}</td></tr>
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 6 }}>Stalwart does not publish its version number to mail clients, so ihasmail reports the edition where the server gives one. ihasmail requires 0.16 or newer, and sign-in refuses anything older.</p>
      <p className="hint">ihasmail's own version is the date of the commit it was built from, followed by where that commit came from: <strong>v2026.8.30+pr129</strong> was built from a commit dated the 30th of August 2026 that arrived through pull request 129. A commit that did not come through one carries its short SHA instead — <code>+g1fa6578</code>. The version deliberately says nothing about Stalwart; what this build needs from the server is the line above.</p>
      <h2>Server capabilities</h2>
      <div className="row wrap gap-4">
        {caps.map((c) => <span key={c} className="chip mono" style={{ fontSize: ".78em" }}>{c.replace("urn:ietf:params:jmap:", "")}</span>)}
      </div>
    </div>
  );
}

/**
 * Stalwart deliberately withholds its version from clients (it reports a fixed
 * "1.0.0" wherever it publishes one at all), so the edition is all there is to
 * show. The generation used to be reported here too, back when ihasmail spoke
 * to both 0.15 and 0.16; it requires 0.16 now, so signing in at all is the
 * answer to that question.
 */
function describeServer(server: { edition?: string | null } | undefined): string {
  return server?.edition ? `0.16 or newer (${server.edition})` : "0.16 or newer";
}
