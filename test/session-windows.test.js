// 会话窗口：云端 Piko 一台浏览器被好几个 Bot 共用，每个会话一个自己的窗口。
//
// 桥要做两件事：把宿主在 hello 里要的 windows 盖到每条命令上（扩展据此开窗、提窗），
// 以及判定「会话真结束了」——断开后宽限期内没回来，才让扩展关窗；扩展那会儿
// 不在线就记着，连上时补发。不需要真 Chrome，用 ws 客户端伪装。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { BridgeClient } from '../src/lib/rpc.js';
import { sessionWindowsFromEnv } from '../src/mcp-server.js';
import { VERSION } from '../src/lib/version.js';
import { EXTENSION_ORIGIN } from '../src/lib/paths.js';

const PORT = 8983;
const TOKEN = 'e'.repeat(64);
const URL = `ws://127.0.0.1:${PORT}`;
const GRACE = 300;
let bridge;

before(async () => {
  bridge = startBridge({ port: PORT, token: TOKEN, writeInfo: false, sessionEndGraceMs: GRACE });
  await bridge.ready;
});
after(() => bridge.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ext(instanceId) {
  const ws = new WebSocket(URL, { origin: EXTENSION_ORIGIN });
  await new Promise((r) => ws.on('open', r));
  const got = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.cmd) {
      got.push(m);
      ws.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: { text: 'ok' } }));
    } else if (m.type === 'event' && m.event === 'session_ended') got.push(m);
  });
  ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'testid', version: VERSION, instanceId, v: 1 }));
  await sleep(50);
  return { ws, got, ended: () => got.filter((m) => m.event === 'session_ended').map((m) => m.sid) };
}

async function agent(sessionId, windows) {
  const ws = new WebSocket(URL);
  await new Promise((r) => ws.on('open', r));
  const welcome = new Promise((r) => ws.once('message', r));
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'piko', sessionId, ...(windows ? { windows: true } : {}), v: 1 }));
  await welcome;
  const res = new Promise((r) => ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'res') r(m); }));
  ws.send(JSON.stringify({ type: 'cmd', id: 'c1', cmd: 'snapshot', params: {} }));
  await res;
  return ws;
}

test('HUASHU_CHROME_SESSION_WINDOWS=1 才要会话窗口，hello 里带上 windows', () => {
  assert.equal(sessionWindowsFromEnv({ HUASHU_CHROME_SESSION_WINDOWS: '1' }), true);
  assert.equal(sessionWindowsFromEnv({ HUASHU_CHROME_SESSION_WINDOWS: '0' }), false);
  assert.equal(sessionWindowsFromEnv({}), false);
  assert.equal(new BridgeClient({ client: 'piko', sessionWindows: true }).sessionWindows, true);
  assert.equal(new BridgeClient({ client: 'piko' }).sessionWindows, false);
});

test('要了会话窗口的会话，命令上盖 windows；没要的不盖', async () => {
  const e = await ext('win-stamp');
  const cloud = await agent('cloud:1', true);
  const local = await agent('local:1', false);
  const bySid = Object.fromEntries(e.got.filter((m) => m.cmd).map((m) => [m.sid, m]));
  assert.equal(bySid['cloud:1'].windows, true);
  assert.equal('windows' in bySid['local:1'], false);
  cloud.close(); local.close();
  await sleep(GRACE + 200);   // 让 cloud:1 的结束在这一个扩展上收掉，别漏进下一个用例
  e.ws.close();
});

test('断开后宽限期内没回来才告诉扩展关窗；没要会话窗口的会话不关', async () => {
  const e = await ext('win-end');
  const cloud = await agent('cloud:2', true);
  const local = await agent('local:2', false);
  cloud.close(); local.close();
  await sleep(GRACE / 3);
  assert.deepEqual(e.ended(), [], '宽限期里不该关');
  await sleep(GRACE + 200);
  assert.deepEqual(e.ended(), ['cloud:2']);
  e.ws.close();
});

test('宽限期里带着同一个 sessionId 回来就不关', async () => {
  const e = await ext('win-back');
  const first = await agent('cloud:3', true);
  first.close();
  await sleep(GRACE / 3);
  const again = await agent('cloud:3', true);
  await sleep(GRACE + 200);
  assert.deepEqual(e.ended(), []);
  again.close();
  await sleep(GRACE + 200);
  assert.deepEqual(e.ended(), ['cloud:3'], '最后那次断开没回来，照样要关');
  e.ws.close();
});

test('判定结束时扩展不在线，它连上就补发', async () => {
  const cloud = await (async () => {
    const e = await ext('win-late-0');   // 命令得有人接；接完就走
    const ws = await agent('cloud:4', true);
    e.ws.close();
    return ws;
  })();
  cloud.close();
  await sleep(GRACE + 200);
  const late = await ext('win-late-1');
  await sleep(100);
  assert.deepEqual(late.ended(), ['cloud:4']);
  late.ws.close();
});
