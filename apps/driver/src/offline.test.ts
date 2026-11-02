import { describe, expect, it, vi } from "vitest";
import { newMark, type Mark } from "./Marks";
import {
  CONFLICT_NOTE, latestMarks, markQueue, requestPersistentStorage, savedPlanFor, signOut, startFlushing, wipeIfRevoked,
  type CachedPlan, type LocalStore, type QueuedMark,
} from "./offline";

/** The store contract in memory; the IndexedDB one is exercised by the C3 test in apps/office/e2e/driver-offline.e2e.ts. */
function memoryStore() {
  const marks = new Map<string, QueuedMark>();
  let plan: CachedPlan | null = null;
  const store: LocalStore = {
    marks: async () => [...marks.values()].map((item) => structuredClone(item)),
    putMark: async (item) => void marks.set(item.id, structuredClone(item)),
    plan: async () => plan,
    putPlan: async (value) => void (plan = value),
    clear: async () => {
      marks.clear();
      plan = null;
    },
  };
  return { store, marks, getPlan: () => plan };
}

const mark = (n: number, kind: Mark["kind"] = "subio") => newMark(
  { transferId: n, kind, location: null, version: 1 }, new Date(`2026-10-23T12:0${n}:00.000Z`), `00000000-0000-4000-8000-00000000000${n}`,
);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const savedPlan = (userId: number): CachedPlan => ({ userId, days: [], handovers: {}, fetchedAt: "2026-10-23T11:00:00.000Z" });
const stored = (sent: Mark) => json({ mark: { ...sent, routeId: 9, serverTime: "2026-10-23T12:10:00.000Z", flags: [] } }, 201);

