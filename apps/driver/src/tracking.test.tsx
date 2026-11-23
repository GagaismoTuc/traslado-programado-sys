import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayView, DriverHome, RouteView, type DriverDay, type DriverRoute, type DriverStop, type Marking } from "./Days";
import {
  activeTrackingRouteId,
  GPS_UNAVAILABLE_NOTICE,
  LOCATION_PERMISSION_NOTICE,
  sendPositions,
  startTracking,
  TRACKING_ACTIVE_TEXT,
  type PositionSample,
  type TrackingGeolocation,
  type TrackingState,
} from "./Tracking";

// Synthetic data only.
const stop: DriverStop = {
  position: 1,
  kind: "pickup",
  plannedTime: "08:00",
  transferId: 3,
  direction: "entrada",
  transferStatus: "planificado",
  place: { name: null, destinationId: null, address: "Calle Inventada 101", accessNotes: null },
  passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null },
  companions: 0,
};

const sampleRoute = (status: string, routeId = 9): DriverRoute => ({
  routeId,
  version: 1,
  startTime: "07:00",
  endTime: "09:00",
  vehiclePlate: "AAA001",
  status,
  acknowledgedVersion: 1,
  stops: [stop],
});

const sampleMarking = (): Marking => ({
  sending: false,
  marks: {},
  refused: {},
  undone: {},
  planFetchedAt: null,
  handover: null,
  refusedClose: null,
  onStart: vi.fn(),
  onClose: vi.fn(),
  onMark: vi.fn(),
  onFlush: vi.fn(),
  onUndo: vi.fn(),
  onOpenHandover: vi.fn(),
  onOtherAdult: vi.fn(),
  onSearch: vi.fn(),
});

function fakeDoc(visibilityState: "visible" | "hidden" = "visible") {
  return Object.assign(new EventTarget(), { visibilityState });
}

function fakeGeolocation() {
  let nextId = 0;
  let onSuccess: PositionCallback | null = null;
  let onError: PositionErrorCallback | null = null;
  const watchOptions: (PositionOptions | undefined)[] = [];
  const cleared: number[] = [];
  const watchPosition = vi.fn((success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions) => {
    onSuccess = success;
    onError = error ?? null;
    watchOptions.push(options);
    return ++nextId;
  });
  const clearWatch = vi.fn((id: number) => {
    cleared.push(id);
  });
  const emit = (lat: number, lng: number, accuracy: number, timestamp: number) => {
    onSuccess?.({
      coords: { latitude: lat, longitude: lng, accuracy } as GeolocationCoordinates,
      timestamp,
    } as GeolocationPosition);
  };
  const fail = (code: number) => {
    onError?.({ code } as GeolocationPositionError);
  };
  return { geolocation: { watchPosition, clearWatch } as TrackingGeolocation, watchPosition, clearWatch, watchOptions, cleared, emit, fail };
}

type ListenerEntry = { fn: (event: unknown) => void; capture: boolean };

