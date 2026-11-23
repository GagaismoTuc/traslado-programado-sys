// Keeps the Chofer's screen on while a Recorrido is en curso and the app is visible, so the foreground Seguimiento
// does not stop when the phone would lock (ADR 0001). The system drops the lock when the app hides; it is asked again
// on return. Without the Screen Wake Lock API, or when the request is refused, the app asks the Chofer to keep it on.

export const KEEP_SCREEN_ON_NOTICE = "Dejá la pantalla encendida y la app abierta para que la Oficina te siga";

/** idle: no Recorrido en curso; held: the screen Wake Lock was granted; unavailable: show the notice. Hiding the app changes nothing. */
export type ScreenWakeState = "idle" | "held" | "unavailable";

export type ScreenWakeLockSentinel = Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
  readonly released: boolean;
  release: () => Promise<void>;
};
export type ScreenWakeLock = { request: (type: "screen") => Promise<ScreenWakeLockSentinel> };
export type WakeLockDocument = Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: string };

export type StartWakeLockOptions = {
  routeId: number | null;
  doc: WakeLockDocument;
  wakeLock: ScreenWakeLock | undefined;
  onStateChange: (state: ScreenWakeState) => void;
};

function releaseSafe(sentinel: ScreenWakeLockSentinel) {
  try {
    void Promise.resolve(sentinel.release()).catch(() => undefined);
  } catch {
    // A broken release never breaks the app.
  }
}

/**
 * Holds a screen Wake Lock only while `routeId` is en curso and `doc` is visible; asks again each time the document
 * becomes visible. The returned cleanup (Recorrido closed, sign-out or unmount) releases it, including a request still
 * in flight. Never throws: an unsupported or refused Wake Lock only reports "unavailable".
 */
export function startWakeLock({ routeId, doc, wakeLock, onStateChange }: StartWakeLockOptions): () => void {
  if (routeId === null) {
    onStateChange("idle");
    return () => undefined;
  }

  let stopped = false;
  let sentinel: ScreenWakeLockSentinel | null = null;
  let pending = false;
  // Bumped on hide and stop so a late answer to an old request is released instead of kept.
  let token = 0;

  // Only the current sentinel carries this listener: drop() removes it before letting go.
  function onRelease() {
    drop();
  }

  function drop() {
    if (sentinel === null) return;
    const held = sentinel;
    sentinel = null;
    held.removeEventListener("release", onRelease);
    releaseSafe(held);
  }

  function acquire() {
    if (stopped || doc.visibilityState !== "visible" || sentinel !== null || pending) return;
    if (!wakeLock || typeof wakeLock.request !== "function") {
      onStateChange("unavailable");
      return;
    }
    const mine = ++token;
    pending = true;
    let request: Promise<ScreenWakeLockSentinel>;
    try {
      request = Promise.resolve(wakeLock.request("screen"));
    } catch {
      pending = false;
      onStateChange("unavailable");
      return;
    }
    request.then((granted) => {
      if (stopped || mine !== token) {
        releaseSafe(granted);
        return;
      }
      pending = false;
      sentinel = granted;
      granted.addEventListener("release", onRelease);
      onStateChange("held");
    }, () => {
      if (stopped || mine !== token) return;
      pending = false;
      onStateChange("unavailable");
    });
  }

  function onVisibilityChange() {
    if (stopped) return;
    if (doc.visibilityState === "visible") {
      acquire();
    } else {
      token += 1;
      pending = false;
      drop();
    }
  }

  doc.addEventListener("visibilitychange", onVisibilityChange);
  acquire();

  return () => {
    if (stopped) return;
    stopped = true;
    token += 1;
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    drop();
    onStateChange("idle");
  };
}