describe("Marca queue on the phone", () => {
  it("rule 1: keeps a queued Marca without signal, on an expired session, on a refusal or a foreign answer, and wipes only on a revoked device", async () => {
    const { store, marks, getPlan } = memoryStore();
    const queue = markQueue(store, async () => {
      throw new TypeError("Failed to fetch");
    });
    await queue.add(9, mark(1));
    expect(await queue.flush()).toEqual({ result: "offline", confirmed: 0 });
    expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", routeId: 9, mark: mark(1) });

    const answers = [
      json({ error: "Authentication required", code: "session_expired" }, 401),
      json({ error: "This Recorrido is closed" }, 409),
      new Response("Bad gateway", { status: 502 }),
      // A captive portal answers 200 with its own page: that is not the server confirming the Marca.
      new Response("<html>Wi-Fi login</html>", { status: 200 }),
    ];
    const results: string[] = [];
    for (const answer of answers) {
      results.push((await markQueue(store, async () => answer).flush()).result);
      expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", mark: mark(1) });
    }
    expect(results).toEqual(["signed_out", "done", "done", "done"]);
    expect(marks.get(mark(1).id)?.note).toBe("The server did not take the Marca yet; it stays on the phone");
    await markQueue(store, async () => json({ error: "This Recorrido is closed" }, 409)).flush();
    expect(marks.get(mark(1).id)?.note).toBe("This Recorrido is closed");

    await store.putPlan(savedPlan(7));
    await queue.add(9, mark(2));
    const send = vi.fn(async () => json({ error: "Authentication required", code: "session_revoked" }, 401));
    expect(await markQueue(store, send).flush()).toEqual({ result: "revoked", confirmed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(marks.size).toBe(0);
    expect(getPlan()).toBeNull();
  });

  it("rule 2: never sends a confirmed Marca again, and concurrent flushes send each Marca once", async () => {
    const { store, marks } = memoryStore();
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = markQueue(store, async (_routeId, body) => {
      sent.push(body.id);
      await gate;
      return stored(body);
    });
    await queue.add(9, mark(2, "entregado"));
    await queue.add(9, mark(1));
    // online, visibilitychange and the app opening may all fire together.
    const flushes = [queue.flush(), queue.flush(), queue.flush()];
    release();
    expect(await Promise.all(flushes)).toEqual(Array(3).fill({ result: "done", confirmed: 2 }));
    expect(sent).toEqual([mark(1).id, mark(2).id]);
    expect([...marks.values()].map((item) => item.state)).toEqual(["confirmed", "confirmed"]);
    expect(await queue.flush()).toEqual({ result: "done", confirmed: 0 });
    expect(sent).toHaveLength(2);
  });

  it("rule 2: a Marca the server already had is confirmed once, and other content is noted as a conflict", async () => {
    const { store, marks } = memoryStore();
    await markQueue(store, async () => json({ mark: { id: mark(1).id } }, 200)).add(9, mark(1));
    await markQueue(store, async () => json({ mark: { id: mark(1).id }, conflict: true }, 200)).flush();
    expect(marks.get(mark(1).id)).toMatchObject({ state: "confirmed", note: CONFLICT_NOTE });
    expect(latestMarks([...marks.values()])[1].mark).toEqual(mark(1));
  });

  it("takes as the newest Marca of a Traslado the one the server stores last, also when phone times tie", async () => {
    const { store, marks } = memoryStore();
    const time = new Date("2026-10-23T12:00:00.000Z");
    const tied = (id: string, kind: Mark["kind"]) => newMark({ transferId: 3, kind, location: null, version: 1 }, time, id);
    const high = tied("ffffffff-ffff-4000-8000-000000000001", "subio");
    const low = tied("00000000-0000-4000-8000-000000000002", "ausente");
    const sent: string[] = [];
    const queue = markQueue(store, async (_routeId, body) => {
      sent.push(body.id);
      return stored(body);
    });
    await queue.add(9, high);
    await queue.flush();
    // Saved later with the same phone time, it reaches the server after the confirmed one, whatever its UUID.
    await queue.add(9, low);
    expect(latestMarks([...marks.values()])[3].mark).toEqual(low);
    await queue.flush();
    expect(sent).toEqual([high.id, low.id]);
    expect(latestMarks([...marks.values()])[3].mark).toEqual(low);

    // Two pending ties go out in one round: the last one sent is the newest.
    const other = memoryStore();
    const order: string[] = [];
    const round = markQueue(other.store, async (_routeId, body) => {
      order.push(body.id);
      return stored(body);
    });
    await round.add(9, low);
    await round.add(9, high);
    expect(latestMarks([...other.marks.values()])[3].id).toBe(high.id);
    await round.flush();
    expect(order).toEqual([low.id, high.id]);
    expect(latestMarks([...other.marks.values()])[3].id).toBe(order.at(-1));
  });

  it("rule 1: a 401 when the app opens or loads the plan keeps the queue on an expired session and wipes it only on a revoked device", async () => {
    const { store, marks, getPlan } = memoryStore();
    await markQueue(store, async () => json({}, 500)).add(9, mark(1));
    await store.putPlan(savedPlan(7));
    expect(await wipeIfRevoked(json({ error: "Authentication required", code: "session_expired" }, 401), store)).toBe(false);
    expect(await wipeIfRevoked(json({ error: "Authentication required" }, 401), store)).toBe(false);
    expect(await wipeIfRevoked(json({ error: "This Recorrido belongs to another Chofer" }, 403), store)).toBe(false);
    expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", mark: mark(1) });
    expect(getPlan()).toEqual(savedPlan(7));
    expect(await wipeIfRevoked(json({ error: "Authentication required", code: "session_revoked" }, 401), store)).toBe(true);
    expect(marks.size).toBe(0);
    expect(getPlan()).toBeNull();
  });

  it("shows the plan saved on the phone only to the Chofer who downloaded it", () => {
    expect(savedPlanFor(savedPlan(7), 7)).toEqual(savedPlan(7));
    expect(savedPlanFor(savedPlan(7), 8)).toBeNull();
    expect(savedPlanFor(null, 7)).toBeNull();
  });

  it("flushes when the app opens, when the connection returns and when the app becomes visible", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const flush = vi.fn();
    const stop = startFlushing(win, doc, flush);
    expect(flush).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("online"));
    expect(flush).toHaveBeenCalledTimes(2);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(3);
    stop();
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("requests persistent storage once it is not granted yet", async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => true) };
    expect(await requestPersistentStorage(storage)).toBe(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    const granted = { persisted: vi.fn(async () => true), persist: vi.fn(async () => true) };
    expect(await requestPersistentStorage(granted)).toBe(true);
    expect(granted.persist).not.toHaveBeenCalled();
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => false })).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });
});

