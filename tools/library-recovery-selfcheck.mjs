/* IndexedDB suspension/reconnect regression check.
 *
 * Exercises the production Library adapter from index.html. No browser or
 * document data is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ALOUD_ROOT
  || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function productionIDB(indexedDB, timers) {
  const start = source.indexOf('const idb = {');
  const endMarker = '\n};\n/* How many files';
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('production idb adapter not found');
  const objectSource = source.slice(start, end + 3);
  return new Function(
    'indexedDB', 'setTimeout', 'clearTimeout',
    `${objectSource}\nreturn idb;`
  )(indexedDB, timers.setTimeout, timers.clearTimeout);
}

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = next++; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    fireAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
    get size() { return pending.size; },
  };
}

function fakeConnection(name) {
  return {
    name,
    closeCount: 0,
    close() { this.closeCount++; },
  };
}

async function flushMicrotasks(count = 8) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function main() {
  const timers = fakeTimers();
  const opens = [];
  const indexedDB = {
    open() {
      const request = {};
      opens.push(request);
      return request;
    },
  };
  const idb = productionIDB(indexedDB, timers);

  // A suspended open is bounded and a late success cannot replace the next
  // connection with a zombie handle.
  const first = idb.open();
  assert(opens.length === 1 && timers.size === 1, 'open was not bounded by one timer');
  timers.fireAll();
  await first.then(
    () => { throw new Error('hung open unexpectedly resolved'); },
    () => {},
  );
  assert(idb._p === null && idb._db === null, 'hung open remained cached');
  const late = fakeConnection('late');
  opens[0].result = late;
  opens[0].onsuccess();
  assert(late.closeCount === 1 && idb._db === null, 'late open replaced the recovered connection');

  const second = idb.open();
  const healthy = fakeConnection('healthy');
  opens[1].result = healthy;
  opens[1].onsuccess();
  assert(await second === healthy && idb._db === healthy, 'fresh connection did not replace the timeout');

  // Two old transactions can time out close together after suspension. Once
  // reconnect B has started, the second failure from old A must not cancel B.
  const old = fakeConnection('old');
  const reconnect = Promise.resolve(healthy);
  idb._db = null;
  idb._p = reconnect;
  const generation = idb._generation;
  idb.invalidate(old);
  assert(idb._generation === generation, 'stale transaction invalidated a newer generation');
  assert(idb._p === reconnect, 'stale transaction cleared an in-flight reconnect');
  assert(old.closeCount === 1, 'stale connection was not closed');

  // The actual current connection still invalidates fully on close/reset.
  idb._db = healthy;
  idb._p = reconnect;
  idb.invalidate(healthy);
  assert(idb._generation === generation + 1, 'current connection did not advance generation');
  assert(idb._db === null && idb._p === null, 'current connection remained cached');

  // Concurrent Library reads share one failed open and must also share exactly
  // one reconnect. Individual callers may not invalidate another caller's B.
  const retryTimers = fakeTimers();
  const retryOpens = [];
  const retryIDB = productionIDB({
    open() { const request = {}; retryOpens.push(request); return request; },
  }, retryTimers);
  const read = store => store.get('doc');
  const firstRead = retryIDB.tx('readonly', read);
  const secondRead = retryIDB.tx('readonly', read);
  assert(retryOpens.length === 1, 'concurrent callers did not share the initial open');
  retryOpens[0].error = new Error('suspended connection');
  retryOpens[0].onerror();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert(retryOpens.length === 2, `failed callers started ${retryOpens.length - 1} reconnects instead of one`);
  const recovered = fakeConnection('recovered');
  recovered.transaction = () => {
    const transaction = {
      error: null,
      objectStore() {
        return {
          get() {
            const request = { result: 'restored document' };
            queueMicrotask(() => {
              request.onsuccess?.();
              transaction.oncomplete?.();
            });
            return request;
          },
        };
      },
      abort() {},
    };
    return transaction;
  };
  retryOpens[1].result = recovered;
  retryOpens[1].onsuccess();
  assert((await Promise.all([firstRead, secondRead])).every(value => value === 'restored document'),
         'concurrent callers did not recover through the shared reconnect');
  assert(retryOpens.length === 2, 'recovery created another unnecessary connection');

  // A transaction that remains pending after suspension is bounded, closes
  // its poisoned connection, and succeeds through one fresh connection.
  const txTimers = fakeTimers();
  const txOpens = [];
  const txIDB = productionIDB({
    open() { const request = {}; txOpens.push(request); return request; },
  }, txTimers);
  const txRead = txIDB.get('doc');
  const hung = fakeConnection('hung transaction');
  hung.transaction = () => ({
    error: null,
    objectStore: () => ({ get: () => ({}) }),
    abort() {},
  });
  txOpens[0].result = hung;
  txOpens[0].onsuccess();
  await flushMicrotasks();
  assert(txTimers.size === 1, 'transaction timeout was not armed');
  txTimers.fireAll();
  await flushMicrotasks();
  assert(hung.closeCount >= 1, 'hung transaction connection was not closed');
  assert(txOpens.length === 2, 'hung transaction did not start one reconnect');
  const afterTimeout = fakeConnection('after timeout');
  afterTimeout.transaction = recovered.transaction;
  txOpens[1].result = afterTimeout;
  txOpens[1].onsuccess();
  assert(await txRead === 'restored document', 'transaction timeout did not recover the Library read');

  // Browser-driven connection close/version change events invalidate the
  // cached handle before the next Library operation.
  const closeTimers = fakeTimers();
  const closeOpens = [];
  const closeIDB = productionIDB({
    open() { const request = {}; closeOpens.push(request); return request; },
  }, closeTimers);
  const closePromise = closeIDB.open();
  const closed = fakeConnection('browser closed');
  closeOpens[0].result = closed;
  closeOpens[0].onsuccess();
  await closePromise;
  const closeGeneration = closeIDB._generation;
  closed.onclose();
  assert(closeIDB._db === null && closeIDB._p === null &&
         closeIDB._generation === closeGeneration + 1,
         'connection close event remained cached');
  const versionPromise = closeIDB.open();
  const versioned = fakeConnection('version changed');
  closeOpens[1].result = versioned;
  closeOpens[1].onsuccess();
  await versionPromise;
  const versionGeneration = closeIDB._generation;
  versioned.onversionchange();
  assert(closeIDB._db === null && closeIDB._generation === versionGeneration + 1,
         'version-change event remained cached');

  // Synchronous browser refusal is not retained forever, and a double failure
  // stops after the documented single retry instead of looping indefinitely.
  let syncAttempts = 0;
  const syncIDB = productionIDB({
    open() { syncAttempts++; throw new Error('storage disabled'); },
  }, fakeTimers());
  await syncIDB.open().catch(() => {});
  await flushMicrotasks();
  assert(syncIDB._p === null, 'synchronous open failure remained cached');
  await syncIDB.open().catch(() => {});
  assert(syncAttempts === 2, 'synchronous open was not retryable on a later action');

  const capTimers = fakeTimers();
  const capOpens = [];
  const capIDB = productionIDB({
    open() { const request = {}; capOpens.push(request); return request; },
  }, capTimers);
  const capped = capIDB.get('doc');
  capOpens[0].error = new Error('first failure');
  capOpens[0].onerror();
  await flushMicrotasks();
  assert(capOpens.length === 2, 'first failure did not receive one retry');
  capOpens[1].error = new Error('second failure');
  capOpens[1].onerror();
  await flushMicrotasks();
  assert(capOpens.length === 2, 'Library failure retried more than once');
  await capped.then(
    () => { throw new Error('double failure unexpectedly resolved'); },
    () => {},
  );

  console.log('library recovery self-check: PASS');
}

main().catch(error => {
  console.error(`library recovery self-check: FAIL — ${error?.stack || error}`);
  process.exitCode = 1;
});
