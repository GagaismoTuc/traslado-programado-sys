// The driver app's own offline store (no Background Sync): the Marca queue and the plan saved on the phone, in
// IndexedDB, so they survive a reload, a closed tab and a phone without signal.
import type { DriverDay } from "./Days";
import type { Handover, Mark } from "./Marks";

/** A Marca on the phone: pending until the server confirms it, then kept as confirmed. `note` is the server's last word. */
export type QueuedMark = {
  id: string;
  routeId: number;
  mark: Mark;
  state: "pending" | "confirmed";
  confirmedAt: string | null;
  note: string | null;
};
/** Today's and tomorrow's plan as last downloaded, with the handover data of every home drop-off. */
export type CachedPlan = { days: DriverDay[]; handovers: Record<number, Handover>; fetchedAt: string };

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
    request.onsuccess = () => resolve(request.result);
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

export type FlushResult = "done" | "offline" | "signed_out" | "revoked";
export type FlushOutcome = { result: FlushResult; confirmed: number };
type Send = (routeId: number, mark: Mark) => Promise<Response>;

/**
 * Sends every pending Marca once, oldest phone time first. A Marca is confirmed only when the server answers with that
 * same Marca; any other answer keeps it pending with the server's message. No signal or an expired session stops the
 * round and keeps the queue; a revoked device wipes the store without sending the rest.
 */
async function flushOnce(store: LocalStore, send: Send): Promise<FlushOutcome> {
  const pending = (await store.marks()).filter((item) => item.state === "pending")
    .sort((a, b) => a.mark.phoneTime.localeCompare(b.mark.phoneTime) || a.id.localeCompare(b.id));
  let confirmed = 0;
  for (const item of pending) {
    let response: Response;
    try {
      response = await send(item.routeId, item.mark);
    } catch {
      return { result: "offline", confirmed };
    }
    if (response.status === 401) {
      if (!await isRevoked(response)) return { result: "signed_out", confirmed };
      await store.clear();
      return { result: "revoked", confirmed };
    }
    const body = await response.json().catch(() => null) as { mark?: { id?: string }; conflict?: boolean; error?: string } | null;
    if (response.ok && body?.mark?.id === item.id) {
      await store.putMark({ ...item, state: "confirmed", confirmedAt: new Date().toISOString(), note: body.conflict ? CONFLICT_NOTE : null });
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
export function markQueue(store: LocalStore, send: Send) {
  let running: Promise<FlushOutcome> | null = null;
  let again = false;
  async function loop() {
    let confirmed = 0;
    let outcome: FlushOutcome;
    do {
      again = false;
      outcome = await flushOnce(store, send);
      confirmed += outcome.confirmed;
    } while (again && outcome.result === "done");
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
      running = loop().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/** The newest Marca the phone holds for each Traslado. */
export function latestMarks(items: QueuedMark[]) {
  const latest: Record<number, QueuedMark> = {};
  for (const item of items) {
    const current = latest[item.mark.transferId];
    if (!current || item.mark.phoneTime > current.mark.phoneTime) latest[item.mark.transferId] = item;
  }
  return latest;
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