class FakeDomNode {
  nodeType: number;
  nodeName: string;
  ownerDocument: FakeDocument | null;
  parentNode: FakeDomNode | null = null;
  childNodes: FakeDomNode[] = [];
  private listeners = new Map<string, ListenerEntry[]>();

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get parentElement(): FakeDomElement | null {
    return this.parentNode instanceof FakeDomElement ? this.parentNode : null;
  }
  get firstChild(): FakeDomNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeDomNode | null { return this.childNodes.at(-1) ?? null; }
  get previousSibling(): FakeDomNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const idx = siblings.indexOf(this);
    return idx > 0 ? siblings[idx - 1] : null;
  }
  get nextSibling(): FakeDomNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const idx = siblings.indexOf(this);
    return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  }

  appendChild<T extends FakeDomNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends FakeDomNode>(child: T, ref: FakeDomNode | null): T {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(idx, 0, child);
    return child;
  }

  removeChild<T extends FakeDomNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  contains(target: FakeDomNode | null): boolean {
    let cur: FakeDomNode | null = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  addEventListener(type: string, fn: (event: unknown) => void, options?: boolean | AddEventListenerOptions) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((entry) => entry.fn === fn && entry.capture === capture)) {
      list.push({ fn, capture });
      this.listeners.set(type, list);
    }
  }

  removeEventListener(type: string, fn: (event: unknown) => void, options?: boolean | AddEventListenerOptions) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((entry) => !(entry.fn === fn && entry.capture === capture)));
  }

  dispatchEvent(raw: { type: string; bubbles?: boolean; cancelable?: boolean }): boolean {
    const path: FakeDomNode[] = [];
    for (let cur: FakeDomNode | null = this; cur; cur = cur.parentNode) path.push(cur);
    let stopped = false;
    let defaultPrevented = false;
    const event = Object.assign(raw, {
      target: this,
      srcElement: this,
      currentTarget: this as FakeDomNode | null,
      bubbles: raw.bubbles ?? false,
      cancelable: raw.cancelable ?? false,
      defaultPrevented: false,
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; },
      preventDefault() { defaultPrevented = true; this.defaultPrevented = true; },
    });
    for (let i = path.length - 1; i >= 0 && !stopped; i -= 1) {
      const node = path[i];
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
        if (entry.capture) entry.fn(event);
      }
    }
    const bubbleEnd = event.bubbles ? path.length : 1;
    for (let i = 0; i < bubbleEnd && !stopped; i += 1) {
      const node = path[i];
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
        if (!entry.capture) entry.fn(event);
      }
    }
    return !defaultPrevented;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(value));
  }
}

class FakeTextNode extends FakeDomNode {
  private value: string;
  constructor(data: string, ownerDocument: FakeDocument) {
    super(3, "#text", ownerDocument);
    this.value = data;
  }
  get data() { return this.value; }
  set data(next: string) { this.value = next; }
  override get textContent() { return this.value; }
  override set textContent(next: string) { this.value = next; }
  get nodeValue() { return this.value; }
  set nodeValue(next: string) { this.value = next; }
}

class FakeCommentNode extends FakeDomNode {
  data: string;
  constructor(data: string, ownerDocument: FakeDocument) {
    super(8, "#comment", ownerDocument);
    this.data = data;
  }
  override get textContent() { return ""; }
}

class FakeDomElement extends FakeDomNode {
  tagName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  disabled = false;
  type = "";
  value = "";
  defaultValue = "";
  selected = false;
  defaultSelected = false;

  constructor(tag: string, ownerDocument: FakeDocument) {
    super(1, tag.toUpperCase(), ownerDocument);
    this.tagName = tag.toUpperCase();
  }

