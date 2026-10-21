// 桥的探活：静默先 ping 再杀。
//
// 9-2 上午 bridge.log 里 9 次「静默超时」逐条对上了 pmset 的暗唤醒——桥一醒看到
// lastRx 过期就 terminate，而扩展 1 秒后本来就会回心跳。改成先问一声：
// 会回 pong 的连接活着，不会回的才是真半开。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';
import { EXTENSION_ORIGIN } from '../src/lib/paths.js';

const PORT = 8993;
const URL = `ws://127.0.0.1:${PORT}`;
let bridge;

before(async () => {
  // 全部压到百毫秒级：静默 300ms 就探，探了 300ms 没回音才杀，每 100ms 查一轮
  bridge = startBridge({ port: PORT, token: 'c'.repeat(64), writeInfo: false, silenceMs: 300, probeMs: 300, tickMs: 100 });
  await bridge.ready;
});
after(() => bridge.close());

async function ext(instanceId, { answerPing }) {
  const ws = new WebSocket(URL, { origin: EXTENSION_ORIGIN });
  await new Promise((r) => ws.on('open', r));
  const pings = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'ping') { pings.push(Date.now()); if (answerPing) ws.send(JSON.stringify({ type: 'pong' })); }
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  ws.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'testid', version: VERSION, instanceId, v: 1 }));
  return { ws, pings, closed, closedYet: () => ws.readyState !== WebSocket.OPEN };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('静默的连接先收到 ping；回 pong 的活着，不回的才被 terminate', async () => {
  const alive = await ext('inst-alive', { answerPing: true });
  const dead = await ext('inst-dead', { answerPing: false });
  await sleep(1500);
  assert.ok(alive.pings.length >= 1, '静默 300ms 后应该收到探活 ping');
  assert.ok(dead.pings.length >= 1, '哑的那条同样先被探');
  assert.equal(alive.closedYet(), false, '会回 pong 的连接不该被杀');
  assert.equal(dead.closedYet(), true, '探了还不回音的才判死');
  alive.ws.close();
  await sleep(100);
});

// 空闲退出只看 agent：扩展每 15 秒一次心跳，按它算的话桥永远退不了，
// 一个早没人用的桥就在后台一直挂着。
test('没有 agent、没有在途命令就按时退出，扩展连着也一样；有 agent 时不退', async () => {
  const port = PORT + 1, token = 'd'.repeat(64);
  let fired = 0, resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const b = startBridge({ port, token, writeInfo: false, tickMs: 50, idleExitMs: 300, exitWhenIdle: true,
    onIdleExit: () => { fired++; resolveExit(); } });
  await b.ready;
  try {
    const agent = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => agent.on('open', r));
    const welcomed = new Promise((r) => agent.once('message', r));
    agent.send(JSON.stringify({ type: 'hello', role: 'agent', token, client: 'test', sessionId: 'idle:1', v: 1 }));
    await welcomed;

    const e = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXTENSION_ORIGIN });
    await new Promise((r) => e.on('open', r));
    e.on('message', (d) => { if (JSON.parse(d.toString()).type === 'ping') e.send(JSON.stringify({ type: 'pong' })); });
    e.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'piko', version: VERSION, instanceId: 'idle-ext', v: 1 }));

    // agent 连着：过了好几个空闲窗口也不退
    const early = await Promise.race([exited.then(() => 'exited'), sleep(900).then(() => 'stayed')]);
    assert.equal(early, 'stayed', 'agent 还连着时桥不该退出');

    agent.close();
    await exited;
    assert.equal(fired, 1);
    assert.equal(e.readyState, WebSocket.OPEN, '扩展连着不该拦住空闲退出');
    e.close();
  } finally {
    b.close();
  }
});

// 会话下线那一刻扩展恰好断着（被回收、桥换代），它就收不到那条 sessions 推送，
// storage 里的旧名单让早已走掉的会话一直「占着」它的标签页。
test('扩展一连上就收到当前在线名单', async () => {
  const port = PORT + 2, token = 'e'.repeat(64);
  const b = startBridge({ port, token, writeInfo: false });
  await b.ready;
  const hello = async () => {
    const e = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXTENSION_ORIGIN });
    const got = new Promise((resolve) => e.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'event' && m.event === 'sessions') resolve(m.live);
    }));
    await new Promise((r) => e.on('open', r));
    e.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'piko', version: VERSION, instanceId: 'sess-ext', v: 1 }));
    const live = await got;
    e.close();
    return live;
  };
  try {
    const agent = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => agent.on('open', r));
    const welcomed = new Promise((r) => agent.once('message', r));
    agent.send(JSON.stringify({ type: 'hello', role: 'agent', token, client: 'test', sessionId: 'sess:1', v: 1 }));
    await welcomed;
    assert.deepEqual(await hello(), ['sess:1']);

    const gone = new Promise((r) => agent.on('close', r));
    agent.close();
    await gone;
    // 桥那侧的 close 处理和这里的 close 事件不保证先后，等它把名单摘干净
    let live;
    for (let i = 0; i < 20; i++) { live = await hello(); if (!live.length) break; }
    assert.deepEqual(live, [], '会话走了，后连上的扩展拿到的名单里不该还有它');
  } finally {
    b.close();
  }
});

// Piko 删掉会话、agent 进程被杀时，TCP 不一定通知桥。协议层 ping 不回 pong 的 agent
// 要被摘掉，不然它的标签页一直标着「别的会话在用」，桥也永远不空闲退出。
test('不回协议层 pong 的 agent 被判死并摘出在线名单', async () => {
  const port = PORT + 2, token = 'e'.repeat(64);
  const b = startBridge({ port, token, writeInfo: false, tickMs: 100, exitWhenIdle: false });
  await b.ready;
  try {
    const agent = (autoPong) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'agent', token, client: 'test', sessionId: autoPong ? 'alive' : 'dead', v: 1 }));
        resolve(ws);
      });
    });
    const alive = await agent(true);
    const dead = await agent(false);
    const deadClosed = new Promise((r) => dead.on('close', r));
    await Promise.race([deadClosed, sleep(2000)]);
    assert.notEqual(dead.readyState, WebSocket.OPEN, '不回 pong 的 agent 应该被切断');
    await sleep(300);
    assert.equal(alive.readyState, WebSocket.OPEN, '会回 pong 的 agent 不该被切断');
    alive.close();
  } finally {
    b.close();
  }
});
