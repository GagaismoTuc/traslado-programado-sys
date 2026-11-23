// Throwaway prototype for issue #40. Run with: node --test prototypes/offline-pwa/offline-pwa.test.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { httpSender, indexedDbStore, markQueue, newMark, startFlushing } from './queue.mjs';
import { createPrototypeServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

/** A queue store in memory; the IndexedDB store is exercised on the real phones. */
function memoryStore() {
  const marks = new Map();
  return {
    all: async () => [...marks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    put: async (mark) => { marks.set(mark.id, mark); },
    remove: async (id) => { marks.delete(id); },
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('queues marks while sends fail and flushes them in order once the server answers', async () => {
  const store = memoryStore();
  let online = false;
  const sent = [];
  const queue = markQueue(store, async (mark) => {
    if (!online) throw new TypeError('Failed to fetch');
    sent.push(mark.id);
  });
  const first = newMark('Phone A', new Date('2026-11-06T10:00:00.000Z'), 'mark-1');
  const second = newMark('Phone A', new Date('2026-11-06T10:01:00.000Z'), 'mark-2');
  await queue.add(second);
  await queue.add(first);

  assert.deepEqual(await queue.flush(), { sent: 0, pending: 2, error: 'Failed to fetch' });
  assert.deepEqual((await store.all()).map((mark) => mark.id), ['mark-1', 'mark-2']);

  online = true;
  assert.deepEqual(await queue.flush(), { sent: 2, pending: 0, error: null });
  assert.deepEqual(sent, ['mark-1', 'mark-2']);
  assert.deepEqual(await store.all(), []);
});

test('flushes on start, when the connection returns and when the app becomes visible', () => {
  const listeners = { win: {}, doc: {} };
  const target = (bag) => ({ addEventListener: (type, listener) => { bag[type] = listener; } });
  const doc = { ...target(listeners.doc), visibilityState: 'hidden' };
  let flushes = 0;
  startFlushing(target(listeners.win), doc, () => { flushes += 1; });
  assert.equal(flushes, 1, 'flush on start');

  listeners.win.online();
  assert.equal(flushes, 2, 'flush when the connection returns');

  listeners.doc.visibilitychange();
  assert.equal(flushes, 2, 'no flush when the app is hidden');
  doc.visibilityState = 'visible';
  listeners.doc.visibilitychange();
  assert.equal(flushes, 3, 'flush when the app becomes visible');
});

test('a re-sent mark is stored once on the server', async (t) => {
  const server = createPrototypeServer({ root: here });
  const url = await listen(server);
  t.after(() => server.close());
  const store = memoryStore();
  const options = { dropNextAck: true };
  let posts = 0;
  const countingFetch = async (...args) => { posts += 1; return await fetch(...args); };
  const queue = markQueue(store, httpSender(countingFetch, `${url}/marks`, options));
  await queue.add(newMark('Phone B', new Date('2026-11-06T11:00:00.000Z'), 'mark-b1'));

  // The server stores the mark but the phone never sees the answer, as when signal drops mid-request.
  assert.deepEqual(await queue.flush(), { sent: 0, pending: 1, error: 'Acknowledgement dropped on purpose' });
  // Two flushes at once, as when "online" and "visibilitychange" fire together, send the mark once.
  const [a, b] = await Promise.all([queue.flush(), queue.flush()]);
  assert.deepEqual(a, { sent: 1, pending: 0, error: null });
  assert.deepEqual(b, a);
  assert.equal(posts, 2);

  const response = await fetch(`${url}/marks?device=${encodeURIComponent('Phone B')}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.marks.length, 1);
  assert.deepEqual({ id: body.marks[0].id, receipts: body.marks[0].receipts }, { id: 'mark-b1', receipts: 2 });
  assert.equal(body.duplicates, 1);
});

test('push test sends a VAPID-signed push to the device subscription after the delay', async (t) => {
  const received = [];
  const pushService = createServer((request, response) => {
    received.push({ path: request.url, headers: request.headers });
    response.writeHead(201).end();
  });
  const pushUrl = await listen(pushService);
  const scheduled = [];
  const server = createPrototypeServer({
    root: here,
    allowEndpoint: (endpoint) => endpoint.startsWith(pushUrl),
    schedule: (run, ms) => scheduled.push({ run, ms }),
  });
  const url = await listen(server);
  t.after(() => { server.close(); pushService.close(); });

  const { publicKey } = await (await fetch(`${url}/push/key`)).json();
  const subscription = { endpoint: `${pushUrl}/send/abc`, keys: { p256dh: 'x', auth: 'y' } };
  const post = async (path, body) => await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/push/subscriptions', { device: 'Phone C', subscription })).status, 201);
  assert.equal((await post('/push/subscriptions', { device: 'Phone D', subscription: { endpoint: 'http://api:3000/x' } })).status, 400);
  assert.equal((await post('/push/test', { device: 'Phone C', delaySeconds: 30 })).status, 202);
  assert.deepEqual(scheduled.map((entry) => entry.ms), [30000]);

  await scheduled[0].run();
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/send/abc');
  assert.equal(received[0].headers.ttl, '300');
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(received[0].headers.authorization);
  assert.equal(key, publicKey);
  const [header, claims, signature] = token.split('.');
  const point = Buffer.from(key, 'base64url');
  const jwk = { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') };
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, pushUrl);
  const status = await (await fetch(`${url}/push/status?device=${encodeURIComponent('Phone C')}`)).json();
  assert.equal(status.lastResult.status, 201);
});

test('the prototype stays out of the real apps', () => {
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
  const mentions = ['apps', 'packages'].flatMap((dir) => files(join(repo, dir)))
    .filter((path) => /\.(ts|tsx|js|mjs|json|html)$/.test(path))
    .filter((path) => /offline-pwa|offline-prototype/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(repo, path));
  assert.deepEqual(mentions, []);
  assert.doesNotMatch(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8'), /prototypes/);
  assert.doesNotMatch(readFileSync(join(repo, 'Dockerfile'), 'utf8'), /prototypes/);
});

test('the protocol covers every required check on at least one Chofer\'s iPhone', () => {
  const protocol = readFileSync(join(here, 'PROTOCOL.md'), 'utf8');
  for (const check of ['Pérdida de señal', 'App cerrada', 'Teléfono reiniciado', 'Reenvío sin duplicados', 'Instalación en la pantalla de inicio de iOS', 'Desalojo del almacenamiento en iOS', 'Push']) {
    assert.match(protocol, new RegExp(`^## \\d+\\. ${check}`, 'm'), `missing check: ${check}`);
  }
  assert.match(protocol, /^\| 1 \| iPhone de un Chofer \|/m, 'the first tested phone must be a Chofer\'s iPhone');
});

test('a request cut mid-body does not stop the server', async (t) => {
  const server = createPrototypeServer({ root: here });
  const url = await listen(server);
  t.after(() => server.close());
  const { port } = new URL(url);
  const socket = connect(Number(port), '127.0.0.1');
  await once(socket, 'connect');
  socket.write('POST /marks HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"id":"cut');
  await new Promise((done) => setTimeout(done, 50));
  socket.destroy();
  await new Promise((done) => setTimeout(done, 100));
  assert.equal((await fetch(`${url}/marks?device=x`)).status, 200);
});

test('serves an installable shell that opens without signal', async (t) => {
  const server = createPrototypeServer({ root: here });
  const url = await listen(server);
  t.after(() => server.close());
  const types = {
    '/': 'text/html; charset=utf-8', '/app.mjs': 'text/javascript; charset=utf-8', '/queue.mjs': 'text/javascript; charset=utf-8',
    '/sw.js': 'text/javascript; charset=utf-8', '/manifest.webmanifest': 'application/manifest+json', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png',
  };
  for (const [path, type] of Object.entries(types)) {
    const response = await fetch(`${url}${path}`);
    assert.equal(`${path} ${response.status} ${response.headers.get('content-type')}`, `${path} 200 ${type}`);
  }
  const manifest = await (await fetch(`${url}/manifest.webmanifest`)).json();
  assert.deepEqual({ start: manifest.start_url, scope: manifest.scope, display: manifest.display, sizes: manifest.icons.map((icon) => icon.sizes) },
    { start: './', scope: './', display: 'standalone', sizes: ['192x192', '512x512'] });
  const html = await (await fetch(`${url}/`)).text();
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="icon-192.png" \/>/);
  assert.match(await (await fetch(`${url}/app.mjs`)).text(), /navigator\.serviceWorker\.register\('sw\.js'\)/);
  const sw = await (await fetch(`${url}/sw.js`)).text();
  assert.match(sw, /const SHELL = \['\.\/', 'index\.html', 'app\.mjs', 'queue\.mjs', 'manifest\.webmanifest', 'icon-192\.png', 'icon-512\.png'\];/);
  assert.match(sw, /caches\.match\(event\.request\.mode === 'navigate' \? 'index\.html' : event\.request\)/);
});

test('a mark added while a flush runs is sent by that flush', async () => {
  const store = memoryStore();
  const sent = [];
  let release;
  const gate = new Promise((done) => { release = done; });
  const queue = markQueue(store, async (mark) => { if (mark.id === 'mark-1') await gate; sent.push(mark.id); });
  await queue.add(newMark('Phone E', new Date('2026-11-06T12:00:00.000Z'), 'mark-1'));
  const running = queue.flush();
  await queue.add(newMark('Phone E', new Date('2026-11-06T12:01:00.000Z'), 'mark-2'));
  release();
  assert.deepEqual(await running, { sent: 2, pending: 0, error: null });
  assert.deepEqual(sent, ['mark-1', 'mark-2']);
});

test('indexedDbStore reopens when WebKit closes an idle DB connection (db.onclose)', async () => {
  let openCount = 0;
  const rows = new Map();
  let lastDb = null;
  const fakeFactory = {
    open() {
      openCount += 1;
      let closed = false;
      const db = {
        createObjectStore() {},
        close() { closed = true; db.onclose?.(); },
        transaction() {
          if (closed) throw new DOMException('The database connection is closing', 'InvalidStateError');
          const tx = {
            objectStore() {
              return {
                getAll() { const r = { result: [...rows.values()] }; queueMicrotask(() => tx.oncomplete?.()); return r; },
                put(v) { rows.set(v.id, v); const r = { result: v.id }; queueMicrotask(() => tx.oncomplete?.()); return r; },
                delete(id) { rows.delete(id); const r = { result: undefined }; queueMicrotask(() => tx.oncomplete?.()); return r; },
              };
            },
          };
          return tx;
        },
      };
      lastDb = db;
      const req = { result: db };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
  const store = indexedDbStore(fakeFactory);
  await store.put(newMark('iPhone 1', new Date('2026-11-23T10:00:00Z'), 'm1'));
  lastDb.close();
  await store.put(newMark('iPhone 1', new Date('2026-11-23T10:01:00Z'), 'm2'));
  assert.equal(openCount, 2);
  assert.equal((await store.all()).length, 2);
});

test('indexedDbStore retries opening on the next call after a failed open (request.onerror)', async () => {
  let openCount = 0;
  const rows = new Map();
  const fakeFactory = {
    open() {
      openCount += 1;
      const failing = openCount === 1;
      const db = {
        createObjectStore() {},
        transaction() {
          const tx = {
            objectStore() {
              return {
                getAll() { const r = { result: [...rows.values()] }; queueMicrotask(() => tx.oncomplete?.()); return r; },
                put(v) { rows.set(v.id, v); const r = { result: v.id }; queueMicrotask(() => tx.oncomplete?.()); return r; },
              };
            },
          };
          return tx;
        },
      };
      const req = failing ? { result: undefined, error: new DOMException('Open blocked', 'UnknownError') } : { result: db };
      queueMicrotask(() => { if (failing) req.onerror?.(); else { req.onupgradeneeded?.(); req.onsuccess?.(); } });
      return req;
    },
  };
  const store = indexedDbStore(fakeFactory);
  await assert.rejects(store.put(newMark('iPhone 1', new Date('2026-11-23T10:00:00Z'), 'm1')), { name: 'UnknownError' });
  await store.put(newMark('iPhone 1', new Date('2026-11-23T10:01:00Z'), 'm2'));
  assert.equal(openCount, 2);
  assert.deepEqual((await store.all()).map((mark) => mark.id), ['m2']);
});

test('online flush triggered while an offline send is still in flight retries once it settles', async () => {
  const rows = new Map();
  const store = {
    all: async () => [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    put: async (m) => { rows.set(m.id, m); },
    remove: async (id) => { rows.delete(id); },
  };
  let online = false;
  let releaseOfflineFetch;
  let inFlight;
  const started = new Promise((r) => { inFlight = r; });
  const offlineGate = new Promise((r) => { releaseOfflineFetch = r; });
  const sent = [];
  const queue = markQueue(store, async (m) => {
    if (!online) {
      inFlight();
      await offlineGate;
      throw new TypeError('Failed to fetch');
    }
    sent.push(m.id);
  });
  await queue.add(newMark('iPhone 1', new Date('2026-11-23T10:00:00Z'), 'm1'));
  const first = queue.flush();
  await started;
  online = true;
  const second = queue.flush();
  releaseOfflineFetch();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ['m1']);
  assert.deepEqual(await store.all(), []);
});

test('triggers arriving while a failing flush runs coalesce into one extra pass, and a failing pass alone does not loop', async () => {
  const store = memoryStore();
  let attempts = 0;
  let release;
  const gate = new Promise((done) => { release = done; });
  const queue = markQueue(store, async () => {
    attempts += 1;
    if (attempts === 1) await gate;
    throw new TypeError('Failed to fetch');
  });
  await queue.add(newMark('Phone F', new Date('2026-11-23T11:00:00.000Z'), 'mark-1'));
  const first = queue.flush();
  const second = queue.flush();
  const third = queue.flush();
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(attempts, 2, 'one pass plus one extra pass for the coalesced triggers');
  for (const result of results) assert.deepEqual(result, { sent: 0, pending: 1, error: 'Failed to fetch' });

  assert.deepEqual(await queue.flush(), { sent: 0, pending: 1, error: 'Failed to fetch' });
  assert.equal(attempts, 3, 'a failing flush with no new trigger makes a single pass');
});

test('a flush triggered in any microtask right after the last pass ends is never dropped', async () => {
  for (let tick = 0; tick < 30; tick += 1) {
    const rows = new Map();
    let armed = false;
    let late = null;
    const store = {
      all: async () => {
        const marks = [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (armed && marks.length === 0) {
          armed = false;
          const step = (n) => {
            if (n < tick) { queueMicrotask(() => step(n + 1)); return; }
            const mark = newMark('Phone G', new Date('2026-11-23T12:01:00.000Z'), 'mark-late');
            rows.set(mark.id, mark);
            late = queue.flush();
          };
          queueMicrotask(() => step(0));
        }
        return marks;
      },
      put: async (mark) => { rows.set(mark.id, mark); },
      remove: async (id) => { rows.delete(id); },
    };
    let fired = false;
    const queue = markQueue(store, async () => { if (!fired) { fired = true; armed = true; } });
    await queue.add(newMark('Phone G', new Date('2026-11-23T12:00:00.000Z'), 'mark-1'));
    await queue.flush();
    while (late === null) await new Promise((done) => setImmediate(done));
    await late;
    assert.deepEqual([...rows.keys()], [], `flush triggered ${tick} microtasks after the last read was dropped`);
  }
});
