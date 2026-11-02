// The driver app's own offline store (no Background Sync): the Marca queue and the plan saved on the phone, in
// IndexedDB, so they survive a reload, a closed tab and a phone without signal.
import { markOrder } from "@traslado/shared";
import type { DriverDay } from "./Days";
import type { Handover, Mark } from "./Marks";

/**
 * A Marca on the phone: pending until the server confirms it, then kept as confirmed until the end-of-day wipe; a server
 * restored from a backup makes it pending again. `note` is the server's last word. Each confirmation on the phone is later
 * than the one before, so `confirmedAt` orders the Marcas as the server stored them.
 */
export type QueuedMark = {
  id: string;
  routeId: number;
  mark: Mark;
  state: "pending" | "confirmed";
  confirmedAt: string | null;
  note: string | null;
  // False until the queue first tries to send it; a Marca saved before this field existed counts as tried.
  sent?: boolean;
};
/** Today's and tomorrow's plan as last downloaded by the Chofer `userId`, with the handover data of every home drop-off. */
export type CachedPlan = { userId: number; days: DriverDay[]; handovers: Record<number, Handover>; fetchedAt: string };

export type LocalStore = {
  marks(): Promise<QueuedMark[]>;
  putMark(item: QueuedMark): Promise<void>;
  deleteMark(id: string): Promise<void>;
  plan(): Promise<CachedPlan | null>;
  putPlan(plan: CachedPlan): Promise<void>;
  /** The server epoch the phone's confirmed Marcas were stored under, or null before the first one. */
  epoch(): Promise<string | null>;
  putEpoch(epoch: string): Promise<void>;
  /** The end-of-day wipe of what `endedData` names, in one step that does nothing while a Marca on the phone is pending. */
  wipeEnded(today: string): Promise<void>;
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
    deleteMark: async (id) => {
      await run(["marks"], "readwrite", (transaction) => void transaction.objectStore("marks").delete(id));
    },
    plan: async () => await run(["plan"], "readonly", (transaction) => transaction.objectStore("plan").get("current") as IDBRequest<CachedPlan | undefined>) ?? null,
    putPlan: async (plan) => {
      await run(["plan"], "readwrite", (transaction) => void transaction.objectStore("plan").put(plan, "current"));
    },
    // Kept next to the plan, so the store needs no new version; a revoked device wipes it with the rest.
    epoch: async () => await run(["plan"], "readonly", (transaction) => transaction.objectStore("plan").get("epoch") as IDBRequest<string | undefined>) ?? null,
    putEpoch: async (epoch) => {
      await run(["plan"], "readwrite", (transaction) => void transaction.objectStore("plan").put(epoch, "epoch"));
    },
    // One transaction reads and wipes, so a Marca saved meanwhile is either seen as pending or saved after the wipe.
    wipeEnded: async (today) => {
      await run(["marks", "plan"], "readwrite", (transaction) => {
        const marks = transaction.objectStore("marks");
        const plans = transaction.objectStore("plan");
        const items = marks.getAll() as IDBRequest<QueuedMark[]>;
        const plan = plans.get("current") as IDBRequest<CachedPlan | undefined>;
        plan.onsuccess = () => {
          const ended = endedData(items.result, plan.result ?? null, today);
          if (!ended) return;
          for (const id of ended.markIds) marks.delete(id);
          if (ended.plan) plans.delete("current");
        };
      });
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

// The Plan diario's zone, the same one `driverDays` uses.
const PLAN_TIME_ZONE = "America/Argentina/Tucuman";

/** The Plan diario day (YYYY-MM-DD) a moment falls on. */
export function planDay(time: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(time);
}

/**
 * What the end-of-day wipe removes on `today`: the Marcas made on an earlier day, and the saved plan once none of its days
 * is today or later. Null, so nothing is wiped, while any Marca on the phone is not confirmed by the server.
 */
export function endedData(items: QueuedMark[], plan: CachedPlan | null, today: string) {
  if (items.some((item) => item.state === "pending")) return null;
  return {
    markIds: items.filter((item) => planDay(new Date(item.mark.phoneTime)) < today).map((item) => item.id),
    plan: plan !== null && plan.days.every((day) => day.date < today),
  };
}

// The header in which every API answer names the server epoch; a restore from a backup changes it.
const EPOCH_HEADER = "X-Server-Epoch";

/**
 * Compares the epoch `response` names with the one the phone's confirmed Marcas were stored under. On a new epoch the
 * server may have lost them, so every confirmed Marca on the phone (only the day's, after the end-of-day wipe) is made
 * pending again, keeping its place in `queueOrder`, and is sent again. The epoch is saved last: an interrupted round
 * compares again next time, and the server's upsert by UUID takes a Marca sent twice once. Says whether it re-queued.
 */
async function requeueOnNewEpoch(store: LocalStore, items: QueuedMark[], response: Response) {
  const epoch = response.headers.get(EPOCH_HEADER)?.trim();
  if (!epoch) return false;
  const known = await store.epoch();
  if (known === epoch) return false;
  const confirmed = known === null ? [] : items.filter((item) => item.state === "confirmed");
  for (const item of confirmed) await store.putMark({ ...item, state: "pending", note: null, sent: true });
  await store.putEpoch(epoch);
  return confirmed.length > 0;
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
 * is marked as tried before it is sent, and confirmed only when the server answers with that same Marca; any other answer
 * keeps it pending with the server's message. A Corrección of a Marca on the phone waits until the server confirmed that
 * Marca, so the API never gets one for a Marca it does not hold. No signal or an expired session stops the
 * round and keeps the queue; a revoked device wipes the store without sending the rest. With `check`, the session is
 * asked first whenever the phone holds a Marca, so a revoked phone wipes before any Marca leaves it and a new server
 * epoch sends the confirmed Marcas again (`requeueOnNewEpoch`); with a Marca pending, any answer that cannot rule out a
 * revocation (not a success, not a 401) sends nothing and keeps the queue pending for the next round; a revocation that
 * lands between the check and the first send lets that one Marca go out, and the server refuses it. A round that ends
 * with every Marca confirmed runs the end-of-day wipe.
 */
async function flushOnce(store: LocalStore, send: Send, check?: SessionCheck): Promise<FlushOutcome> {
  let items = await store.marks();
  if (items.length && check) {
    const response = await check().catch(() => null);
    if (response?.status === 401) return { result: await wipeIfRevoked(response, store) ? "revoked" : "signed_out", confirmed: 0 };
    if (response?.ok) {
      if (await requeueOnNewEpoch(store, items, response)) items = await store.marks();
    } else if (items.some((item) => item.state === "pending")) {
      return { result: response ? "done" : "offline", confirmed: 0 };
    }
  }
  // At least 1 ms after the last confirmation, even within one millisecond or after the phone's clock went back.
  let lastConfirmed = Math.max(0, ...items.map((item) => item.confirmedAt ? Date.parse(item.confirmedAt) : 0));
  const pending = items.filter((item) => item.state === "pending").sort(queueOrder);
  const unconfirmed = new Set(items.filter((item) => item.state === "pending").map((item) => item.id));
  let confirmed = 0;
  for (const pendingItem of pending) {
    if (pendingItem.mark.corrects && unconfirmed.has(pendingItem.mark.corrects)) continue;
    const item = { ...pendingItem, sent: true };
    if (pendingItem.sent !== true) await store.putMark(item);
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
      unconfirmed.delete(item.id);
      confirmed++;
    } else {
      await store.putMark({ ...item, note: body?.error ?? "The server did not take the Marca yet; it stays on the phone" });
    }
  }
  // A failed wipe is tried again by the next round.
  await store.wipeEnded(planDay(new Date())).catch(() => undefined);
  return { result: "done", confirmed };
}

/**
 * The Marca queue. `add` saves a new Marca as pending before anything is sent. Only one flush runs at a time: a flush
 * asked for while one runs makes it go round again, so a Marca is never sent twice at once from this tab. A flush round
 * and a Deshacer never touch the queue at the same time.
 */
export function markQueue(store: LocalStore, send: Send, check?: SessionCheck) {
  let running: Promise<FlushOutcome> | null = null;
  let again = false;
  let last: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>) {
    const result = last.then(work);
    last = result.catch(() => undefined);
    return result;
  }
  async function add(routeId: number, mark: Mark) {
    await store.putMark({ id: mark.id, routeId, mark, state: "pending", confirmedAt: null, note: null, sent: false });
  }
  async function loop() {
    let confirmed = 0;
    let outcome: FlushOutcome;
    try {
      do {
        again = false;
        outcome = await exclusive(() => flushOnce(store, send, check));
        confirmed += outcome.confirmed;
      } while (again && outcome.result === "done");
    } finally {
      // Cleared in the same step as the last check of `again`, so a flush asked for later starts a new round.
      running = null;
    }
    return { result: outcome.result, confirmed };
  }
  return {
    add,
    /**
     * "Deshacer" of the Marca `undo` corrects. One the queue never tried to send is cancelled: neither it nor `undo` is
     * sent. Any other gets `undo` queued. A Marca no longer on the phone was already cancelled, so a second tap queues nothing.
     */
    undo: (routeId: number, undo: Mark) => exclusive(async () => {
      const target = (await store.marks()).find((item) => item.id === undo.corrects);
      if (target && (target.state === "confirmed" || target.sent !== false)) {
        await add(routeId, undo);
        return "queued" as const;
      }
      if (target) await store.deleteMark(target.id);
      return "cancelled" as const;
    }),
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

/** A pending Marca the server answered without taking it; its `note` is the server's reason. */
function isRefused(item: QueuedMark) {
  return item.state === "pending" && item.note !== null;
}

function lastPerTransfer(items: QueuedMark[]) {
  const latest: Record<number, QueuedMark> = {};
  for (const item of [...items].sort(queueOrder)) latest[item.mark.transferId] = item;
  return latest;
}

/**
 * The Marca in force for each Traslado: the last one in `queueOrder` among the Marcas the server confirmed and the ones
 * it has not answered yet. A Marca the server refused is never in force, since the server did not store it.
 */
export function latestMarks(items: QueuedMark[]) {
  return lastPerTransfer(items.filter((item) => !isRefused(item)));
}

/** The newest Marca the server refused for each Traslado, still on the phone with the server's reason. */
export function refusedMarks(items: QueuedMark[]) {
  return lastPerTransfer(items.filter(isRefused));
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
