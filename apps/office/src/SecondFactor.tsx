import { useEffect, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { readError, send } from "./api";

type Step = "loading" | "code_required" | "enrolment_required";
type Enrolment = { secret: string; uri: string };

export function TotpQrCode({ uri }: { uri: string }) {
  const code = qrcode(0, "M");
  code.addData(uri);
  code.make();
  const size = code.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) if (code.isDark(row, column)) cells.push(`M${column} ${row}h1v1h-1z`);
  }
  return <svg role="img" aria-label="QR code for the authenticator app" viewBox={`-4 -4 ${size + 8} ${size + 8}`} width="232" height="232">
    <rect x="-4" y="-4" width={size + 8} height={size + 8} fill="#fff" />
    <path d={cells.join("")} fill="#000" />
  </svg>;
}

export function EnrolmentDetails({ enrolment }: { enrolment: Enrolment }) {
  return <section>
    <p>Scan this code with an authenticator app, or type the key by hand.</p>
    <TotpQrCode uri={enrolment.uri} />
    <p>Key: <code>{enrolment.secret}</code></p>
  </section>;
}

export function CodeForm({ onSubmit, error, busy }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string; busy: boolean }) {
  return <form onSubmit={onSubmit}>
    <label>Code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
    <label><input name="rememberDevice" type="checkbox" /> Remember this device for 30 days</label>
    {error && <p role="alert">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? "Checking..." : "Verify"}</button>
  </form>;
}

export function SecondFactorPage({ initialStep = "loading" }: { initialStep?: Step }) {
  const [step, setStep] = useState<Step>(initialStep);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void send("/auth/me", "GET").then(async (response) => {
      const result = response.ok ? await response.json() as { secondFactor?: Step } : null;
      if (!result) window.location.assign("/");
      else if (!result.secondFactor) window.location.assign("/users");
      else setStep(result.secondFactor);
    }).catch(() => setError("Unable to reach the server"));
  }, []);

  async function startEnrolment() {
    setError("");
    const response = await send("/auth/totp/enrol", "POST", {});
    if (response.ok) setEnrolment(await response.json() as Enrolment);
    else setError(await readError(response, "Unable to start enrolment"));
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const values = new FormData(event.currentTarget);
    try {
      const response = await send("/auth/totp/verify", "POST", { code: values.get("code"), rememberDevice: values.get("rememberDevice") === "on" });
      if (response.ok) window.location.assign("/users");
      else if (response.status === 401) window.location.assign("/");
      else setError(await readError(response, "Unable to verify the code"));
    } catch {
      setError("Unable to reach the server");
    } finally {
      setBusy(false);
    }
  }

  if (step === "loading") return <main><h1>Two-factor authentication</h1><p>Checking sign-in...</p>{error && <p role="alert">{error}</p>}</main>;
  if (step === "enrolment_required" && !enrolment) {
    return <main>
      <h1>Set up two-factor authentication</h1>
      <p>Office accounts need a code from an authenticator app on each new device.</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void startEnrolment()}>Start setup</button>
    </main>;
  }
  return <main>
    <h1>{enrolment ? "Set up two-factor authentication" : "Enter your code"}</h1>
    {enrolment && <EnrolmentDetails enrolment={enrolment} />}
    <CodeForm onSubmit={(event) => void verify(event)} error={error} busy={busy} />
  </main>;
}
