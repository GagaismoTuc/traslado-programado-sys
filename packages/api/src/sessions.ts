import { createTOTPKeyURI, verifyHOTP } from "@oslojs/otp";

export type EndReason = "logout" | "device_revoked" | "account_disabled" | "password_reset" | "totp_reset" | "break_glass";
export type SessionFailureCode = "session_expired" | "session_revoked";
export type SecondFactorStep = "code_required" | "enrolment_required";

export const END_REASON_CODES: Record<EndReason, SessionFailureCode> = {
  logout: "session_expired",
  device_revoked: "session_revoked",
  account_disabled: "session_revoked",
  password_reset: "session_expired",
  totp_reset: "session_expired",
  break_glass: "session_revoked",
};

export const PENDING_SECOND_FACTOR_MS = 10 * 60 * 1000;
export const OFFICE_IDLE_MS = 12 * 60 * 60 * 1000;
export const DRIVER_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const REMEMBER_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export type SessionRow = {
  session_id: number;
  user_id: number;
  username: string;
  role: string;
  device_label: string;
  created_at: Date;
  last_used_at: Date;
  second_factor_at: Date | null;
  revoked_at: Date | null;
  ended_reason: string | null;
  disabled_at: Date | null;
  persistent_session: boolean;
  totp_confirmed_at: Date | null;
};

export const SESSION_COLUMNS = `s.id AS session_id, s.user_id, u.username, u.role, s.device_label, s.created_at, s.last_used_at,
  s.second_factor_at, s.revoked_at, s.ended_reason, u.disabled_at, u.persistent_session, u.totp_confirmed_at`;

export type SessionState =
  | { kind: "active" }
  | { kind: "pending"; secondFactor: SecondFactorStep }
  | { kind: "ended"; code: SessionFailureCode };

export function sessionState(row: SessionRow, now: Date): SessionState {
  if (row.disabled_at) return { kind: "ended", code: "session_revoked" };
  if (row.revoked_at) return { kind: "ended", code: END_REASON_CODES[row.ended_reason as EndReason] ?? "session_expired" };
  const time = now.getTime();
  if (row.role === "office" && !row.second_factor_at) {
    if (time - row.created_at.getTime() >= PENDING_SECOND_FACTOR_MS) return { kind: "ended", code: "session_expired" };
    return { kind: "pending", secondFactor: row.totp_confirmed_at ? "code_required" : "enrolment_required" };
  }
  if (row.role === "office" && row.persistent_session) return { kind: "active" };
  const idleLimit = row.role === "office" ? OFFICE_IDLE_MS : DRIVER_IDLE_MS;
  return time - row.last_used_at.getTime() >= idleLimit ? { kind: "ended", code: "session_expired" } : { kind: "active" };
}

export function totpKeyUri(username: string, key: Uint8Array) {
  const uri = createTOTPKeyURI("Traslado Programado", username, key, TOTP_PERIOD_SECONDS, TOTP_DIGITS);
  return { uri, secret: new URL(uri).searchParams.get("secret") ?? "" };
}

export function totpStep(now: Date) {
  return Math.floor(now.getTime() / (TOTP_PERIOD_SECONDS * 1000));
}

/** Returns the step (within ±1 of now) that the code matches, or null. */
export function matchTotpStep(key: Uint8Array, code: string, now: Date) {
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (verifyHOTP(key, BigInt(step), TOTP_DIGITS, code)) return step;
  }
  return null;
}

export function createAttemptLimiter(limit: number, windowMs: number, now: () => Date) {
  const failures = new Map<string, { count: number; expiresAt: number }>();
  const pending = new Map<string, number>();
  return {
    retryAfterSeconds: Math.ceil(windowMs / 1000),
    reserve(key: string) {
      const time = now().getTime();
      for (const [entry, value] of failures) if (value.expiresAt <= time) failures.delete(entry);
      const failure = failures.get(key);
      const failed = failure && failure.expiresAt > time ? failure.count : 0;
      if (failed + (pending.get(key) ?? 0) >= limit) return false;
      pending.set(key, (pending.get(key) ?? 0) + 1);
      return true;
    },
    finish(key: string, failed: boolean) {
      const inFlight = pending.get(key) ?? 0;
      if (inFlight <= 1) pending.delete(key);
      else pending.set(key, inFlight - 1);
      if (!failed) return;
      const time = now().getTime();
      const previous = failures.get(key);
      failures.set(key, { count: (previous && previous.expiresAt > time ? previous.count : 0) + 1, expiresAt: time + windowMs });
    },
  };
}