describe("Cerrar sesión and revocation", () => {
  const offline = async (): Promise<Response> => {
    throw new TypeError("Failed to fetch");
  };
  const signedIn = async () => json({ user: { id: 7, role: "driver" } }, 200);
  const revokedAnswer = async () => json({ error: "Authentication required", code: "session_revoked" }, 401);

  it("checks the session before sending a queued Marca: a revoked phone sends none and wipes everything", async () => {
    const { store, marks, getPlan } = memoryStore();
    await store.putPlan(savedPlan(7));
    await markQueue(store, offline).add(9, mark(1));
    const sent: string[] = [];
    const send = async (_routeId: number, sentMark: Mark) => {
      sent.push(sentMark.id);
      return stored(sentMark);
    };

    expect(await markQueue(store, send, offline).flush()).toEqual({ result: "offline", confirmed: 0 });
    expect(await markQueue(store, send, async () => json({ error: "Authentication required", code: "session_expired" }, 401)).flush())
      .toEqual({ result: "signed_out", confirmed: 0 });
    expect(sent).toEqual([]);
    expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", mark: mark(1) });

    expect(await markQueue(store, send, revokedAnswer).flush()).toEqual({ result: "revoked", confirmed: 0 });
    expect(sent).toEqual([]);
    expect(marks.size).toBe(0);
    expect(getPlan()).toBeNull();
  });

  it("failed session check never uploads while revocation status is unknown, and the next conclusive check sends the queue", async () => {
    const { store, marks, getPlan } = memoryStore();
    await store.putPlan(savedPlan(7));
    await markQueue(store, offline).add(9, mark(1));
    let uploads = 0;
    const send = async (_routeId: number, sentMark: Mark) => {
      uploads++;
      return stored(sentMark);
    };
    const unavailable = async () => new Response("unavailable", { status: 503 });

    expect(await markQueue(store, send, unavailable).flush()).toEqual({ result: "done", confirmed: 0 });
    expect(await signOut(store, markQueue(store, send, unavailable), { session: unavailable, logout: offline }))
      .toEqual({ result: "refused", pending: 1, offline: false });
    expect(uploads).toBe(0);
    expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", mark: mark(1) });
    expect(getPlan()).toEqual(savedPlan(7));

    expect(await markQueue(store, send, signedIn).flush()).toEqual({ result: "done", confirmed: 1 });
    expect(uploads).toBe(1);
  });

  it("sends the queue first and refuses to end the session while a Marca is unconfirmed, without signal or refused by the server", async () => {
    const { store, marks, getPlan } = memoryStore();
    await store.putPlan(savedPlan(7));
    await markQueue(store, offline).add(9, mark(1));
    const logout = vi.fn(async () => new Response(null, { status: 204 }));

    expect(await signOut(store, markQueue(store, offline, offline), { session: offline, logout })).toEqual({ result: "refused", pending: 1, offline: true });
    expect(await signOut(store, markQueue(store, async () => json({ error: "This Recorrido is closed" }, 409), signedIn), { session: signedIn, logout }))
      .toEqual({ result: "refused", pending: 1, offline: false });
    expect(logout).not.toHaveBeenCalled();
    expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", mark: mark(1) });
    expect(getPlan()).toEqual(savedPlan(7));

    const sent: string[] = [];
    const online = markQueue(store, async (_routeId, sentMark) => {
      sent.push(sentMark.id);
      return stored(sentMark);
    }, signedIn);
    const order: string[] = [];
    expect(await signOut(store, { flush: () => (order.push("flush"), online.flush()) }, { session: signedIn, logout: async () => {
      order.push("logout");
      return new Response(null, { status: 204 });
    } })).toEqual({ result: "signed_out" });
    expect(order).toEqual(["flush", "logout"]);
    expect(sent).toEqual([mark(1).id]);
    expect(marks.get(mark(1).id)).toMatchObject({ state: "confirmed" });
  });

  it("keeps the session and the queue when the sign-out request does not reach the server", async () => {
    const { store, marks } = memoryStore();
    await markQueue(store, offline).add(9, mark(1));
    const queue = markQueue(store, async (_routeId, sentMark) => stored(sentMark), signedIn);
    expect(await signOut(store, queue, { session: signedIn, logout: offline })).toEqual({ result: "unreachable" });
    expect(await signOut(store, queue, { session: offline, logout: signedIn })).toEqual({ result: "unreachable" });
    expect(await signOut(store, queue, { session: signedIn, logout: async () => new Response("Bad gateway", { status: 502 }) }))
      .toEqual({ result: "unreachable" });
    expect(marks.get(mark(1).id)).toMatchObject({ state: "confirmed" });
  });

  it("keeps the queue for the next sign-in on an expired session and wipes a revoked phone even with nothing left to send", async () => {
    const { store, marks, getPlan } = memoryStore();
    await store.putPlan(savedPlan(7));
    await markQueue(store, offline).add(9, mark(1));
    const logout = vi.fn(async () => new Response(null, { status: 204 }));
    const expired = async () => json({ error: "Authentication required", code: "session_expired" }, 401);
    expect(await signOut(store, markQueue(store, offline, expired), { session: expired, logout })).toEqual({ result: "expired" });
    expect(marks.get(mark(1).id)).toMatchObject({ state: "pending", mark: mark(1) });

    // Every Marca confirmed, then the Oficina revokes the phone: signing out still wipes it.
    await markQueue(store, async (_routeId, sentMark) => stored(sentMark), signedIn).flush();
    expect(await signOut(store, markQueue(store, offline, revokedAnswer), { session: revokedAnswer, logout })).toEqual({ result: "revoked" });
    expect(marks.size).toBe(0);
    expect(getPlan()).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });
});
