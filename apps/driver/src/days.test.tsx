import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeVersion, DriverHome, driverDays, isIosDevice, isStandalonePwa, registerPushSubscription, RouteView, startRefetching, StopView, urlBase64ToUint8Array, visibleDays, type DriverRoute, type DriverStop } from "./Days";

// Synthetic data only.
const passenger = { name: "Pasajero Sintético", wheelchair: true, medicalAlert: "Alergia sintética a la penicilina" };
const pickup: DriverStop = {
  position: 1, kind: "pickup", plannedTime: "07:51", transferId: 3, direction: "entrada", transferStatus: "planificado",
  place: { name: null, destinationId: null, address: "Calle Inventada 101", accessNotes: "Timbre del fondo" }, passenger, companions: 1,
};
const dropoff: DriverStop = {
  position: 2, kind: "dropoff", plannedTime: "08:00", transferId: 3, direction: "entrada", transferStatus: "planificado",
  place: { name: "Escuela Sintética", destinationId: 4, address: "Avenida Sintetica 303", accessNotes: null },
  passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null }, companions: 0,
};
const route = (version: number, acknowledgedVersion: number | null): DriverRoute => ({
  routeId: 9, version, startTime: "07:00", endTime: "09:00", vehiclePlate: "AAA001", status: "publicado", acknowledgedVersion, stops: [pickup],
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

class MiniNode {
  nodeType: number;
  nodeName: string;
  ownerDocument: MiniDocument | null;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get parentElement(): MiniElement | null { return this.parentNode instanceof MiniElement ? this.parentNode : null; }
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniNode | null { return this.childNodes.at(-1) ?? null; }
  get previousSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const idx = siblings.indexOf(this);
    return idx > 0 ? siblings[idx - 1] : null;
  }
  get nextSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const idx = siblings.indexOf(this);
    return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  }

  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(idx, 0, child);
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  contains(target: MiniNode | null): boolean {
    for (let cur: MiniNode | null = target; cur; cur = cur.parentNode) {
      if (cur === this) return true;
    }
    return false;
  }

  addEventListener(type: string, fn: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    if (!list.includes(fn)) {
      list.push(fn);
      this.listeners.set(type, list);
    }
  }

  removeEventListener(type: string, fn: (event: unknown) => void) {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((entry) => entry !== fn));
  }

  dispatchEvent(event: Event): boolean {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
    return true;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(value));
  }
}

