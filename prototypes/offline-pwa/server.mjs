// Throwaway prototype for issue #40: serves the prototype PWA, receives its fake marks and sends test pushes.
// State lives in memory and is lost when the container restarts. Nothing here is used by the real apps.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/queue.mjs': ['queue.mjs', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const MAX_BODY = 4096;
const MAX_MARKS = 10000;
const MAX_SUBSCRIPTIONS = 100;

/** Only the browsers' push services, so a client cannot make the server post to the staging network. */
function knownPushService(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** A VAPID key pair made at start; a restart needs a new subscription on each phone. */
function vapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { privateKey, publicKey: raw.toString('base64url') };
}

/** The Authorization header of a push without payload (RFC 8292). */
function vapidAuthorization(keys, endpoint, subject, now) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${unsigned}.${signature}, k=${keys.publicKey}`;
}

function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** The JSON body, or undefined when it is too large, invalid or the phone cut the request (as when signal drops). */
async function readJson(request) {
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) return undefined;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createPrototypeServer({
  root = dirname(fileURLToPath(import.meta.url)),
  allowEndpoint = knownPushService,
  schedule = (run, ms) => setTimeout(run, ms),
  now = () => Date.now(),
  subject = process.env.VAPID_SUBJECT || 'mailto:offline-prototype@example.com',
} = {}) {
  const marks = new Map();
  const subscriptions = new Map();
  const pushResults = new Map();
  const keys = vapidKeys();

  const sendPush = async (device) => {
    const endpoint = subscriptions.get(device)?.endpoint;
    if (!endpoint) return;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { TTL: '300', Urgency: 'high', Authorization: vapidAuthorization(keys, endpoint, subject, now) },
      });
      pushResults.set(device, { status: response.status, body: (await response.text()).slice(0, 200), at: new Date(now()).toISOString() });
    } catch (error) {
      pushResults.set(device, { status: 0, body: String(error.message).slice(0, 200), at: new Date(now()).toISOString() });
    }
  };

  const handle = async (request, response) => {
    const reply = (status, body) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url, 'http://prototype.invalid');
    const route = `${request.method} ${url.pathname}`;
    const device = url.searchParams.get('device');

    if (request.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(await readFile(join(root, file)));
      return;
    }
    if (route === 'POST /marks') {
      const mark = await readJson(request);
      if (!mark || !text(mark.id, 100) || !text(mark.device, 60) || !text(mark.createdAt, 40)) return reply(400, { error: 'Invalid mark' });
      const known = marks.get(mark.id);
      if (known) {
        known.receipts += 1;
        return reply(200, { status: 'duplicate' });
      }
      if (marks.size >= MAX_MARKS) return reply(507, { error: 'Prototype mark limit reached' });
      marks.set(mark.id, { id: mark.id, device: mark.device, createdAt: mark.createdAt, receivedAt: new Date(now()).toISOString(), receipts: 1 });
      return reply(201, { status: 'stored' });
    }
    if (route === 'GET /marks') {
      const mine = [...marks.values()].filter((mark) => mark.device === device);
      return reply(200, { marks: mine, duplicates: mine.reduce((sum, mark) => sum + mark.receipts - 1, 0) });
    }
    if (route === 'GET /push/key') return reply(200, { publicKey: keys.publicKey });
    if (route === 'POST /push/subscriptions') {
      const body = await readJson(request);
      if (!body || !text(body.device, 60) || !text(body.subscription?.endpoint, 1000) || !allowEndpoint(body.subscription.endpoint)) {
        return reply(400, { error: 'Invalid subscription' });
      }
      if (!subscriptions.has(body.device) && subscriptions.size >= MAX_SUBSCRIPTIONS) return reply(507, { error: 'Prototype subscription limit reached' });
      subscriptions.set(body.device, { endpoint: body.subscription.endpoint });
      return reply(201, { status: 'subscribed' });
    }
    if (route === 'POST /push/test') {
      const body = await readJson(request);
      const delay = body?.delaySeconds;
      if (!body || !text(body.device, 60) || !Number.isInteger(delay) || delay < 0 || delay > 300) return reply(400, { error: 'Invalid push test' });
      if (!subscriptions.has(body.device)) return reply(404, { error: 'No subscription for this device' });
      schedule(() => sendPush(body.device), delay * 1000);
      return reply(202, { status: 'scheduled' });
    }
    if (route === 'GET /push/status') {
      return reply(200, { subscribed: subscriptions.has(device), lastResult: pushResults.get(device) ?? null });
    }
    reply(404, { error: 'Not found' });
  };
  // Any failure answers 500 or drops the connection; it never stops the server.
  return createServer((request, response) => handle(request, response).catch(() => {
    if (response.headersSent) response.destroy();
    else response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Prototype server error' }));
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  createPrototypeServer().listen(port, '0.0.0.0', () => console.log(`offline prototype listening on ${port}`));
}
