// 多实例路由测试 —— 桥不再是单槽。
//
// 这组用例守的是 8-29 那个现场：主 Chrome 和 agent 起的 headless 实例
// 各自加载同一份扩展、各自来连，单槽桥让后来者踢掉前一个，被踢的立刻重连
// 再踢回去，每秒一次，命令落在刚被踢掉那一方就报 NO_EXTENSION。
// 用户看到的是「插件时有时无」。
//
// 不需要真 Chrome，用 ws 客户端伪装成两个实例。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { VERSION } from '../src/lib/version.js';
import { EXTENSION_ORIGIN } from '../src/lib/paths.js';

const PORT = 8988;
const TOKEN = 'b'.repeat(64);
const URL = `ws://127.0.0.1:${PORT}`;
let bridge;

before(async () => {
  // orphanGraceMs：断线在途命令的宽限。生产是 15 秒，测试里等不起，压到 300ms
  bridge = startBridge({ port: PORT, token: TOKEN, writeInfo: false, orphanGraceMs: 300 });
  await bridge.ready;
});
after(() => bridge.close());

function nextOf(ws, type, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等 ${type} 超时`)), ms);
    const on = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type !== type) return;
      clearTimeout(t);
      ws.off('message', on);
      resolve(m);
    };
    ws.on('message', on);
  });
}

// 伪装一个 Chrome 实例
async function ext({ instanceId, headless = false, chrome = '152.0.0.0' }) {
  const ws = new WebSocket(URL, { origin: EXTENSION_ORIGIN });
  await new Promise((r) => ws.on('open', r));
  // 收集器必须在握手**之前**挂上：桥补发排队命令是紧接着 welcome 发的，
  // 等 await welcome 之后再挂就漏掉了（真扩展的 onmessage 也是一直挂着的）
  const cmds = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.cmd) cmds.push(m);
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const welcome = nextOf(ws, 'welcome');
  ws.send(JSON.stringify({
    type: 'hello', role: 'extension', extId: 'testid',
    version: VERSION, instanceId, headless, chrome, v: 1,
  }));
  await welcome;
  return { ws, cmds, closed };
}

async function agent(sid = 's1') {
  const ws = new WebSocket(URL);
  await new Promise((r) => ws.on('open', r));
  const w = nextOf(ws, 'welcome');
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: TOKEN, client: 'test', sessionId: sid, v: 1 }));
  return { ws, welcome: await w };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('两个实例并存 —— 谁也不踢谁，这是整组用例的根', async () => {
  const a = await ext({ instanceId: 'inst-A' });
  const b = await ext({ instanceId: 'inst-B' });
  await settle();

  // 单槽那版这里 a 已经被 close(4009) 了
  assert.equal(a.ws.readyState, 1, 'A 不该因为 B 连上就被踢掉');
  assert.equal(b.ws.readyState, 1);

  const g = await agent();
  assert.equal(g.welcome.extensions.length, 2, 'welcome 要如实报出两个实例');

  a.ws.close(); b.ws.close(); g.ws.close();
  await settle();
});

test('同一个实例重连 —— 旧连接该被顶掉，否则重载扩展后会堆死连接', async () => {
  const first = await ext({ instanceId: 'inst-same' });
  const second = await ext({ instanceId: 'inst-same' });

  assert.equal(await first.closed, 4009, '同实例的旧连接要被 replaced');
  assert.equal(second.ws.readyState, 1);

  second.ws.close();
  await settle();
});

test('命令路由到有窗口的那个 —— headless 是 agent 自己起的，没有用户登录态', async () => {
  const head = await ext({ instanceId: 'inst-headless', headless: true });
  const real = await ext({ instanceId: 'inst-real', headless: false });
  await settle();

  const g = await agent('s-route');
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c1', cmd: 'status', params: {} }));
  await settle(300);

  assert.equal(real.cmds.length, 1, '命令该走有窗口的实例');
  assert.equal(head.cmds.length, 0, 'headless 不该收到');

  head.ws.close(); real.ws.close(); g.ws.close();
  await settle();
});

test('一个实例断开 —— 只失败它承接的命令，另一个照常干活', async () => {
  const a = await ext({ instanceId: 'inst-A2', headless: false });
  await settle();
  const g = await agent('s-fail');

  // 这条会落到 a（此刻唯一的有头实例），且故意不回复
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-orphan', cmd: 'status', params: {} }));
  await settle(200);
  assert.equal(a.cmds.length, 1);

  // b 后连上，且是 headless —— a 断开后它才是唯一人选
  const b = await ext({ instanceId: 'inst-B2', headless: true });
  await settle();

  const res = nextOf(g.ws, 'res');
  a.ws.close();
  const r = await res;
  assert.equal(r.id, 'c-orphan');
  assert.equal(r.error.code, 'NO_EXTENSION', 'a 承接的在途命令宽限期过后要失败');
  assert.match(r.error.message, /可能已经在页面上生效/, '要提醒 agent 别把一次点击做成两次');

  // b 还在，桥不该认为「扩展离线」——新命令要能正常发出去
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-after', cmd: 'status', params: {} }));
  await settle(300);
  assert.equal(b.cmds.length, 1, 'a 断开不该影响 b 接活');

  b.ws.close(); g.ws.close();
  await settle();
});

test('瞬断宽限 —— 扩展在宽限期内带着回执回来，agent 拿到的是真结果不是 NO_EXTENSION', async () => {
  const a = await ext({ instanceId: 'inst-blip' });
  await settle();
  const g = await agent('s-blip');
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-blip', cmd: 'status', params: {} }));
  await settle(200);
  assert.equal(a.cmds.length, 1);
  const k = a.cmds[0].__k;

  // 命令在途时连接断了（睡醒后看门狗互杀、双腿替换……），扩展 100ms 后带着
  // 同一个 instanceId 回来，把存在发件箱里的回执按 __k 补发
  const res = nextOf(g.ws, 'res');
  a.ws.close();
  await settle(100);
  const a2 = await ext({ instanceId: 'inst-blip' });
  a2.ws.send(JSON.stringify({ type: 'res', id: 'c-blip', __k: k, ok: true, data: { text: 'late but real' } }));
  const r = await res;
  assert.equal(r.ok, true, `宽限期内补发的回执要原样送达，收到的是：${JSON.stringify(r)}`);
  assert.equal(r.data.text, 'late but real');

  a2.ws.close(); g.ws.close();
  await settle();
});

// 云端冷启动抓到的现场：桥刚起来，扩展一秒里连了三条（offscreen 腿和 SW 兜底腿
// 报同一个 instanceId，互相顶替），桥把排队的命令补发给第一条，它随即被顶掉。
// 以前被顶掉的连接先从名单里摘掉再 close，close 事件里的断线宽限一次都没生效，
// agent 干等到 TIMEOUT。
test('同实例换连接 —— 被顶掉那条上的在途命令走断线宽限，不干等到 TIMEOUT', async () => {
  const a = await ext({ instanceId: 'inst-swap' });
  await settle();
  const g = await agent('s-swap');
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-swap', cmd: 'status', params: {}, timeout: 32000 }));
  await settle(200);
  assert.equal(a.cmds.length, 1);

  const res = nextOf(g.ws, 'res', 2000);   // 宽限 300ms；等满 32 秒的 TIMEOUT 就是老毛病
  const a2 = await ext({ instanceId: 'inst-swap' });
  assert.equal(await a.closed, 4009);
  const r = await res;
  assert.equal(r.error?.code, 'NO_EXTENSION', `收到的是：${JSON.stringify(r)}`);
  assert.match(r.error.message, /可能已经在页面上生效/, '要提醒 agent 别把一次点击做成两次');
  // 不改派：旧连接可能已经执行过，再发给新连接就是双击
  await settle(100);
  assert.equal(a2.cmds.length, 0, '被顶掉那条上的命令不该再发给新连接');

  a2.ws.close(); g.ws.close();
  await settle();
});

test('同实例换连接 —— 回执从新连接回来，照常送达', async () => {
  const a = await ext({ instanceId: 'inst-swap2' });
  await settle();
  const g = await agent('s-swap2');
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-swap2', cmd: 'status', params: {} }));
  await settle(200);
  const k = a.cmds[0].__k;

  const res = nextOf(g.ws, 'res');
  const a2 = await ext({ instanceId: 'inst-swap2' });
  a2.ws.send(JSON.stringify({ type: 'res', id: 'c-swap2', __k: k, ok: true, data: { text: 'via new leg' } }));
  const r = await res;
  assert.equal(r.ok, true, `收到的是：${JSON.stringify(r)}`);
  assert.equal(r.data.text, 'via new leg');

  a2.ws.close(); g.ws.close();
  await settle();
});

test('同实例换连接 —— 旧连接在关闭握手里发出的回执不丢', async () => {
  const a = await ext({ instanceId: 'inst-swap3' });
  await settle();
  const g = await agent('s-swap3');
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-swap3', cmd: 'status', params: {} }));
  await settle(200);
  const k = a.cmds[0].__k;

  // 旧连接先别读到桥的关闭帧：它这侧还是 OPEN，正好把执行完的回执发出去——
  // 真扩展里就是 SW 回执走到 offscreen 时，关闭帧还在路上
  a.ws._socket.pause();
  const res = nextOf(g.ws, 'res');
  const a2 = await ext({ instanceId: 'inst-swap3' });
  a.ws.send(JSON.stringify({ type: 'res', id: 'c-swap3', __k: k, ok: true, data: { text: 'from old leg' } }));
  a.ws._socket.resume();
  const r = await res;
  assert.equal(r.ok, true, `收到的是：${JSON.stringify(r)}`);
  assert.equal(r.data.text, 'from old leg');

  a2.ws.close(); g.ws.close();
  await settle();
});

test('拔插重连 —— 全断期间的命令排队，实例回来就补发', async () => {
  const g = await agent('s-queue');
  // 此刻一个实例都没有：命令应该排队而不是立刻判死
  g.ws.send(JSON.stringify({ type: 'cmd', id: 'c-queued', cmd: 'status', params: {}, timeout: 8000 }));
  await settle(200);

  const back = await ext({ instanceId: 'inst-back' });
  await settle(400);

  assert.equal(back.cmds.length, 1, '扩展回来要补发排队的命令');
  assert.equal(back.cmds[0].id, 'c-queued');

  back.ws.close(); g.ws.close();
  await settle();
});

test('老扩展不报 instanceId —— 退回按扩展 id 认，不跟新扩展混着算', async () => {
  const ws1 = new WebSocket(URL, { origin: EXTENSION_ORIGIN });
  await new Promise((r) => ws1.on('open', r));
  const w1 = nextOf(ws1, 'welcome');
  ws1.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'oldid', version: VERSION, v: 1 }));
  await w1;
  const closed1 = new Promise((r) => ws1.on('close', (c) => r(c)));

  // 同一个 extId 的老扩展再连 —— 行为和单槽时代一样：替换
  const ws2 = new WebSocket(URL, { origin: EXTENSION_ORIGIN });
  await new Promise((r) => ws2.on('open', r));
  const w2 = nextOf(ws2, 'welcome');
  ws2.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'oldid', version: VERSION, v: 1 }));
  await w2;

  assert.equal(await closed1, 4009, '同 extId 的老扩展仍按替换处理');

  ws2.close();
  await settle();
});