class MiniText extends MiniNode {
  private value: string;
  constructor(data: string, ownerDocument: MiniDocument) {
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

class MiniComment extends MiniNode {
  data: string;
  constructor(data: string, ownerDocument: MiniDocument) {
    super(8, "#comment", ownerDocument);
    this.data = data;
  }
  override get textContent() { return ""; }
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  disabled = false;
  type = "";

  constructor(tag: string, ownerDocument: MiniDocument) {
    super(1, tag.toUpperCase(), ownerDocument);
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
    if (name === "disabled") this.disabled = true;
    if (name === "type") this.type = String(value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === "disabled") this.disabled = false;
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  focus() {}
  blur() {}

  findByTestId(testId: string): MiniElement | null {
    if (this.attrs.get("data-testid") === testId) return this;
    for (const child of this.childNodes) {
      if (child instanceof MiniElement) {
        const found = child.findByTestId(testId);
        if (found) return found;
      }
    }
    return null;
  }
}

class MiniDocument extends MiniNode {
  visibilityState: "visible" | "hidden" = "visible";
  defaultView: MiniWindow;
  documentElement: MiniElement;
  head: MiniElement;
  body: MiniElement;
  activeElement: MiniElement | null = null;

  constructor(win: MiniWindow) {
    super(9, "#document", null);
    this.defaultView = win;
    this.documentElement = new MiniElement("html", this);
    this.head = new MiniElement("head", this);
    this.body = new MiniElement("body", this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string) { return new MiniElement(tag, this); }
  createElementNS(_ns: string, tag: string) { return new MiniElement(tag, this); }
  createTextNode(text: string) { return new MiniText(String(text), this); }
  createComment(text: string) { return new MiniComment(String(text), this); }
  getElementById(id: string): MiniElement | null {
    const walk = (node: MiniNode): MiniElement | null => {
      if (node instanceof MiniElement && node.attrs.get("id") === id) return node;
      for (const child of node.childNodes) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.body);
  }
}

class MiniWindow extends EventTarget {
  document!: MiniDocument;
  navigator: Record<string, unknown> = {};
  location = { search: "" };
  matchMedia: (query: string) => { matches: boolean };
  Node = MiniNode;
  Element = MiniElement;
  HTMLElement = MiniElement;
  HTMLIFrameElement = class {};
  Event = Event;
  MouseEvent = Event;

  constructor(standalone: boolean) {
    super();
    this.matchMedia = (query: string) => ({ matches: standalone && query === "(display-mode: standalone)" });
  }
}

function fakeIndexedDbFactory(): IDBFactory {
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
      const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; error: unknown; objectStore: (name: string) => Record<string, unknown> } = {
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
            delete: (key: string) => { data.delete(key); return req(undefined); },
            clear: () => { data.clear(); return req(undefined); },
          };
        },
      };
      queueMicrotask(() => { queueMicrotask(() => tx.oncomplete?.()); });
      return tx;
    },
  };
  return {
    open() {
      const request: { result: typeof db; error: unknown; onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
        result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
}

async function mountDriverHome(element: ReactElement, options: {
  standalone: boolean;
  fetchImpl: typeof fetch;
}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const win = new MiniWindow(options.standalone);
  const doc = new MiniDocument(win);
  win.document = doc;
  const iosNavigator = {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5,
    standalone: options.standalone,
    storage: undefined,
    geolocation: undefined,
  };
  win.navigator = iosNavigator;
  const container = doc.createElement("div");
  doc.body.appendChild(container);

  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", iosNavigator);
  vi.stubGlobal("indexedDB", fakeIndexedDbFactory());
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

  return {
    container,
    doc,
    win,
    flushWork,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe("driver Recorridos", () => {
  it("shows every Parada's address, access notes, Pasajero, Acompañantes, wheelchair and medical alert", () => {
    expect(renderToStaticMarkup(<StopView stop={pickup} />)).toBe(
      "<strong>07:51 Pick up Pasajero Sintético</strong><div>Home: Calle Inventada 101</div><div>Access: Timbre del fondo</div>"
      + "<div>Companions: 1</div><div>Wheelchair</div><div role=\"alert\">Medical alert: Alergia sintética a la penicilina</div>",
    );
    expect(renderToStaticMarkup(<StopView stop={dropoff} />)).toBe(
      "<strong>08:00 Drop off Pasajero Sintético</strong><div>Escuela Sintética: Avenida Sintetica 303</div><div>Companions: 0</div>",
    );
  });

  it("re-fetches when the app opens, gets focus or becomes visible", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const refetch = vi.fn();
    const stop = startRefetching(win, doc, refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("focus"));
    expect(refetch).toHaveBeenCalledTimes(2);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refetch).toHaveBeenCalledTimes(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refetch).toHaveBeenCalledTimes(3);
    stop();
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("asks for today and tomorrow in the Plan diario's zone", () => {
    expect(driverDays(new Date("2026-10-23T12:00:00.000Z"))).toEqual(["2026-10-23", "2026-10-24"]);
    expect(driverDays(new Date("2026-10-24T02:30:00.000Z"))).toEqual(["2026-10-23", "2026-10-24"]);
  });

  it("opens the plan saved on the phone for today and tomorrow, so last evening's download is today's plan", () => {
    const day = (date: string) => ({ date, routes: [route(1, null)] });
    // Downloaded on the evening of the 22nd, opened at 06:30 of the 23rd without signal.
    expect(visibleDays([day("2026-10-22"), day("2026-10-23")], new Date("2026-10-23T09:30:00.000Z"))).toEqual([day("2026-10-23")]);
    expect(visibleDays([day("2026-10-23"), day("2026-10-24")], new Date("2026-10-23T09:30:00.000Z"))).toEqual([day("2026-10-23"), day("2026-10-24")]);
    expect(visibleDays([day("2026-10-21"), day("2026-10-22")], new Date("2026-10-23T09:30:00.000Z"))).toEqual([]);
  });
});

describe("Confirmación de versión in the driver app", () => {
  it("offers to acknowledge the version shown and says when it was already acknowledged", () => {
    expect(renderToStaticMarkup(<RouteView route={route(1, null)} sending={false} onAcknowledge={() => undefined} />))
      .toContain("<h3>07:00-09:00, AAA001, version 1</h3><button type=\"button\">Acknowledge version 1</button>");
    expect(renderToStaticMarkup(<RouteView route={route(2, 1)} sending={false} onAcknowledge={() => undefined} />))
      .toContain("<p role=\"alert\">The plan changed since you acknowledged version 1.</p><button type=\"button\">Acknowledge version 2</button>");
    expect(renderToStaticMarkup(<RouteView route={route(2, 2)} sending={false} onAcknowledge={() => undefined} />))
      .toContain("<p>You acknowledged version 2.</p><ol>");
  });

  it("shows what changed since the version the Chofer acknowledged", () => {
    const changed: DriverRoute = {
      ...route(2, 1),
      changes: {
        sinceVersion: 1,
        items: [
          { kind: "vehicle", from: "AAA001", to: "BBB002" },
          { kind: "added", transferId: 5, passengerName: "Pasajero Nuevo" },
          { kind: "removed", transferId: 6, passengerName: "Pasajero Ausente" },
          { kind: "time", transferId: 3, stopKind: "pickup", passengerName: "Pasajero Sintético", from: "07:51", to: "07:58" },
        ],
      },
    };
    expect(renderToStaticMarkup(<RouteView route={changed} sending={false} onAcknowledge={() => undefined} />)).toContain(
      "<section><p>Changes since version 1:</p><ul><li>Vehicle: AAA001 → BBB002</li><li>New: Pasajero Nuevo</li>"
      + "<li>Removed: Pasajero Ausente</li><li>Pick up Pasajero Sintético: 07:51 → 07:58</li></ul></section>",
    );
    expect(renderToStaticMarkup(<RouteView route={{ ...changed, changes: { sinceVersion: 1, items: [] } }} sending={false} onAcknowledge={() => undefined} />))
      .not.toContain("Changes since");
  });

  it("sends the version the Chofer saw, not the latest one", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await acknowledgeVersion("https://api.example", 9, 1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/acknowledgements", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1 }),
    });
  });

  it("identifies iOS devices and standalone PWA mode", () => {
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } as any)).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" } as any)).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 } as any)).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l", maxTouchPoints: 5 } as any)).toBe(false);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } as any)).toBe(false);

    expect(isStandalonePwa({ matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" }) } as any)).toBe(true);
    expect(isStandalonePwa({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } } as any)).toBe(true);
    expect(isStandalonePwa({ matchMedia: () => ({ matches: false }), navigator: { standalone: false } } as any)).toBe(false);
  });

  it("renders iPhone installation instructions on uninstalled iOS Safari while keeping in-app plan updates active", async () => {
    const [today, tomorrow] = driverDays();
    let currentRoute: DriverRoute = { ...route(1, null), vehiclePlate: "AAA001" };
    let todayFetches = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://api.example/driver/days/${today}`) {
        todayFetches += 1;
        return new Response(JSON.stringify({ date: today, routes: [currentRoute] }), { status: 200 });
      }
      if (url === `https://api.example/driver/days/${tomorrow}`) {
        return new Response(JSON.stringify({ date: tomorrow, routes: [] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const mounted = await mountDriverHome(
      <DriverHome apiUrl="https://api.example" userId={1} onSignedOut={() => undefined} />,
      { standalone: false, fetchImpl: fetchMock },
    );

    try {
      // Regla 3: Displays instructions to add to home screen on uninstalled iOS Safari
      const instructions = mounted.container.findByTestId("ios-install-instructions");
      expect(instructions).not.toBeNull();
      expect(instructions?.textContent).toContain("Para recibir notificaciones en iPhone, agregá esta app a la pantalla de inicio");

      // Initial mount fetched version 1 of the plan
      expect(todayFetches).toBe(1);
      expect(mounted.container.textContent).toContain("07:00-09:00, AAA001, version 1");

      // Focus event on the mounted screen re-fetches and renders the updated version 2 plan
      currentRoute = { ...route(2, null), vehiclePlate: "BBB002" };
      await act(async () => {
        mounted.win.dispatchEvent(new Event("focus"));
      });
      await mounted.flushWork();
      expect(todayFetches).toBe(2);
      expect(mounted.container.textContent).toContain("07:00-09:00, BBB002, version 2");
      expect(mounted.container.findByTestId("ios-install-instructions")).not.toBeNull();

      // Hidden visibilitychange does not re-fetch; becoming visible again re-fetches version 3
      currentRoute = { ...route(3, null), vehiclePlate: "CCC003" };
      mounted.doc.visibilityState = "hidden";
      await act(async () => {
        mounted.doc.dispatchEvent(new Event("visibilitychange"));
      });
      await mounted.flushWork();
      expect(todayFetches).toBe(2);

      mounted.doc.visibilityState = "visible";
      await act(async () => {
        mounted.doc.dispatchEvent(new Event("visibilitychange"));
      });
      await mounted.flushWork();
      expect(todayFetches).toBe(3);
      expect(mounted.container.textContent).toContain("07:00-09:00, CCC003, version 3");
    } finally {
      await mounted.unmount();
    }

    // Standalone PWA mode hides installation instructions
    const standalone = await mountDriverHome(
      <DriverHome apiUrl="https://api.example" userId={1} onSignedOut={() => undefined} />,
      { standalone: true, fetchImpl: fetchMock },
    );
    try {
      expect(standalone.container.findByTestId("ios-install-instructions")).toBeNull();
    } finally {
      await standalone.unmount();
    }
  });

  it("assigns route anchor id to RouteView", () => {
    const html = renderToStaticMarkup(<RouteView route={route(1, null)} sending={false} onAcknowledge={() => undefined} />);
    expect(html).toContain('id="route-9"');
    expect(html).toContain('data-testid="route-9"');
  });

  it("registers push subscription with public key and sends it to the server", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://api.example/push/public-key") {
        return new Response(JSON.stringify({ publicKey: "BP_test_public_key" }), { status: 200 });
      }
      if (url === "https://api.example/push/subscriptions") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    let subscribedKey: any = null;
    const mockPushManager = {
      getSubscription: async () => null,
      subscribe: async (opts: any) => {
        subscribedKey = opts.applicationServerKey;
        return {
          toJSON: () => ({
            endpoint: "https://push.example.com/sub/1",
            keys: { p256dh: "key-p256dh", auth: "key-auth" },
          }),
        };
      },
    };
    const mockNavigator = {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: mockPushManager }),
      },
    };
    vi.stubGlobal("navigator", mockNavigator);
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted" });

    const registered = await registerPushSubscription("https://api.example");
    expect(registered).toBe(true);
    expect(subscribedKey).toBeInstanceOf(Uint8Array);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.example/push/public-key");
    expect(calls[1].url).toBe("https://api.example/push/subscriptions");
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      endpoint: "https://push.example.com/sub/1",
      keys: { p256dh: "key-p256dh", auth: "key-auth" },
    });
  });
});
