// 宿主识别：右下角驾驶舱和审计里「谁在操控」的名字，以宿主在 MCP 握手里自报的
// clientInfo 为准，--client 只兜底。2026-09-09 的真实事故：Codex 的配置被人手抄成
// --client claude-code，Codex 干活时页面上写着「Claude Code」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost, slugOf } from '../src/lib/host.js';
import { BridgeClient } from '../src/lib/rpc.js';

test('宿主自报的身份压过抄错的 --client', () => {
  const h = resolveHost({ clientInfo: { name: 'codex-mcp-client', version: '0.1' }, flag: 'claude-code' });
  assert.equal(h.client, 'codex');
  assert.equal(h.label, 'Codex CLI');
  assert.equal(h.source, 'clientInfo');
});

test('各家自报名归一到 agents.json 的 slug，显示名从表里取', () => {
  const cases = [
    ['claude-code', 'claude-code', 'Claude Code'],
    ['gemini-cli-mcp-client', 'gemini', 'Gemini CLI'],
    ['cursor-vscode', 'cursor', 'Cursor'],
    ['claude-ai', 'claude-desktop', 'Claude Desktop'],
    ['Roo Code', 'roo', 'Roo Code'],
    ['Cline', 'cline', 'Cline (VS Code)'],
  ];
  for (const [raw, client, label] of cases) {
    const h = resolveHost({ clientInfo: { name: raw }, flag: 'unknown' });
    assert.equal(h.client, client, raw);
    assert.equal(h.label, label, raw);
  }
});

test('没听说过的宿主原样保留它自报的名字，不冒充别家', () => {
  const h = resolveHost({ clientInfo: { name: 'Hermes Agent' }, flag: 'claude-code' });
  assert.equal(h.client, 'hermes-agent');
  assert.equal(h.label, undefined);   // 扩展侧会美化成 Hermes Agent
});

test('宿主没报或报了泛称，才退回 --client', () => {
  assert.equal(resolveHost({ clientInfo: undefined, flag: 'codex' }).client, 'codex');
  assert.equal(resolveHost({ clientInfo: { name: 'mcp-client' }, flag: 'workbuddy' }).label, 'WorkBuddy');
  const h = resolveHost({ clientInfo: { name: '' }, flag: undefined });
  assert.equal(h.client, 'unknown');
  assert.equal(h.source, 'flag');
});

test('slugOf 只剥「我是 MCP 客户端」这种后缀，不动名字本身', () => {
  assert.equal(slugOf('Codex-MCP-Client'), 'codex');
  assert.equal(slugOf('kimi_code'), 'kimi-code');
  assert.equal(slugOf('claude-code'), 'claude-code');
});

test('BridgeClient 在连桥之前可以改口，连上之后不行', () => {
  const c = new BridgeClient({ client: 'claude-code' });
  assert.ok(c.sessionId.startsWith('claude-code:'));
  assert.equal(c.identify('codex', 'Codex CLI'), true);
  assert.equal(c.client, 'codex');
  assert.equal(c.label, 'Codex CLI');
  assert.ok(c.sessionId.startsWith('codex:'), 'sid 前缀要跟着换，扩展从它推显示名');
  // 宿主自带的 sessionId 是更准的身份，改口不能把它冲掉
  const pinned = new BridgeClient({ client: 'x', sessionId: 'host-given' });
  pinned.identify('codex');
  assert.equal(pinned.sessionId, 'host-given');
  c.ws = {};
  assert.equal(c.identify('gemini'), false);
  assert.equal(c.client, 'codex');
});

test('HUASHU_CHROME_SESSION_ID 固定会话标识，空值回到默认推断', async () => {
  const { sessionIdFromEnv } = await import('../src/mcp-server.js');
  assert.equal(sessionIdFromEnv({ HUASHU_CHROME_SESSION_ID: ' piko:abc ' }), 'piko:abc');
  assert.equal(sessionIdFromEnv({ HUASHU_CHROME_SESSION_ID: '  ' }), undefined);
  assert.equal(sessionIdFromEnv({}), undefined);
  const c = new BridgeClient({ client: 'codex', sessionId: sessionIdFromEnv({ HUASHU_CHROME_SESSION_ID: 'piko:abc' }) });
  c.identify('claude-code', 'Claude Code');
  assert.equal(c.sessionId, 'piko:abc');
});

