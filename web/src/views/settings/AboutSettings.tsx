import { useSession } from "@/store/session";
import { client } from "@/jmap/client";

export function AboutSettings() {
  const session = useSession((s) => s.session);
  const caps = Object.keys(session?.capabilities ?? {});
  return (
    <div>
      <h1>About ihasmail</h1>
      <p className="lead">A fast, friendly, open-source webmail for <a href="https://stalw.art" target="_blank" rel="noreferrer">Stalwart Mail Server</a>, built on JMAP.</p>
      <div className="row" style={{ gap: 16, alignItems: "center", marginBottom: 16 }}>
        <img src="/img/logo.png" alt="ihasmail" width={96} />
        <div>
          <div style={{ fontWeight: 700, fontSize: "1.2em" }}>ihasmail 2.0</div>
          <div className="hint">GPL-3.0-or-later · <a href="https://github.com/LINUXexpert-org/ihasmail" target="_blank" rel="noreferrer">github.com/LINUXexpert-org/ihasmail</a></div>
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
      <p className="hint" style={{ marginTop: 6 }}>Stalwart does not publish its version number to mail clients, so ihasmail reports the API generation it detected instead.</p>
      <h2>Server capabilities</h2>
      <div className="row wrap gap-4">
        {caps.map((c) => <span key={c} className="chip mono" style={{ fontSize: ".78em" }}>{c.replace("urn:ietf:params:jmap:", "")}</span>)}
      </div>
    </div>
  );
}

/**
 * Stalwart deliberately withholds its version from clients (it reports a fixed
 * "1.0.0" wherever it publishes one at all), so the most honest thing we can
 * show is which generation of its API answered us, plus the edition where the
 * server reports it.
 */
function describeServer(server: { generation?: "0.16+" | "pre-0.16" | null; edition?: string | null } | undefined): string {
  if (!server?.generation) return "not detected";
  const generation = server.generation === "0.16+" ? "0.16 or newer" : "older than 0.16";
  return server.edition ? `${generation} (${server.edition})` : generation;
}
