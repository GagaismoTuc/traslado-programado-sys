// The driver app's own offline store (no Background Sync): the Marca queue and the plan saved on the phone, in
// IndexedDB, so they survive a reload, a closed tab and a phone without signal.
import { markOrder } from "@traslado/shared";
import type { DriverDay } from "./Days";
import type { Handover, Mark } from "./Marks";

/**
 * A Marca on the phone: pending until the server confirms it, then kept as confirmed. `note` is the server's last word.
 * Each confirmation on the phone is later than the one before, so `confirmedAt` orders the Marcas as the server stored them.
 */
export type QueuedMark = {
  id: string;
  routeId: number;
  mark: Mark;
  state: "pending" | "confirmed";
  confirmedAt: string | null;
  note: string | null;
};
/** Today's and tomorrow's plan as last downloaded by the Chofer `userId`, with the handover data of every home drop-off. */
export type CachedPlan = { userId: number; days: DriverDay[]; handovers: Record<number, Handover>; fetchedAt: string };

export type LocalStore = {
  marks(): Promise<QueuedMark[]>;
  putMark(item: QueuedMark): Promise<void>;
  plan(): Promise<CachedPlan | null>;
  putPlan(plan: CachedPlan): Promise<void>;
  /** Wipes everything; only a revoked device does it. */
  clear(): Promise<void>;
};

// The 401 code the server answers to a device revoked by the Oficina; any other failure keeps the queue.
export const REVOKED_CODE = "session_revoked";
export const CONFLICT_NOTE = "The server already had this Marca with other content; it kept the first one";