test('HUASHU_CHROME_HOME 只接受绝对路径', async () => {
  const { homeDir } = await import('../src/lib/paths.js');
  assert.equal(homeDir({ HUASHU_CHROME_HOME: '/srv/state/huashu-chrome' }), '/srv/state/huashu-chrome');
  assert.match(homeDir({ HUASHU_CHROME_HOME: 'relative/dir' }), /\.claymore-piko-browser$/);
  assert.match(homeDir({}), /\.claymore-piko-browser$/);
});

test('默认端口和目录都避开上游 huashu-chrome', async () => {
  const { DEFAULT_PORT, homeDir } = await import('../src/lib/paths.js');
  assert.equal(DEFAULT_PORT, 8898);
  assert.doesNotMatch(homeDir({}), /\.huashu-chrome$/);
});

test('HUASHU_CHROME_LABEL 钉住显示名：宿主识别只改 client，不改 label', async () => {
  const { labelFromEnv } = await import('../src/mcp-server.js');
  assert.equal(labelFromEnv({ HUASHU_CHROME_LABEL: ' 小红书运营 ' }), '小红书运营');
  assert.equal(labelFromEnv({ HUASHU_CHROME_LABEL: '  ' }), undefined);
  assert.equal(labelFromEnv({}), undefined);

  const pinned = new BridgeClient({ client: 'unknown', label: labelFromEnv({ HUASHU_CHROME_LABEL: '小红书运营' }) });
  assert.equal(pinned.identify('codex', 'Codex CLI'), true);
  assert.equal(pinned.client, 'codex', '审计用的 client 仍按宿主识别');
  assert.equal(pinned.label, '小红书运营');

  // 没钉的照旧由宿主识别填
  const free = new BridgeClient({ client: 'unknown', label: labelFromEnv({}) });
  free.identify('codex', 'Codex CLI');
  assert.equal(free.label, 'Codex CLI');
});

test('钉住的 label 随 hello 送到桥，再盖到发给扩展的命令上', async () => {
  const { startBridge } = await import('../src/bridge.js');
  const { EXTENSION_ORIGIN } = await import('../src/lib/paths.js');
  const { default: WebSocket } = await import('ws');
  const port = 8994, token = 'c'.repeat(64);
  const bridge = startBridge({ port, token, writeInfo: false });
  await bridge.ready;
  const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXTENSION_ORIGIN });
  const cmd = new Promise((resolve) => ext.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'cmd') return;
    ext.send(JSON.stringify({ type: 'res', id: m.id, __k: m.__k, ok: true, data: {} }));
    resolve(m);
  }));
  await new Promise((r) => ext.on('open', r));
  const welcomed = new Promise((r) => ext.once('message', r));
  ext.send(JSON.stringify({ type: 'hello', role: 'extension', extId: 'piko', v: 1 }));
  await welcomed;

  const c = new BridgeClient({ client: 'unknown', label: '小红书运营' });
  c.identify('codex', 'Codex CLI');
  // connect() 走真实配置目录里的 bridge.json，测试不碰它：用 rpc.js 同一个 hello 形状连测试桥
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', token, client: c.client, label: c.label, sessionId: c.sessionId, v: 1 }));
  await new Promise((r) => ws.once('message', r));
  ws.send(JSON.stringify({ type: 'cmd', id: 'c1', cmd: 'snapshot', params: {} }));
  const m = await cmd;
  assert.equal(m.label, '小红书运营');
  assert.equal(m.client, 'codex');
  ws.close(); ext.close(); bridge.close();
});

test('从来没连上过扩展时，NO_EXTENSION 提示去安装并带上安装地址', async () => {
  const { hint } = await import('../src/mcp-server.js');
  const install = hint({ code: 'NO_EXTENSION', neverConnected: true, message: 'x' });
  assert.match(install, /安装并启用 Claymore Piko 扩展/);
  assert.doesNotMatch(install, /重连/);
  process.env.HUASHU_CHROME_INSTALL_URL = 'https://example.com/piko';
  try {
    assert.match(hint({ code: 'NO_EXTENSION', neverConnected: true, message: 'x' }), /https:\/\/example\.com\/piko/);
  } finally {
    delete process.env.HUASHU_CHROME_INSTALL_URL;
  }
  assert.match(hint({ code: 'NO_EXTENSION', message: 'x' }), /重连/);
});
