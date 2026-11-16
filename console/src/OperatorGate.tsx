import { useEffect, useState, type FormEvent } from "react";
import App from "./App";
import {
  getAuthStatus, getOperatorSession, loginOperator, logoutOperator,
  clearOperatorSession, type OperatorSession
} from "./api";

type AccessMode = "LOADING" | "OFFLINE" | "LEGACY" | "REQUIRED";

export default function OperatorGate() {
  const [mode, setMode] = useState<AccessMode>("LOADING");
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [provisioned, setProvisioned] = useState(true);

  async function initialize() {
    setMode("LOADING");
    setError("");
    try {
      const state = await getAuthStatus();
      setProvisioned(state.provisioned);
      if (state.mode === "LEGACY") {
        setMode("LEGACY");
        return;
      }
      setMode("REQUIRED");
      try {
        const me = await getOperatorSession();
        setSession(me.authenticated ? me : null);
      } catch {
        setSession(null);
      }
    } catch {
      setMode("OFFLINE");
      setError("Local Vihanga API is unavailable on 127.0.0.1:8010.");
    }
  }
  useEffect(() => { void initialize(); }, []);
  useEffect(() => {
    function handleExpired() {
      clearOperatorSession();
      setSession(null);
    }
    window.addEventListener("vihanga-operator-expired", handleExpired);
    return () => window.removeEventListener("vihanga-operator-expired", handleExpired);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await loginOperator(username, password);
      setSession(next);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operator login failed");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await logoutOperator();
      setSession(null);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "LEGACY") return <App/>;
  if (mode === "REQUIRED" && session?.authenticated) {
    return <>
      <App/>
      <div className="operator-session-indicator">
        <span>{session.username} · {session.role}</span>
        <button type="button" onClick={() => void signOut()} disabled={busy}>
          Sign out
        </button>
      </div>
    </>;
  }

  return <main className="operator-login-page">
    <section className="operator-login-card" aria-labelledby="login-title">
      <div className="operator-login-brand">
        <span className="operator-login-v">V</span>
        <span>VIHANGA <small>GROUND CONTROL STATION</small></span>
      </div>
      <h1 id="login-title">{mode === "OFFLINE" ? "Connection unavailable" :
        mode === "LOADING" ? "Connecting to Vihanga" : "Operator sign in"}</h1>
      <p>Local operations access. Aircraft commands remain locked pending
        independent command-authority verification.</p>
      {mode === "REQUIRED" && provisioned && <form onSubmit={event => void submit(event)}>
        <label htmlFor="operator-username">Operator ID</label>
        <input id="operator-username" value={username}
          autoComplete="username" required maxLength={32}
          onChange={event => setUsername(event.target.value)}/>
        <label htmlFor="operator-password">Password</label>
        <input id="operator-password" type="password" value={password}
          autoComplete="current-password" required
          onChange={event => setPassword(event.target.value)}/>
        <button type="submit" disabled={busy}>{busy ? "Authenticating…" : "Sign in"}</button>
      </form>}
      {mode === "REQUIRED" && !provisioned && <p role="alert">
        No operator accounts are provisioned. Create the first administrator
        locally using the documented terminal enrollment command.
      </p>}
      {error && <p className="operator-login-error" role="alert">{error}</p>}
      {mode === "OFFLINE" && <button type="button" onClick={() => void initialize()}>Retry connection</button>}
      <footer>Session expiration and aircraft permissions are enforced by the local API.</footer>
    </section>
  </main>;
}