  get options(): FakeDomElement[] {
    return this.findAll((el) => el.tagName === "OPTION");
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
    if (name === "disabled") this.disabled = true;
    if (name === "type") this.type = String(value);
    if (name === "value") this.value = String(value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === "disabled") this.disabled = false;
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  focus() {}
  blur() {}

  findAll(predicate: (el: FakeDomElement) => boolean): FakeDomElement[] {
    const out: FakeDomElement[] = [];
    const walk = (node: FakeDomNode) => {
      if (node instanceof FakeDomElement) {
        if (predicate(node)) out.push(node);
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(this);
    return out;
  }
}

class FakeDocument extends FakeDomNode {
  visibilityState: "visible" | "hidden" = "visible";
  defaultView: FakeWindow;
  documentElement: FakeDomElement;
  head: FakeDomElement;
  body: FakeDomElement;
  activeElement: FakeDomElement | null = null;

  constructor(win: FakeWindow, visibilityState: "visible" | "hidden" = "visible") {
    super(9, "#document", null);
    this.defaultView = win;
    this.visibilityState = visibilityState;
    this.documentElement = new FakeDomElement("html", this);
    this.head = new FakeDomElement("head", this);
    this.body = new FakeDomElement("body", this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string) { return new FakeDomElement(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeDomElement(tag, this); }
  createTextNode(text: string) { return new FakeTextNode(String(text), this); }
  createComment(text: string) { return new FakeCommentNode(String(text), this); }
}

class FakeWindow extends EventTarget {
  document!: FakeDocument;
  Node = FakeDomNode;
  Element = FakeDomElement;
  HTMLElement = FakeDomElement;
  HTMLIFrameElement = class {};
  Event = Event;
  MouseEvent = Event;
}

/** Minimal in-memory IDBFactory implementing the exact IndexedDB surface used by `indexedDbStore()`. */
function fakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const ensureStore = (name: string) => {
    let data = stores.get(name);
    if (!data) {
      data = new Map();
      stores.set(name, data);
    }
    return data;
  };
  const db = {
    createObjectStore(name: string) { ensureStore(name); },
    transaction(storeNames: string | string[]) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      for (const name of names) ensureStore(name);
      const tx: {
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: unknown;
        objectStore: (name: string) => Record<string, unknown>;
      } = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore(name: string) {
          const data = ensureStore(name);
          const req = <T,>(result: T) => {
            const r: { result: T; onsuccess: (() => void) | null } = { result, onsuccess: null };
            queueMicrotask(() => r.onsuccess?.());
            return r;
          };
          return {
            getAll: () => req([...data.values()].map((value) => structuredClone(value))),
            get: (key: string) => req(data.has(key) ? structuredClone(data.get(key)) : undefined),
            put: (value: { id?: string }, explicitKey?: string) => {
              const key = explicitKey ?? String(value.id);
              data.set(key, structuredClone(value));
              return req(key);
            },
            delete: (key: string) => {
              data.delete(key);
              return req(undefined);
            },
            clear: () => {
              data.clear();
              return req(undefined);
            },
          };
        },
      };
      queueMicrotask(() => {
        queueMicrotask(() => tx.oncomplete?.());
      });
      return tx;
    },
  };
  const factory = {
    open() {
      const request: {
        result: typeof db;
        error: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, stores };
}

/** Mounts a React component tree with real hooks and effects in Node using react-dom/client + act. */
async function mountApp(element: ReactElement, options: {
  geolocation: (TrackingGeolocation & Partial<Pick<Geolocation, "getCurrentPosition">>) | undefined;
  fetchImpl: typeof fetch;
  visibilityState?: "visible" | "hidden";
}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const win = new FakeWindow();
  const doc = new FakeDocument(win, options.visibilityState ?? "visible");
  win.document = doc;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const idb = fakeIndexedDb();

  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { geolocation: options.geolocation, storage: undefined });
  vi.stubGlobal("indexedDB", idb.factory);
  vi.stubGlobal("fetch", options.fetchImpl);

  const root = createRoot(container as unknown as Element);
  const flushWork = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  await act(async () => {
    root.render(element);
  });
  await flushWork();

  const buttons = () => container.findAll((el) => el.tagName === "BUTTON");
  const click = async (label: string) => {
    const target = buttons().find((btn) => btn.textContent === label);
    if (!target) {
      throw new Error(`Button "${label}" not found. Available: ${JSON.stringify(buttons().map((btn) => btn.textContent))}`);
    }
    expect(target.disabled).toBe(false);
    await act(async () => {
      target.dispatchEvent({ type: "click", bubbles: true, cancelable: true });
    });
    await flushWork();
  };
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  return { container, doc, win, idb, buttons, click, flushWork, unmount };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("Seguimiento in the driver app", () => {
  it("watches with high accuracy only while a Recorrido is en_curso and document is visible, calling clearWatch on hidden or close", () => {
    const doc = fakeDoc("visible");
    const geo = fakeGeolocation();
    const states: TrackingState[] = [];
    const send = vi.fn(async () => new Response(JSON.stringify({ saved: 0, ignored: 0 }), { status: 200 }));

    // No en_curso route → does not call watchPosition.
    expect(activeTrackingRouteId([{ date: "2026-10-23", routes: [sampleRoute("publicado"), sampleRoute("cerrado", 10)] }])).toBeNull();
    const stopIdle = startTracking({ routeId: null, doc, geolocation: geo.geolocation, send, onStateChange: (state) => states.push(state) });
    expect(geo.watchPosition).not.toHaveBeenCalled();
    stopIdle();

    // Active en_curso route while hidden → waits until visible.
    doc.visibilityState = "hidden";
    const activeDays: DriverDay[] = [{ date: "2026-10-23", routes: [sampleRoute("publicado", 8), sampleRoute("en_curso", 9)] }];
    expect(activeTrackingRouteId(activeDays)).toBe(9);
    const stop = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: (state) => states.push(state) });
    expect(geo.watchPosition).not.toHaveBeenCalled();

    // Becomes visible → starts high-accuracy watchPosition.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(geo.watchOptions[0]).toEqual({ enableHighAccuracy: true });
    expect(states.at(-1)).toBe("active");

    // Goes to background (hidden) → calls clearWatch(1).
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(geo.clearWatch).toHaveBeenCalledWith(1);
    expect(states.at(-1)).toBe("idle");

    // Returns to foreground → starts watchPosition again (id 2).
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(geo.watchPosition).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("active");

    // Recorrido closes (cleanup runs) → calls clearWatch(2).
    stop();
    expect(geo.clearWatch).toHaveBeenCalledWith(2);
    expect(states.at(-1)).toBe("idle");
  });

  it("keeps at most one Posición every 15 s and discards readings with accuracy worse than 100 m", async () => {
    const doc = fakeDoc("visible");
    const geo = fakeGeolocation();
    const sent: PositionSample[][] = [];
    const send = vi.fn(async (_routeId: number, batch: PositionSample[]) => {
      sent.push(batch);
      return new Response(JSON.stringify({ saved: batch.length, ignored: 0 }), { status: 201 });
    });

    const stop = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: () => undefined });
    const base = Date.parse("2026-10-23T12:00:00.000Z");

    // Inaccurate reading (> 100 m) is discarded and does not block an accurate reading right after.
    geo.emit(-26.83, -65.21, 150, base);
    // 4 valid readings within 10 s → only the first is kept.
    geo.emit(-26.831, -65.211, 100, base + 1000);
    geo.emit(-26.832, -65.212, 20, base + 4000);
    geo.emit(-26.833, -65.213, 15, base + 7000);
    geo.emit(-26.834, -65.214, 10, base + 10000);
    // 1 ms before the 15 s boundary → discarded; exact +15 s boundary (base + 16000) → accepted; accuracy 101 m → discarded.
    geo.emit(-26.8345, -65.2145, 10, base + 15999);
    geo.emit(-26.835, -65.215, 101, base + 16000);
    geo.emit(-26.836, -65.216, 12, base + 16000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toEqual([[
      { lat: -26.831, lng: -65.211, accuracyMeters: 100, phoneTime: "2026-10-23T12:00:01.000Z" },
      { lat: -26.836, lng: -65.216, accuracyMeters: 12, phoneTime: "2026-10-23T12:00:16.000Z" },
    ]]);
    stop();
  });

  it("sends buffered Posiciones every 30 s and retains them in memory to retry on the next tick when sending fails", async () => {
    const doc = fakeDoc("visible");
    const geo = fakeGeolocation();
    let attempt = 0;
    const sent: PositionSample[][] = [];
    const send = vi.fn(async (_routeId: number, batch: PositionSample[]) => {
      attempt += 1;
      sent.push(batch);
      if (attempt === 1) throw new Error("offline");
      if (attempt === 2) return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
      return new Response(JSON.stringify({ saved: batch.length, ignored: 0 }), { status: 201 });
    });

    const stop = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: () => undefined });
    const base = Date.parse("2026-10-23T12:00:00.000Z");
    geo.emit(-26.83, -65.21, 15, base);

    // 30 s: network failure → retained in memory.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);

    // Add a second sample before the 60 s retry.
    geo.emit(-26.82, -65.2, 12, base + 35_000);
    // 60 s: HTTP 500 → both retained in memory.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toHaveLength(2);

    // 90 s: succeeds → both sent and cleared from memory.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual([
      { lat: -26.83, lng: -65.21, accuracyMeters: 15, phoneTime: "2026-10-23T12:00:00.000Z" },
      { lat: -26.82, lng: -65.2, accuracyMeters: 12, phoneTime: "2026-10-23T12:00:35.000Z" },
    ]);

