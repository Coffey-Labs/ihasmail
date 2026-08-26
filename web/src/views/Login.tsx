import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useSession } from "@/store/session";
import { ApiError } from "@/jmap/client";
import { DEFAULT_SOURCE_URL } from "@/lib/source";
import { APP_VERSION } from "@/lib/version";

export function LoginPage() {
  const login = useSession((s) => s.login);
  // The AGPL's offer has to reach everyone who interacts with the app over the
  // network, and that includes whoever is looking at this form. The server says
  // where its own source lives, so a modified deployment points at its own.
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_SOURCE_URL);
  useEffect(() => {
    let live = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (live && c?.sourceUrl) setSourceUrl(c.sourceUrl as string); })
      .catch(() => { /* the default stands */ });
    return () => { live = false; };
  }, []);
  const [username, setUsername] = useState(() => localStorage.getItem("ihasmail:lastUser") ?? "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      // No two-factor code: the field is not on this form until the flow works
      // end to end, and the server treats an absent code as none given.
      await login(username.trim(), password, "", remember);
      localStorage.setItem("ihasmail:lastUser", username.trim());
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "invalid_credentials") {
          setError("Invalid username or password.");
        } else if (err.code === "rate_limited") setError("Too many attempts. Please wait a few minutes and try again.");
        else setError(err.message || "Could not sign in.");
      } else setError("Network error. Please check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          <img src="/img/logo.png" alt="" width={120} height={143} />
          <h1>ihasmail</h1>
          <p className="tagline">Fast, friendly webmail. Your mailbox, your way.</p>
        </div>
        {error && (
          <div className="error-box mb-16" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="u">Email or username</label>
          <input id="u" className="input" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!username} required />
        </div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <div className="pw-wrap">
            <input id="p" className="input" type={showPw ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={Boolean(username)} required style={{ paddingRight: 40 }} />
            <button type="button" className="icon-btn" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"} tabIndex={-1}>
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Keep me signed in on this device</span>
        </label>
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : <LogIn size={18} />}
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="foot">
          {/*
            The version sits directly above the source link on purpose: the
            AGPL's offer is for the source of *this* build, and naming the
            build is what makes that offer something a person can act on. It
            also means a bug report can name the build without anyone having
            to sign in to find it.

            One <p> with a break rather than two: .foot carries a 20px
            margin-top, which a second paragraph would repeat as a gap.
          */}
          ihasmail v{APP_VERSION}
          <br />
          <a href="https://ihasmail.org" target="_blank" rel="noopener noreferrer">ihasmail.org</a>
          {" · "}
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">AGPL-3.0 source</a>
        </p>
      </form>
    </div>
  );
}
