// Throwaway prototype for issue #40. Run with: node --test prototypes/offline-pwa/offline-pwa.test.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { httpSender, markQueue, newMark, startFlushing } from './queue.mjs';
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
