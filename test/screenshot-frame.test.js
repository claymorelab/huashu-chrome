import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketServer } from 'ws';
import { FRAME_MODE, captureScale, cssPoint, exceedsStockLimit, ScreenshotFrames } from '../extension/screenshot-frame.js';
import { screenshotSummary } from '../src/mcp-server.js';

const frame = { width: 960, height: 500, cssWidth: 1280, cssHeight: 800 };

test('image input maps independently on both axes, including the drag endpoint', () => {
  assert.deepEqual(cssPoint({ x: 480, y: 250 }, frame), { x: 640, y: 400 });
  assert.deepEqual(cssPoint({ x: 720, y: 125 }, frame), { x: 960, y: 200 });
  assert.deepEqual(cssPoint({ x: 480, y: 250 }), { x: 480, y: 250 });
});

test('a screenshot frame is replaced per tab and cannot outlive invalidation during capture', () => {
  const frames = new ScreenshotFrames();
  const set = (tab, value) => frames.finish(tab, frames.begin(tab), value);
  set(1, frame);
  set(2, frame);
  const next = { ...frame, width: 768, height: 480 };
  const older = frames.begin(1);
  const latest = frames.begin(1);
  assert.equal(frames.finish(1, older, frame), false);
  assert.equal(frames.finish(1, latest, next), true);
  assert.equal(frames.get(1), next);
  assert.equal(frames.get(2), frame);

  const failed = frames.begin(1);
  frames.cancel(1, failed);
  assert.equal(frames.get(1), next);
  for (const event of ['navigation', 'resize', 'detach']) {
    set(1, frame);
    const ticket = frames.begin(1);
    frames.clear(1);
    assert.equal(frames.finish(1, ticket, frame), false, event);
    assert.equal(frames.get(1), undefined, event);
    assert.equal(frames.get(2), frame, event);
  }
});

test('fallback frames survive a worker restart and their invalidation removes persisted state', async () => {
  const data = {};
  const storage = {
    get: async (key) => ({ [key]: data[key] }),
    set: async (values) => Object.assign(data, values),
    remove: async (key) => { delete data[key]; },
  };
  const first = new ScreenshotFrames(storage);
  const fallback = { ...frame, fallback: true };
  first.finish(1, first.begin(1), fallback);
  const restarted = new ScreenshotFrames(storage);
  assert.equal(await restarted.load(1), fallback);
  restarted.clear(1);
  assert.equal(await new ScreenshotFrames(storage).load(1), undefined);
});

test('scale bounds native dimensions by edge and area and keeps a cheap default', () => {
  assert.equal(captureScale(1280, 800, 0.6), 0.6);
  assert.equal(captureScale(1280, 800), 1);
  assert.equal(captureScale(2800, 400), 1568 / 2800);
  assert.equal(captureScale(5120, 2880), Math.sqrt(1_150_000 / 5120 / 2880));
  assert.equal(exceedsStockLimit({ width: 1920, height: 1440 }), true);
  assert.equal(exceedsStockLimit({ width: 2049, height: 20 }), true);
  assert.equal(exceedsStockLimit({ width: 1568, height: 732 }), false);
  assert.match(screenshotSummary({ frame: { width: 2560, height: 1600 }, fallback: true }),
    /^2560x1600; click x,y use this image's pixels; image exceeds stock model image limits$/);
});

test('a new MCP server keeps CSS coordinates and the original image with a legacy extension peer', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piko-grid-mcp-test-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'frame-test', version: '0' });
  t.after(async () => {
    await client.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const port = server.address().port;
  await fs.writeFile(path.join(dir, 'bridge.json'), JSON.stringify({ port, token: 'test' }));

  const header = Buffer.alloc(24);
  header.write('IHDR', 12);
  header.writeUInt32BE(640, 16);
  header.writeUInt32BE(400, 20);
  const data = header.toString('base64');
  const calls = [];
  server.on('connection', peer => {
    peer.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      const reply = (value) => peer.send(JSON.stringify(value));
      if (msg.type === 'hello') return reply({ type: 'welcome', extensionOnline: true });
      calls.push(msg);
      const result = msg.cmd === 'screenshot'
        ? { dataUrl: `data:image/png;base64,${data}`, scale: 1 }
        : { text: 'legacy coordinates dispatched' };
      reply({ type: 'res', id: msg.id, ok: true, data: result });
    });
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'mcp', '--client', 'test'],
    env: { ...process.env, HUASHU_CHROME_HOME: dir },
  }));
  const shot = await client.callTool({ name: 'screenshot', arguments: { tabId: 1, full: true } });
  assert.deepEqual(shot.content, [
    { type: 'text', text: '640x400; click x,y use CSS pixels with this extension' },
    { type: 'image', mimeType: 'image/png', data },
  ]);
  const point = { tabId: 1, x: 600, y: 375, dragTo: { x: 200, y: 100 } };
  const moved = await client.callTool({ name: 'click', arguments: point });
  assert.equal(moved.isError, undefined);
  assert.equal(calls[0].params[FRAME_MODE], true);
  assert.deepEqual(calls[1].params, { ...point, [FRAME_MODE]: true });
});
