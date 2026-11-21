import StationMark from "./StationMark";
import { useEffect, useState, type FormEvent } from "react";
import App from "./App";

type Session = { required: boolean; username: string | null; role: "admin" | "operator" | "viewer" | null };

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

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    let standalone = false;
    async function refresh() {
      if (checking || standalone) return;
      checking = true;
      try {
        const next = await sessionRequest("session", undefined, AbortSignal.any([
          controller.signal, AbortSignal.timeout(3500)
        ]));
        if (!controller.signal.aborted) {
          standalone = !next.required;
          setSession(next);
        }
      } catch {
        if (!controller.signal.aborted) {
          setSession(null);
          setError("The station connection could not be verified.");
        }
      } finally {
        checking = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [retry]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      setSession(await sessionRequest("login", { username, password }, AbortSignal.timeout(5000)));
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
      setRetry(value => value + 1);
    } catch {
      setSession(null);
      setError("Sign-out could not be confirmed. Reconnect to check the station session.");
    }
  }

  if (session && (!session.required || session.username)) {
    return <App account={session.username && session.role ? { name: session.username, role: session.role,
      signOut: () => void signOut() } : undefined}/>;
  }
  return <main className="station-boot">
    <section className="station-boot-inner">
      <StationMark phase={error ? "attention" : !session || busy ? "checking" : "idle"}/>
      <h1>{session?.required ? "Station sign-in" : "Checking station access"}</h1>
      {error && <p role="alert">{error}</p>}
      {session?.required ? <form className="form-stack" onSubmit={signIn}>
        <label>Operator name<input required autoComplete="username" maxLength={64} value={username}
          onChange={event => setUsername(event.target.value)}/></label>
        <label>Password<input required type="password" autoComplete="current-password" maxLength={256}
          value={password} onChange={event => setPassword(event.target.value)}/></label>
        <div className="boot-actions"><button disabled={busy}>{busy ? "Signing in" : "Sign in"}</button></div>
      </form> : error && <div className="boot-actions"><button type="button"
        onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry</button></div>}
    </section>
  </main>;
}
