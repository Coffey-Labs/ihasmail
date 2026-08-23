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
          <tr><td>Accounts</td><td>{Object.values(session?.accounts ?? {}).map((a) => a.name).join(", ")}</td></tr>
          <tr><td>Max upload</td><td>{Math.round(client.maxSizeUpload / 1048576)} MB</td></tr>
          <tr><td>Image privacy proxy</td><td>{session?.ihasmail?.imageProxy ? "enabled" : "disabled"}</td></tr>
        </tbody>
      </table>
      <h2>Server capabilities</h2>
      <div className="row wrap gap-4">
        {caps.map((c) => <span key={c} className="chip mono" style={{ fontSize: ".78em" }}>{c.replace("urn:ietf:params:jmap:", "")}</span>)}
      </div>
    </div>
  );
}
