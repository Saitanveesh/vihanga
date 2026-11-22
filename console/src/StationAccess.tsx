import StationMark from "./StationMark";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import BootSplash from "./BootSplash";
import App from "./App";

type Session = { required: boolean; username: string | null; role: "admin" | "operator" | "viewer" | null };

const verificationError = "The station connection could not be verified.";

async function sessionRequest(action: string, payload?: object, signal?: AbortSignal): Promise<Session> {
  const response = await fetch("/api/v1/station/" + action, {
    method: payload ? "POST" : "GET", signal, cache: "no-store",
    ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {})
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.detail || "Station sign-in is unavailable");
  }
  return response.json();
}

export default function StationAccess() {
  const [session, setSession] = useState<Session | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [showSplash, setShowSplash] = useState(true);
  const [stationReady, setStationReady] = useState(false);
  const markStationReady = useCallback(() => setStationReady(true), []);
  const finishSplash = useCallback(() => setShowSplash(false), []);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current) content.current.inert = showSplash;
  }, [showSplash]);

  useEffect(() => {
    let request: AbortController | undefined;
    let active = true;
    let standalone = false;
    async function refresh() {
      if (!active || request || standalone) return;
      const controller = new AbortController();
      request = controller;
      const deadline = window.setTimeout(() => controller.abort(), 3500);
      try {
        const next = await sessionRequest("session", undefined, controller.signal);
        if (active) {
          standalone = !next.required;
          setSession(next);
          setError(current => current === verificationError ? "" : current);
          if (next.required && !next.username) setStationReady(false);
        }
      } catch {
        if (active) {
          setSession(null);
          setStationReady(false);
          setError(verificationError);
        }
      } finally {
        window.clearTimeout(deadline);
        request = undefined;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3500);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(timer);
    };
  }, [retry]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const next = await sessionRequest("login", { username, password }, AbortSignal.timeout(5000));
      setShowSplash(true);
      setSession(next);
      setRetry(value => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not sign in");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      setSession(await sessionRequest("logout", {}, AbortSignal.timeout(5000)));
      setError("");
      setStationReady(false);
      setRetry(value => value + 1);
    } catch {
      setSession(null);
      setStationReady(false);
      setError("Sign-out could not be confirmed. Reconnect to check the station session.");
    }
  }

  const authorized = session && (!session.required || session.username);
  const splashReady = authorized ? stationReady : Boolean(session || error);

  return <>
    {showSplash && <BootSplash ready={splashReady} onComplete={finishSplash}/>}
    <div ref={content} aria-hidden={showSplash || undefined}>
      {authorized ? <App onInitialChecksComplete={markStationReady}
        account={session.username && session.role ? { name: session.username, role: session.role,
          signOut: () => void signOut() } : undefined}/>
        : (session || error) && <main className="station-access">
        <section className="station-access-card">
          <StationMark phase={error ? "attention" : !session || busy ? "checking" : "idle"}/>
          <h1>{session?.required ? "Station sign-in" : error ? "Station connection unavailable" : "Checking station access"}</h1>
          {error && <p role="alert">{error}</p>}
          {session?.required ? <form className="form-stack" onSubmit={signIn}>
            <label>Operator name<input required autoComplete="username" maxLength={64} value={username}
              onChange={event => setUsername(event.target.value)}/></label>
            <label>Password<input required type="password" autoComplete="current-password" maxLength={256}
              value={password} onChange={event => setPassword(event.target.value)}/></label>
            <div className="boot-actions"><button disabled={busy}>{busy ? "Signing in" : "Sign in"}</button></div>
          </form> : error && <div className="boot-actions"><button type="button"
            onClick={() => { setError(""); setShowSplash(true); setRetry(value => value + 1); }}>Retry</button></div>}
        </section>
      </main>}
    </div>
  </>;
}
