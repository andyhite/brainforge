import { useEffect, useState, type FormEvent } from "react";
import { NetworkError, pair } from "../../api/client.ts";
import { Banner } from "../../components/ui.tsx";

export function Pairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [lockedUntil, setLockedUntil] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const secondsLeft = lockedUntil === undefined ? 0 : Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const locked = secondsLeft > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked || busy || code.trim() === "") return;
    setBusy(true);
    setMessage(undefined);
    try {
      const outcome = await pair(code.trim());
      if (outcome.ok) {
        onPaired();
        return;
      }
      setMessage(outcome.message);
      if (outcome.locked) {
        const until = Date.now() + (outcome.retryAfterSeconds ?? 60) * 1000;
        setLockedUntil(until);
        setNow(Date.now());
      }
      setCode("");
    } catch (error) {
      setMessage(error instanceof NetworkError ? error.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 480, margin: "10vh auto", padding: 24 }}>
      <h1>Pair this browser</h1>
      <p>
        Brainforge printed a pairing code in the terminal where the server was started. Enter it here to sign in. The code works once and expires after 10 minutes.
      </p>
      <form onSubmit={(event) => void submit(event)} className="panel">
        <div className="field">
          <label htmlFor="pair-code">Pairing code</label>
          <input
            id="pair-code" type="text" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} autoFocus
            value={code} onChange={(event) => setCode(event.target.value)} aria-describedby="pair-hint" disabled={locked}
          />
          <div className="hint" id="pair-hint">Restart the server to print a fresh code if this one expired.</div>
        </div>
        {locked ? (
          <Banner tone="warn" title="Pairing is locked">Too many wrong codes. Try again in {secondsLeft} second{secondsLeft === 1 ? "" : "s"}.</Banner>
        ) : message ? (
          <Banner tone="bad" title="Pairing failed">{message}</Banner>
        ) : null}
        <button type="submit" className="primary" disabled={busy || locked || code.trim() === ""}>{busy ? "Pairing…" : "Pair"}</button>
      </form>
    </main>
  );
}