    // 120 s: buffer is now empty → no unnecessary request.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(3);
    stop();

    // If location permission is revoked (code 1) after a failed batch, the retry timer keeps running while visible & en_curso.
    const docRevoked = fakeDoc("visible");
    const geoRevoked = fakeGeolocation();
    let revokedAttempt = 0;
    const revokedSent: PositionSample[][] = [];
    const sendRevoked = vi.fn(async (_routeId: number, batch: PositionSample[]) => {
      revokedAttempt += 1;
      revokedSent.push(batch);
      if (revokedAttempt === 1) return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
      return new Response(JSON.stringify({ saved: batch.length, ignored: 0 }), { status: 201 });
    });
    const revokedStates: TrackingState[] = [];
    const stopRevoked = startTracking({
      routeId: 7,
      doc: docRevoked,
      geolocation: geoRevoked.geolocation,
      send: sendRevoked,
      onStateChange: (state) => revokedStates.push(state),
    });
    geoRevoked.emit(-26, -65, 10, base);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revokedSent).toHaveLength(1);
    geoRevoked.fail(1);
    expect(revokedStates.at(-1)).toBe("permission_denied");
    expect(geoRevoked.clearWatch).toHaveBeenCalledWith(1);
    // Next 30 s tick still retries the buffered batch even though watchPosition was cleared on permission denial.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revokedSent).toHaveLength(2);
    expect(revokedSent[1]).toEqual([{ lat: -26, lng: -65, accuracyMeters: 10, phoneTime: "2026-10-23T12:00:00.000Z" }]);
    // Buffer cleared after 201 → subsequent tick does not resend.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revokedSent).toHaveLength(2);
    stopRevoked();

    // Same defect class: hiding and returning to visible when watchPosition synchronously denies or throws still retries pending batch.
    const docHideDeny = fakeDoc("visible");
    let hideCalls = 0;
    const hideGeo: TrackingGeolocation = {
      watchPosition: vi.fn((success: PositionCallback, error?: PositionErrorCallback | null) => {
        hideCalls += 1;
        if (hideCalls === 1) {
          success({ coords: { latitude: -26.8, longitude: -65.2, accuracy: 12 } as GeolocationCoordinates, timestamp: base } as GeolocationPosition);
          return 1;
        }
        error?.({ code: 1 } as GeolocationPositionError);
        return 2;
      }),
      clearWatch: vi.fn(),
    };
    const hideSent: PositionSample[][] = [];
    const sendHide = vi.fn(async (_routeId: number, batch: PositionSample[]) => {
      hideSent.push(batch);
      if (hideSent.length === 1) return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ saved: batch.length, ignored: 0 }), { status: 201 });
    });
    const stopHide = startTracking({ routeId: 7, doc: docHideDeny, geolocation: hideGeo, send: sendHide, onStateChange: () => undefined });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hideSent).toHaveLength(1);
    docHideDeny.visibilityState = "hidden";
    docHideDeny.dispatchEvent(new Event("visibilitychange"));
    docHideDeny.visibilityState = "visible";
    docHideDeny.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hideSent).toHaveLength(2);
    stopHide();

    // A 401 resolving after stop() must not trigger onUnauthorized against an ended session.
    let resolveInFlight!: (response: Response) => void;
    const onUnauthorized = vi.fn();
    const slowSend = vi.fn(() => new Promise<Response>((resolve) => { resolveInFlight = resolve; }));
    const geoInFlight = fakeGeolocation();
    const stopInFlight = startTracking({
      routeId: 9, doc, geolocation: geoInFlight.geolocation, send: slowSend, onStateChange: () => undefined, onUnauthorized,
    });
    geoInFlight.emit(-26.83, -65.21, 10, base);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slowSend).toHaveBeenCalledTimes(1);
    stopInFlight();
    resolveInFlight(new Response(null, { status: 401 }));
    await Promise.resolve();
    expect(onUnauthorized).not.toHaveBeenCalled();

    // Verify sendPositions posts to the expected driver endpoint with credentials.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: 1, ignored: 0 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload: PositionSample[] = [{ lat: -26.83, lng: -65.21, accuracyMeters: 10, phoneTime: "2026-10-23T12:00:00.000Z" }];
    await sendPositions("https://api.example", 9, payload);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/positions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions: payload }),
    });
  });

  it("shows location permission notice when permission is denied or geolocation is missing, and never blocks saving Marks", async () => {
    const doc = fakeDoc("visible");
    const states: TrackingState[] = [];
    const send = vi.fn(async () => { throw new Error("tracking broken"); });

    // Missing Geolocation → permission_denied state.
    const stopMissing = startTracking({ routeId: 9, doc, geolocation: undefined, send, onStateChange: (state) => states.push(state) });
    expect(states.at(-1)).toBe("permission_denied");
    stopMissing();

    // Permission denied (code 1) → permission_denied state and watch cleared.
    const geo = fakeGeolocation();
    const stopDenied = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: (state) => states.push(state) });
    geo.fail(1);
    expect(states.at(-1)).toBe("permission_denied");
    expect(geo.clearWatch).toHaveBeenCalledWith(1);
    stopDenied();

    // GPS unavailable (code 2) → gps_unavailable state; malformed coordinates stay gps_unavailable, valid reading recovers to active.
    const geo2 = fakeGeolocation();
    const stopGps = startTracking({ routeId: 9, doc, geolocation: geo2.geolocation, send, onStateChange: (state) => states.push(state) });
    geo2.fail(2);
    expect(states.at(-1)).toBe("gps_unavailable");
    geo2.emit(Number.NaN, -65.21, 15, Date.parse("2026-10-23T12:00:00.000Z"));
    expect(states.at(-1)).toBe("gps_unavailable");
    geo2.emit(-26.83, -65.21, 15, Date.parse("2026-10-23T12:00:01.000Z"));
    expect(states.at(-1)).toBe("active");
    stopGps();

    // UI shows exact active and permission/GPS notices while leaving Subió, Ausente and Entregado enabled (not disabled).
    const dropoffStop: DriverStop = {
      position: 2,
      kind: "dropoff",
      plannedTime: "08:30",
      transferId: 4,
      direction: "entrada",
      transferStatus: "subio",
      place: { name: "Escuela Sintética", destinationId: 7, address: "Avenida Sintetica 303", accessNotes: null },
      passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null },
      companions: 0,
    };
    const activeRoute: DriverRoute = { ...sampleRoute("en_curso"), stops: [stop, dropoffStop] };

    const activeHtml = renderToStaticMarkup(
      <RouteView route={activeRoute} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking="active" />,
    );
    expect(activeHtml).toContain(`<p role="status">${TRACKING_ACTIVE_TEXT}</p>`);

    const deniedHtml = renderToStaticMarkup(
      <RouteView route={activeRoute} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking="permission_denied" />,
    );
    expect(deniedHtml).toContain(`<p role="alert">${LOCATION_PERMISSION_NOTICE}</p>`);
    expect(deniedHtml).toContain('<button type="button">Subió</button>');
    expect(deniedHtml).toContain('<button type="button">Ausente</button>');
    expect(deniedHtml).toContain('<button type="button">Entregado at Escuela Sintética</button>');

    const gpsHtml = renderToStaticMarkup(
      <RouteView route={activeRoute} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking="gps_unavailable" />,
    );
    expect(gpsHtml).toContain(`<p role="alert">${GPS_UNAVAILABLE_NOTICE}</p>`);
    expect(gpsHtml).toContain('<button type="button">Subió</button>');
    expect(gpsHtml).toContain('<button type="button">Ausente</button>');
    expect(gpsHtml).toContain('<button type="button">Entregado at Escuela Sintética</button>');

    // Mounted DriverHome integration: with Seguimiento failing (permission denied, throwing watchPosition, missing geolocation,
    // and failing POST /positions), clicking Subió, Ausente and Entregado through the real app saves and sends every Marca.
    const secondPickup: DriverStop = {
      position: 2,
      kind: "pickup",
      plannedTime: "08:10",
      transferId: 5,
      direction: "entrada",
      transferStatus: "planificado",
      place: { name: null, destinationId: null, address: "Calle Inventada 202", accessNotes: null },
      passenger: { name: "Pasajero Dos", wheelchair: false, medicalAlert: null },
      companions: 0,
    };
    const dropoffStop3: DriverStop = { ...dropoffStop, position: 3 };
    const integratedRoute = (status: string, statuses: Record<number, string>): DriverRoute => ({
      ...sampleRoute(status, 9),
      stops: [stop, secondPickup, dropoffStop3].map((item) => ({
        ...item,
        transferStatus: statuses[item.transferId] ?? item.transferStatus,
      })),
    });
    const daysResponse = (status: string, statuses: Record<number, string>) => (url: string) => {
      if (url.endsWith("/driver/days/2026-10-23")) {
        return new Response(JSON.stringify({ date: "2026-10-23", routes: [integratedRoute(status, statuses)] }), { status: 200 });
      }
      if (url.endsWith("/driver/days/2026-10-24")) {
        return new Response(JSON.stringify({ date: "2026-10-24", routes: [] }), { status: 200 });
      }
      return null;
    };

    const runMountedMarkFlow = async (mode: "denied" | "broken_watch_and_positions" | "missing_geo") => {
      const savedMarks: { routeId: number; kind: string; transferId: number; receiver?: unknown }[] = [];
      const transferStatuses: Record<number, string> = { 3: "planificado", 5: "planificado", 4: "subio" };
      let positionAttempts = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const day = daysResponse("en_curso", transferStatuses)(url);
        if (day) return day;
        if (url.endsWith("/auth/me")) {
          return new Response(JSON.stringify({ serverEpoch: "epoch-1" }), { status: 200 });
        }
        if (url.endsWith("/driver/routes/9/positions")) {
          positionAttempts += 1;
          throw new Error("positions endpoint unreachable");
        }
        if (url.endsWith("/driver/routes/9/marks")) {
          const payload = JSON.parse(String(init?.body ?? "{}")) as { id: string; kind: string; transferId: number; receiver?: unknown };
          savedMarks.push({ routeId: 9, kind: payload.kind, transferId: payload.transferId, receiver: payload.receiver });
          transferStatuses[payload.transferId] = payload.kind;
          return new Response(JSON.stringify({ mark: { id: payload.id, flags: [] } }), { status: 201 });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as unknown as typeof fetch;

      let geolocation: (TrackingGeolocation & Partial<Pick<Geolocation, "getCurrentPosition">>) | undefined;
      if (mode === "denied") {
        geolocation = {
          watchPosition: (_s, e) => { e?.({ code: 1 } as GeolocationPositionError); return 1; },
          clearWatch: vi.fn(),
          getCurrentPosition: (_s, e) => { e?.({ code: 1 } as GeolocationPositionError); },
        };
      } else if (mode === "broken_watch_and_positions") {
        geolocation = {
          watchPosition: () => { throw new Error("geolocation crashed"); },
          clearWatch: () => { throw new Error("clearWatch crashed"); },
          getCurrentPosition: (_s, e) => { e?.({ code: 2 } as GeolocationPositionError); },
        };
      } else {
        geolocation = undefined;
      }

      const app = await mountApp(<DriverHome apiUrl="https://api.example" userId={1} onSignedOut={vi.fn()} />, {
        geolocation,
        fetchImpl: fetchMock,
      });
      try {
        expect(app.container.textContent).toContain(LOCATION_PERMISSION_NOTICE);
        await app.click("Subió");
        await app.click("Ausente");
        await app.click("Entregado at Escuela Sintética");

        expect(savedMarks).toEqual([
          { routeId: 9, kind: "subio", transferId: 3, receiver: undefined },
          { routeId: 9, kind: "ausente", transferId: 5, receiver: undefined },
          { routeId: 9, kind: "entregado", transferId: 4, receiver: { kind: "destination", destinationId: 7 } },
        ]);
        expect(app.idb.stores.get("marks")?.size).toBe(3);
        expect(app.container.textContent).toContain("Marked: Subió");
        expect(app.container.textContent).toContain("Marked: Ausente");
        expect(app.container.textContent).toContain("Marked: Entregado");
        expect(positionAttempts).toBe(0);
      } finally {
        await app.unmount();
      }
    };

    await runMountedMarkFlow("denied");
    await runMountedMarkFlow("broken_watch_and_positions");
    await runMountedMarkFlow("missing_geo");

    // Also verify when watchPosition works and emits positions while POST /positions fails with 500, clicking Marks still works.
    const liveGeo = fakeGeolocation();
    const liveSaved: { kind: string; transferId: number }[] = [];
    const liveStatuses: Record<number, string> = { 3: "planificado", 5: "planificado", 4: "subio" };
    let livePositionFails = 0;
    let currentRouteStatus = "en_curso";
    const liveFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const day = daysResponse(currentRouteStatus, liveStatuses)(url);
      if (day) return day;
      if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ serverEpoch: "epoch-1" }), { status: 200 });
      if (url.endsWith("/driver/routes/9/positions")) {
        livePositionFails += 1;
        return new Response(JSON.stringify({ error: "tracking server down" }), { status: 500 });
      }
      if (url.endsWith("/driver/routes/9/marks")) {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { id: string; kind: string; transferId: number };
        liveSaved.push({ kind: payload.kind, transferId: payload.transferId });
        liveStatuses[payload.transferId] = payload.kind;
        return new Response(JSON.stringify({ mark: { id: payload.id, flags: [] } }), { status: 201 });
      }
      if (url.endsWith("/driver/routes/9/close")) {
        currentRouteStatus = "cerrado";
        return new Response(JSON.stringify({ status: "cerrado" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as unknown as typeof fetch;

    const liveApp = await mountApp(<DriverHome apiUrl="https://api.example" userId={1} onSignedOut={vi.fn()} />, {
      geolocation: {
        ...liveGeo.geolocation,
        getCurrentPosition: (_s, e) => { e?.({ code: 3 } as GeolocationPositionError); },
      },
      fetchImpl: liveFetch,
    });
    try {
      expect(liveGeo.watchPosition).toHaveBeenCalledTimes(1);
      expect(liveApp.container.textContent).toContain(TRACKING_ACTIVE_TEXT);
      liveGeo.emit(-26.83, -65.21, 15, Date.parse("2026-10-23T12:00:00.000Z"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await liveApp.flushWork();
      expect(livePositionFails).toBe(1);

      await liveApp.click("Subió");
      await liveApp.click("Ausente");
      await liveApp.click("Entregado at Escuela Sintética");
      expect(liveSaved).toEqual([
        { kind: "subio", transferId: 3 },
        { kind: "ausente", transferId: 5 },
        { kind: "entregado", transferId: 4 },
      ]);
      expect(liveApp.idb.stores.get("marks")?.size).toBe(3);

      // Closing the Recorrido clears watchPosition and removes the active tracking indicator in the mounted app.
      await liveApp.click("Close Recorrido");
      expect(liveGeo.clearWatch).toHaveBeenCalledWith(1);
      expect(liveApp.container.textContent).not.toContain(TRACKING_ACTIVE_TEXT);
    } finally {
      await liveApp.unmount();
    }
  });

  it("preserves RouteView and DayView rendering with and without tracking", () => {
    const day: DriverDay = {
      date: "2026-10-23",
      routes: [sampleRoute("publicado", 8), sampleRoute("en_curso", 9)],
    };
    const withoutTracking = renderToStaticMarkup(
      <DayView title="Today" day={day} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} />,
    );
    expect(withoutTracking).toContain("<h2>Today (2026-10-23)</h2>");
    expect(withoutTracking).not.toContain(TRACKING_ACTIVE_TEXT);
    expect(withoutTracking).not.toContain(LOCATION_PERMISSION_NOTICE);

    const withTracking = renderToStaticMarkup(
      <DayView title="Today" day={day} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking={{ routeId: 9, state: "active" }} />,
    );
    expect(withTracking.match(new RegExp(TRACKING_ACTIVE_TEXT, "g"))).toHaveLength(1);
  });

  it("preserves DriverHome initial render with Seguimiento wired", () => {
    vi.stubGlobal("indexedDB", { open: vi.fn() });
    const html = renderToStaticMarkup(
      <DriverHome apiUrl="https://api.example" userId={1} onSignedOut={() => undefined} />,
    );
    expect(html).toContain("Cerrar sesión");
    expect(html).toContain("Loading your Recorridos...");
  });
});