/** The store in IndexedDB; a write resolves once its transaction is committed. */
export function indexedDbStore(factory: IDBFactory = indexedDB): LocalStore {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("driver-app", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("marks", { keyPath: "id" });
      request.result.createObjectStore("plan");
    };
    request.onsuccess = () => {
      // The browser may close the connection (WebKit does after a while in the background): the next call reopens it.
      request.result.onclose = () => {
        opened = null;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      opened = null;
      reject(request.error);
    };
  });
  async function run<T>(stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => IDBRequest<T> | void) {
    const transaction = (await database()).transaction(stores, mode);
    const request = work(transaction);
    return await new Promise<T | undefined>((resolve, reject) => {
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  return {
    marks: async () => await run(["marks"], "readonly", (transaction) => transaction.objectStore("marks").getAll() as IDBRequest<QueuedMark[]>) ?? [],
    putMark: async (item) => {
      await run(["marks"], "readwrite", (transaction) => void transaction.objectStore("marks").put(item));
    },
    plan: async () => await run(["plan"], "readonly", (transaction) => transaction.objectStore("plan").get("current") as IDBRequest<CachedPlan | undefined>) ?? null,
    putPlan: async (plan) => {
      await run(["plan"], "readwrite", (transaction) => void transaction.objectStore("plan").put(plan, "current"));
    },
    clear: async () => {
      await run(["marks", "plan"], "readwrite", (transaction) => {
        transaction.objectStore("marks").clear();
        transaction.objectStore("plan").clear();
      });
    },
  };
}

/** True when a 401 says the Oficina revoked this device. */
export async function isRevoked(response: Response) {
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null) as { code?: string } | null;
  return body?.code === REVOKED_CODE;
}

/** On a 401, wipes the phone only when the device was revoked, and says whether it did; an expired session keeps everything. */
export async function wipeIfRevoked(response: Response, store: LocalStore) {
  if (!await isRevoked(response)) return false;
  await store.clear();
  return true;
}

/** The saved plan, only for the Chofer who downloaded it: another Chofer signing in on the phone never sees it. */
export function savedPlanFor(saved: CachedPlan | null, userId: number) {
  return saved?.userId === userId ? saved : null;
}

export type FlushResult = "done" | "offline" | "signed_out" | "revoked";
export type FlushOutcome = { result: FlushResult; confirmed: number };
type Send = (routeId: number, mark: Mark) => Promise<Response>;
// Asks the server about this phone's session (`GET /auth/me`) without sending any Marca.
type SessionCheck = () => Promise<Response>;

/**
 * Sends every pending Marca once, in `queueOrder`, so the server stores them in the order the phone reads them. A Marca
 * is confirmed only when the server answers with that same Marca; any other answer keeps it pending with the server's
 * message. No signal or an expired session stops the
 * round and keeps the queue; a revoked device wipes the store without sending the rest. With `check`, the session is
 * asked first, so a revoked phone wipes before any Marca leaves it; any answer that cannot rule out a revocation (not a
 * success, not a 401) sends nothing and keeps the queue pending for the next round; a revocation that lands between the check and the
 * first send lets that one Marca go out, and the server refuses it.
 */
async function flushOnce(store: LocalStore, send: Send, check?: SessionCheck): Promise<FlushOutcome> {
  const items = await store.marks();
  // At least 1 ms after the last confirmation, even within one millisecond or after the phone's clock went back.
  let lastConfirmed = Math.max(0, ...items.map((item) => item.confirmedAt ? Date.parse(item.confirmedAt) : 0));
  const pending = items.filter((item) => item.state === "pending").sort(queueOrder);
  if (pending.length && check) {
    let response: Response;
    try {
      response = await check();
    } catch {
      return { result: "offline", confirmed: 0 };
    }
    if (response.status === 401) return { result: await wipeIfRevoked(response, store) ? "revoked" : "signed_out", confirmed: 0 };
    if (!response.ok) return { result: "done", confirmed: 0 };
  }
  let confirmed = 0;
  for (const item of pending) {
    let response: Response;
    try {
      response = await send(item.routeId, item.mark);
    } catch {
      return { result: "offline", confirmed };
    }
    if (response.status === 401) return { result: await wipeIfRevoked(response, store) ? "revoked" : "signed_out", confirmed };
    const body = await response.json().catch(() => null) as { mark?: { id?: string }; conflict?: boolean; error?: string } | null;
    if (response.ok && body?.mark?.id === item.id) {
      lastConfirmed = Math.max(Date.now(), lastConfirmed + 1);
      await store.putMark({ ...item, state: "confirmed", confirmedAt: new Date(lastConfirmed).toISOString(), note: body.conflict ? CONFLICT_NOTE : null });
      confirmed++;
    } else {
      await store.putMark({ ...item, note: body?.error ?? "The server did not take the Marca yet; it stays on the phone" });
    }
  }
  return { result: "done", confirmed };
}

/**
 * The Marca queue. `add` saves a new Marca as pending before anything is sent. Only one flush runs at a time: a flush
 * asked for while one runs makes it go round again, so a Marca is never sent twice at once from this tab.
 */
export function markQueue(store: LocalStore, send: Send, check?: SessionCheck) {
  let running: Promise<FlushOutcome> | null = null;
  let again = false;
  async function loop() {
    let confirmed = 0;
    let outcome: FlushOutcome;
    try {
      do {
        again = false;
        outcome = await flushOnce(store, send, check);
        confirmed += outcome.confirmed;
      } while (again && outcome.result === "done");
    } finally {
      // Cleared in the same step as the last check of `again`, so a flush asked for later starts a new round.
      running = null;
    }
    return { result: outcome.result, confirmed };
  }
  return {
    add: async (routeId: number, mark: Mark) => {
      await store.putMark({ id: mark.id, routeId, mark, state: "pending", confirmedAt: null, note: null });
    },
    flush: () => {
      if (running) {
        again = true;
        return running;
      }
      running = loop();
      return running;
    },
  };
}

/**
 * The Marcas on the phone in the order the server holds them (`markOrder`). A Marca reaches the server when it is
 * confirmed, so with the same phone time the confirmed ones come first, in the order they were confirmed, and the pending
 * ones follow in the order the queue sends them, which is this same order (the UUID only breaks ties among those).
 */
export const queueOrder = markOrder<QueuedMark>((item) => item.mark.phoneTime, (a, b) =>
  Number(a.state === "pending") - Number(b.state === "pending") || (a.confirmedAt ?? "").localeCompare(b.confirmedAt ?? "")
  || a.id.localeCompare(b.id));

/** The newest Marca the phone holds for each Traslado: the last one in `queueOrder`, the one the server takes as latest. */
export function latestMarks(items: QueuedMark[]) {
  const latest: Record<number, QueuedMark> = {};
  for (const item of [...items].sort(queueOrder)) latest[item.mark.transferId] = item;
  return latest;
}

export type SignOutOutcome =
  | { result: "signed_out" | "expired" | "revoked" | "unreachable" }
  | { result: "refused"; pending: number; offline: boolean };

/**
 * "Cerrar sesión": sends the queue first and ends the session only when no Marca is left unconfirmed on the phone. Without
 * signal, or with a Marca the server did not take, it refuses and keeps everything. An expired session keeps the queue for
 * the next sign-in; a revoked device is wiped, also when the queue was already empty and the flush asked nothing.
 */
export async function signOut(
  store: LocalStore,
  queue: { flush: () => Promise<FlushOutcome> },
  server: { session: SessionCheck; logout: () => Promise<Response> },
): Promise<SignOutOutcome> {
  const outcome = await queue.flush();
  if (outcome.result === "revoked") return { result: "revoked" };
  if (outcome.result === "signed_out") return { result: "expired" };
  const pending = (await store.marks()).filter((item) => item.state === "pending").length;
  if (pending) return { result: "refused", pending, offline: outcome.result === "offline" };
  try {
    // The logout answers 204 even to a revoked session: only the session itself says whether to wipe.
    const session = await server.session();
    if (session.status === 401) return { result: await wipeIfRevoked(session, store) ? "revoked" : "expired" };
    if (!session.ok) return { result: "unreachable" };
    return (await server.logout()).ok ? { result: "signed_out" } : { result: "unreachable" };
  } catch {
    return { result: "unreachable" };
  }
}

type Listener = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Flushes now (the app was opened), when the connection returns and when the app becomes visible; returns the cleanup. */
export function startFlushing(win: Listener, doc: Listener & { visibilityState: string }, flush: () => void) {
  const onOnline = () => flush();
  const onVisibility = () => {
    if (doc.visibilityState === "visible") flush();
  };
  win.addEventListener("online", onOnline);
  doc.addEventListener("visibilitychange", onVisibility);
  flush();
  return () => {
    win.removeEventListener("online", onOnline);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Asks the browser not to evict the queue and the plan under storage pressure; false when it is refused or unsupported. */
export async function requestPersistentStorage(storage: Pick<StorageManager, "persist" | "persisted"> | undefined) {
  if (!storage?.persist) return false;
  try {
    return await storage.persisted() || await storage.persist();
  } catch {
    return false;
  }
}
