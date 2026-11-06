// Throwaway prototype for issue #40: an offline queue of fake marks. Nothing here is used by the real apps.

/** A random id made on the phone, so a re-sent mark is recognised by the server. */
export function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A fake mark: the device label and when it was made, nothing about a real Pasajero. */
export function newMark(device, now = new Date(), id = randomId()) {
  return { id, device, createdAt: now.toISOString() };
}

/** The queue in IndexedDB, in its own database so it never touches the driver app's data. */
export function indexedDbStore(factory = globalThis.indexedDB) {
  const opened = new Promise((resolve, reject) => {
    const request = factory.open('offline-prototype', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('marks', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, action) => {
    const db = await opened;
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('marks', mode);
      const request = action(transaction.objectStore('marks'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    all: async () => (await run('readonly', (marks) => marks.getAll())).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    put: async (mark) => { await run('readwrite', (marks) => marks.put(mark)); },
    remove: async (id) => { await run('readwrite', (marks) => marks.delete(id)); },
  };
}

/**
 * Marks are saved first and sent oldest first. A mark leaves the queue only after the server acknowledged it, so a
 * lost answer re-sends it and the server keeps one copy. A flush already running is shared, never doubled, and also
 * sends the marks added while it runs.
 */
export function markQueue(store, send) {
  let running = null;
  const drain = async () => {
    let sent = 0;
    for (let mark = (await store.all())[0]; mark; mark = (await store.all())[0]) {
      try {
        await send(mark);
      } catch (error) {
        return { sent, pending: (await store.all()).length, error: error.message };
      }
      await store.remove(mark.id);
      sent += 1;
    }
    return { sent, pending: (await store.all()).length, error: null };
  };
  return {
    add: async (mark) => { await store.put(mark); },
    flush: () => {
      running ??= drain().finally(() => { running = null; });
      return running;
    },
  };
}

/** Sends a mark to the prototype server. `dropNextAck` ignores one answer, as if signal dropped after the server got it. */
export function httpSender(fetchFn, url, options = { dropNextAck: false }) {
  return async (mark) => {
    const response = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mark) });
    if (!response.ok) throw new Error(`Server answered ${response.status}`);
    if (options.dropNextAck) {
      options.dropNextAck = false;
      throw new Error('Acknowledgement dropped on purpose');
    }
  };
}

/** Flushes on start, when the connection returns and when the app becomes visible, like the real driver app. */
export function startFlushing(win, doc, flush) {
  win.addEventListener('online', () => flush());
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') flush(); });
  flush();
}
