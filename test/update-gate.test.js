import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createUpdateGate } from '../extension/update-gate.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(hasPendingWork = async () => false) {
  const reloads = [];
  const gate = createUpdateGate({ hasPendingWork, reload: (version) => reloads.push(version), reportError: assert.fail });
  return { gate, reloads };
}

test('reloads once when an update arrives while idle', async () => {
  const { gate, reloads } = fixture();
  await gate.available('2.0.0');
  await gate.check();
  assert.deepEqual(reloads, ['2.0.0']);
});

test('waits for every command and session task, including a failed one', async () => {
  const { gate, reloads } = fixture();
  const command = deferred();
  const session = deferred();
  const commandResult = gate.run(() => command.promise);
  const sessionResult = gate.run(() => session.promise);
  await gate.available('2.0.0');
  assert.deepEqual(reloads, []);
  command.resolve('response sent');
  assert.equal(await commandResult, 'response sent');
  assert.deepEqual(reloads, []);
  session.reject(new Error('session closed'));
  await assert.rejects(sessionResult, /session closed/);
  await setImmediate();
  assert.deepEqual(reloads, ['2.0.0']);
});

test('waits for the outbox to drain or expire, including after a worker wakes', async () => {
  let pending = true;
  const { gate, reloads } = fixture(async () => pending);
  await gate.available('2.0.0');
  assert.deepEqual(reloads, []);
  pending = false;
  await gate.check();
  assert.deepEqual(reloads, ['2.0.0']);
});

test('checks the outbox again if a command finishes during the first read', async () => {
  const firstRead = deferred();
  let pending = false;
  let reads = 0;
  const { gate, reloads } = fixture(async () => ++reads === 1 ? firstRead.promise : pending);
  const initialCheck = gate.available('2.0.0');
  await gate.run(async () => { pending = true; });
  firstRead.resolve(false);
  await initialCheck;
  assert.equal(reads, 2);
  assert.deepEqual(reloads, []);
  pending = false;
  await gate.check();
  assert.deepEqual(reloads, ['2.0.0']);
});
