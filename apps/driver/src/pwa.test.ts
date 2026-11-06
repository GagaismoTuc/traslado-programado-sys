import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import manifestText from "../public/manifest.webmanifest?raw";
import { precacheList, serviceWorkerSource } from "./service-worker";

type Handler = (event: Record<string, unknown>) => void;

/** Runs sw.js against a fake worker scope and Cache Storage, at https://chofer.example. */
function runWorker(files: string[]) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, string>>([["driver-app-old", new Map([["/index.html", "old"]])]]);
  const notifications: Array<{ title: string; options: any }> = [];
  const openWindowCalls: string[] = [];
  let clientsList: any[] = [];

  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return {
        addAll: async (paths: string[]) => { for (const path of paths) store.set(path, `cached ${path}`); },
        match: async (path: string) => store.get(path),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { origin: "https://chofer.example" },
    addEventListener: (type: string, handler: Handler) => { handlers[type] = handler; },
    skipWaiting: async () => undefined,
    registration: {
      showNotification: async (title: string, options: any) => {
        notifications.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => clientsList,
      openWindow: async (url: string) => {
        openWindowCalls.push(url);
      },
    },
  };
  new Function("self", "caches", "fetch", serviceWorkerSource(files, "v1"))(self, caches, async () => "network");
  async function lifecycle(type: "install" | "activate") {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  async function request(url: string, method = "GET", mode = "cors") {
    let answer: Promise<unknown> | null = null;
    handlers.fetch({ request: { url, method, mode }, respondWith: (promise: Promise<unknown>) => { answer = promise; } });
    return answer === null ? "not handled" : await answer;
  }
  async function push(data?: any) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.push({
      data: data !== undefined ? { json: () => data } : undefined,
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    });
    await pending;
  }
  async function notificationClick(notificationData: any, options: { clients?: any[] } = {}) {
    let pending: Promise<unknown> = Promise.resolve();
    let closed = false;
    clientsList = options.clients ?? [];
    handlers.notificationclick({
      notification: {
        data: notificationData,
        close: () => { closed = true; },
      },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    });
    await pending;
    return { closed };
  }
  return { stores, lifecycle, request, push, notificationClick, notifications, openWindowCalls };
}

describe("driver app PWA shell", () => {
  it("is installable from a web manifest linked by the page", () => {
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({ short_name: "Chofer", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ]);
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("precaches only the app's own files and never answers for the API", async () => {
    const files = precacheList(["index.html", "assets/index-abc.js", "assets/index-def.css", "sw.js", "assets/index-abc.js.map"]);
    expect(files).toEqual([
      "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/assets/index-abc.js", "/assets/index-def.css",
    ]);
    const worker = runWorker(files);
    await worker.lifecycle("install");
    expect([...worker.stores.get("driver-app-v1")!.keys()]).toEqual(files);
    await worker.lifecycle("activate");
    expect([...worker.stores.keys()]).toEqual(["driver-app-v1"]);

    expect(await worker.request("https://chofer.example/assets/index-abc.js")).toBe("cached /assets/index-abc.js");
    expect(await worker.request("https://chofer.example/", "GET", "navigate")).toBe("cached /index.html");
    expect(await worker.request("https://api.example/driver/days/2026-10-23")).toBe("not handled");
    expect(await worker.request("https://chofer.example/driver/days/2026-10-23")).toBe("not handled");
    expect(await worker.request("https://chofer.example/assets/index-abc.js", "POST")).toBe("not handled");
  });

  it("handles push event by displaying a notification with route url", async () => {
    const worker = runWorker(precacheList([]));
    await worker.push({
      title: "Nueva versión del plan",
      body: "Se publicó la versión 2 de tu recorrido",
      routeId: 42,
      version: 2,
      url: "/?routeId=42",
    });
    expect(worker.notifications).toHaveLength(1);
    expect(worker.notifications[0]).toEqual({
      title: "Nueva versión del plan",
      options: {
        body: "Se publicó la versión 2 de tu recorrido",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: {
          url: "/?routeId=42",
          routeId: 42,
          version: 2,
        },
      },
    });
  });

  it("handles notificationclick by focusing/navigating client or opening window", async () => {
    const worker = runWorker(precacheList([]));
    // Case 1: no existing client -> opens window
    const clickResult1 = await worker.notificationClick({ url: "/?routeId=42", routeId: 42, version: 2 });
    expect(clickResult1.closed).toBe(true);
    expect(worker.openWindowCalls).toEqual(["/?routeId=42"]);

    // Case 2: existing window client -> navigates and focuses
    let focused = false;
    let navigatedTo = "";
    const mockClient = {
      navigate: (url: string) => { navigatedTo = url; },
      focus: async () => { focused = true; },
    };
    const clickResult2 = await worker.notificationClick(
      { url: "/?routeId=99", routeId: 99, version: 3 },
      { clients: [mockClient] },
    );
    expect(clickResult2.closed).toBe(true);
    expect(navigatedTo).toBe("/?routeId=99");
    expect(focused).toBe(true);
  });
});
