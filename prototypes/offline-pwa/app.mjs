// Throwaway prototype for issue #40: the page of the prototype PWA. Nothing here is used by the real apps.
import { httpSender, indexedDbStore, markQueue, newMark, startFlushing } from './queue.mjs';

const $ = (id) => document.getElementById(id);
const store = indexedDbStore();
const sendOptions = { dropNextAck: false };
const queue = markQueue(store, httpSender(fetch, 'marks', sendOptions));
const device = () => localStorage.getItem('offline-prototype-device') || '';

function list(element, items) {
  element.replaceChildren(...items.map((item) => Object.assign(document.createElement('li'), { textContent: item })));
}

async function renderQueue() {
  const marks = await store.all();
  $('pending').textContent = String(marks.length);
  list($('queue'), marks.map((mark) => `${mark.createdAt} ${mark.id.slice(0, 8)}`));
}

async function flush() {
  const result = await queue.flush();
  $('drop-ack').checked = sendOptions.dropNextAck;
  $('last-flush').textContent = `${new Date().toLocaleTimeString()}: sent ${result.sent}, pending ${result.pending}${result.error ? `, ${result.error}` : ''}`;
  await renderQueue();
  await refreshServer();
}

async function refreshServer() {
  try {
    const response = await fetch(`marks?device=${encodeURIComponent(device())}`, { cache: 'no-store' });
    const body = await response.json();
    $('received').textContent = String(body.marks.length);
    $('duplicates').textContent = String(body.duplicates);
    list($('server'), body.marks.map((mark) => `${mark.createdAt} ${mark.id.slice(0, 8)} received ${mark.receivedAt}, sent ${mark.receipts}×`));
  } catch {
    $('received').textContent = 'no signal';
  }
}

function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

async function postJson(path, body) {
  return await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function subscribe() {
  try {
    if (!('Notification' in window) || !('PushManager' in window)) throw new Error('This browser has no web push here (on iOS, open the app from the home screen)');
    if (await Notification.requestPermission() !== 'granted') throw new Error(`Notification permission: ${Notification.permission}`);
    const { publicKey } = await (await fetch('push/key')).json();
    const registration = await navigator.serviceWorker.ready;
    const old = await registration.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const response = await postJson('push/subscriptions', { device: device(), subscription });
    $('push-status').textContent = response.ok ? 'Subscribed.' : `Server refused the subscription (${response.status}).`;
  } catch (error) {
    $('push-status').textContent = error.message;
  }
}

async function pushTest() {
  const response = await postJson('push/test', { device: device(), delaySeconds: 30 }).catch(() => null);
  $('push-status').textContent = response?.status === 202 ? 'Push scheduled: close the app now; it arrives in about 30 s.' : `Push not scheduled (${response?.status ?? 'no signal'}).`;
}

async function pushStatus() {
  try {
    const body = await (await fetch(`push/status?device=${encodeURIComponent(device())}`, { cache: 'no-store' })).json();
    if (body.lastResult) $('push-status').textContent = `Last push: push service answered ${body.lastResult.status} at ${body.lastResult.at} ${body.lastResult.body}`;
  } catch {
    // Shown again on the next refresh.
  }
}

async function renderEnvironment() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  list($('environment'), [
    `Opened from the home screen: ${standalone ? 'yes' : 'no'}`,
    `Online: ${navigator.onLine ? 'yes' : 'no'}`,
    `Persistent storage: ${persisted === null || persisted === undefined ? 'unknown' : persisted ? 'granted' : 'not granted'}`,
    `Storage used: ${estimate ? `${Math.round(estimate.usage / 1024)} KB of ${Math.round(estimate.quota / 1048576)} MB` : 'unknown'}`,
    `Push available: ${'PushManager' in window ? 'yes' : 'no'}; notifications: ${'Notification' in window ? Notification.permission : 'unavailable'}`,
    `Browser: ${navigator.userAgent}`,
  ]);
}

$('device').value = device();
$('save-device').addEventListener('click', () => {
  localStorage.setItem('offline-prototype-device', $('device').value.trim());
  refreshServer();
});
$('add').addEventListener('click', async () => {
  if (!device()) { $('last-flush').textContent = 'Save a phone label first'; return; }
  await queue.add(newMark(device()));
  await flush();
});
$('flush').addEventListener('click', flush);
$('drop-ack').addEventListener('change', (event) => { sendOptions.dropNextAck = event.target.checked; });
$('refresh').addEventListener('click', async () => { await refreshServer(); await pushStatus(); await renderEnvironment(); });
$('subscribe').addEventListener('click', subscribe);
$('push-test').addEventListener('click', pushTest);
window.addEventListener('online', renderEnvironment);
window.addEventListener('offline', renderEnvironment);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
navigator.storage?.persist?.().catch(() => false).finally(renderEnvironment);
startFlushing(window, document, flush);
pushStatus();
