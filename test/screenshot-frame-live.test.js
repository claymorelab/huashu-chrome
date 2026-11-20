import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exceedsStockLimit, fitsCaptureLimit, screenshotSize } from '../extension/screenshot-frame.js';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Dedicated profile, browser CDP pipe and loopback bridge. Chrome never sees a
// different HOME, and the unpacked fixture only probes the test bridge's port.
const repo = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const page = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Piko grid baseline</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#target,#destination{position:fixed;width:12px;height:12px;transform:translate(-50%,-50%)}#target{top:50%;left:50%;background:red}#destination{top:35%;left:70%;background:blue}</style>
<div id=target></div><div id=destination></div><script>
window.events = [];
for (const type of ['mousedown', 'mouseup', 'click']) {
  document.addEventListener(type, e => events.push({ type, x:e.clientX, y:e.clientY, target:e.target.id, trusted:e.isTrusted }));
}
</script>`);
});

function devtools(proc) {
  let seq = 0, received = '';
  const pending = new Map();
  proc.stdio[4].setEncoding('utf8').on('data', chunk => {
    received += chunk;
    let end;
    while ((end = received.indexOf('\0')) !== -1) {
      const msg = JSON.parse(received.slice(0, end));
      received = received.slice(end + 1);
      if (!msg.id) continue;
      if (msg.error) pending.get(msg.id)?.reject(new Error(msg.error.message));
      else pending.get(msg.id)?.resolve(msg.result);
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout for ${method}`));
    }, 10000);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); pending.delete(id); resolve(value); },
      reject(error) { clearTimeout(timer); pending.delete(id); reject(error); },
    });
    proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

async function eventually(fn, description) {
  for (let i = 0; i < 80; i++) {
    const result = await fn();
    if (result) return result;
    await delay(125);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function pointsInImage(inWorker, dataUrl) {
  return inWorker(`(async () => {
    const bitmap = await createImageBitmap(await (await fetch(${JSON.stringify(dataUrl)})).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const red = { x: 0, y: 0, count: 0 }, blue = { x: 0, y: 0, count: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const target = g < 70 && (r > 170 && b < 70 ? red : b > 170 && r < 70 ? blue : null);
      if (!target) continue;
      target.x += (i / 4) % bitmap.width;
      target.y += Math.floor(i / 4 / bitmap.width);
      target.count++;
    }
    bitmap.close();
    return [red, blue].map(({ x, y, count }) => count ? { x: x / count, y: y / count } : null);
  })()`);
}

async function runDpr(dpr, extension, endpoint, dir, bridge, { EXTENSION_ID, BridgeClient }) {
  const proc = spawn(chrome, [
    '--headless=new', '--screen-info={4000x2400}', '--window-size=1280,800',
    `--force-device-scale-factor=${dpr}`, `--user-data-dir=${path.join(dir, 'chrome-' + dpr)}`,
    '--use-mock-keychain', '--password-store=basic', '--silent-debugger-extension-api',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const exited = once(proc, 'exit');
  proc.stdio[3].on('error', () => {});
  let chromeLog = '';
  proc.stderr.setEncoding('utf8').on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-1800); });
  const send = devtools(proc);
  const mcp = new Client({ name: 'piko-screenshot-frame-test', version: '0.0.0' }, { capabilities: {} });
  try {
    const version = await send('Browser.getVersion');
    const { id } = await send('Extensions.loadUnpacked', { path: extension });
    assert.equal(id, EXTENSION_ID);
    const worker = await eventually(async () => (await send('Target.getTargets')).targetInfos.find(t =>
      t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`), 'Piko service worker');
    const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const inWorker = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.result.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await eventually(() => [...bridge.wss.clients].some(socket => socket.isExtension && socket.helloed), 'Piko bridge connection');
    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(repo, 'src/cli.js'), 'mcp', '--client', 'piko'],
      env: { ...process.env, HUASHU_CHROME_SESSION_ID: 'piko-screenshot-frame-test', HUASHU_CHROME_SESSION_WINDOWS: '0' },
    }));
    const call = async (name, args, allowError = false) => {
      const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 25000 });
      if (!allowError) assert.ok(!result.isError, JSON.stringify(result.content));
      return result;
    };
    const { targetId } = await send('Target.createTarget', { url: endpoint });
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    const tabId = await eventually(() => inWorker(`chrome.tabs.query({}).then(tabs =>
      tabs.find(t => t.url === ${JSON.stringify(endpoint)} && t.status === 'complete')?.id)`), 'measurement page');
    await inWorker(`chrome.tabs.update(${tabId}, {active:true})`);
    const document = (func, args = []) => inWorker(`chrome.scripting.executeScript({
      target:{tabId:${tabId}}, world:'MAIN', func:${func.toString()}, args:${JSON.stringify(args)}
    }).then(([r]) => r.result)`);
    const viewport = () => document(() => ({
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      outerWidth, outerHeight,
    }));
    const reset = () => document(() => { window.events.length = 0; });
    const events = () => document(() => window.events);
    const targetCenter = (id) => document(id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, [id]);
    const assertClick = async () => {
      const click = (await events()).find(event => event.type === 'click');
      assert.equal(click?.target, 'target', JSON.stringify(click));
      assert.equal(click.trusted, true);
    };
    const assertDrag = async () => {
      const actual = (await events()).filter(event => event.type === 'mousedown' || event.type === 'mouseup');
      assert.deepEqual(actual.map(({ type, target, trusted }) => ({ type, target, trusted })), [
        { type: 'mousedown', target: 'target', trusted: true },
        { type: 'mouseup', target: 'destination', trusted: true },
      ]);
    };
    const debuggerState = disabled => inWorker(`(async () => {
      await globalThis.__pikoMeasure.detach(${tabId});
      await chrome.storage.local.set({l2Disabled:${disabled}});
    })()`);

    for (const [width, height] of [[1280, 800], [2560, 1440]]) {
      const before = await viewport();
      await send('Browser.setWindowBounds', { windowId, bounds: {
        width: width + before.outerWidth - before.width,
        height: height + before.outerHeight - before.height,
      } });
      const v = await eventually(async () => {
        const metrics = await viewport();
        return metrics.width === width && metrics.height === height && metrics;
      }, `${width}x${height} CSS viewport at DPR ${dpr}`).catch(async error => {
        throw new Error(`${error.message}. Last viewport: ${JSON.stringify(await viewport())}`);
      });
      assert.equal(v.dpr, dpr);

      for (const [mode, full, fallback] of [
        ['default', false, false], ['full', true, false],
        ['fallback JPEG', false, true], ['fallback PNG', true, true],
      ]) {
        await debuggerState(fallback);
        const shot = await call('screenshot', { tabId, full });
        const image = shot.content.find(item => item.type === 'image');
        assert.ok(image, 'Expected an image block');
        const dataUrl = `data:${image.mimeType};base64,${image.data}`;
        const size = screenshotSize(dataUrl);
        if (!fallback) assert.ok(fitsCaptureLimit(size), JSON.stringify(size));
        assert.deepEqual(shot.structuredContent.frame, { tabId, ...size, cssWidth: width, cssHeight: height });
        const summary = shot.content.find(item => item.type === 'text').text;
        assert.ok(summary.startsWith(`${size.width}x${size.height}; click x,y use this image's pixels`));
        assert.equal(summary.includes('exceeds stock model image limits'), fallback && exceedsStockLimit(size));
        const captured = await viewport();
        assert.deepEqual([captured.width, captured.height, captured.dpr], [width, height, dpr]);
        const [start, end] = await pointsInImage(inWorker, dataUrl);
        assert.ok(start && end, `Both targets are visible in ${mode} ${width}x${height} at DPR ${dpr}`);

        await reset();
        if (fallback) {
          const disabledClick = await call('click', { tabId, ...start }, true);
          assert.equal(disabledClick.isError, true);
          assert.match(disabledClick.content[0].text, /NEEDS_L2/);
          assert.deepEqual(await events(), []);
          // The fallback yields an image while the debugger is unavailable.
          await inWorker('chrome.storage.local.set({l2Disabled:false})');
        }
        if (dpr === 1 && width === 1280 && mode === 'default') await delay(5250);
        await call('click', { tabId, ...start });
        await assertClick().catch(error => {
          throw new Error(`${mode} at ${width}x${height} DPR ${dpr}, image ${size.width}x${size.height}, red at ${JSON.stringify(start)}`, { cause: error });
        });

        await reset();
        await call('click', { tabId, ...start, dragTo: end });
        await assertDrag();

        if (dpr === 1 && width === 1280 && mode === 'default') {
          const cssStart = await targetCenter('target');
          const cssEnd = await targetCenter('destination');
          await reset();
          await call('click', { tabId, css: true, ...cssStart });
          await assertClick();
          await reset();
          await call('click', { tabId, css: true, ...cssStart, dragTo: cssEnd });
          await assertDrag();

          const saved = await call('screenshot', { tabId, full: true, savePath: path.join(dir, 'saved-viewport.png') });
          assert.ok(saved.content.every(item => item.type !== 'image'));
          await reset();
          await call('click', { tabId, ...start });
          await assertClick();

          await reset();
          await call('act', { tabId, steps: [
            { do: 'if', cond: { selectorExists: '#target' }, then: [{ do: 'click', ...start, dragTo: end }] },
          ] });
          await assertDrag();

          // An earlier MCP peer sends the same bridge commands without the opt-in.
          const legacy = new BridgeClient({ client: 'test', sessionId: 'legacy-mcp-stub' });
          try {
            await legacy.connect();
            await reset();
            await legacy.call('click', cssStart, { tabId });
            await assertClick();
            await reset();
            await call('click', { tabId, ...start });
            await assertClick();
            const oldShot = await legacy.call('screenshot', {}, { tabId });
            assert.equal(oldShot.frame, undefined);
            assert.equal(oldShot.scale, 0.6);
          } finally {
            legacy.close();
          }

          await debuggerState(false);
          await reset();
          await call('click', { tabId, ...cssStart });
          await assertClick();
        }
        process.stdout.write(JSON.stringify({ chrome: version.product, dpr, viewport: [width, height],
          mode, image: [size.width, size.height], click: 'hit', drag: 'hit' }) + '\n');
      }
      await debuggerState(false);
    }

    if (dpr === 1) {
      await call('screenshot', { tabId });
      const before = await viewport();
      await send('Browser.setWindowBounds', {
        windowId, bounds: { width: before.outerWidth - 160, height: before.outerHeight - 100 },
      });
      await eventually(async () => (await viewport()).width === before.width - 160, 'resized viewport');
      await reset();
      await call('click', { tabId, ...await targetCenter('target') });
      await assertClick();

      await call('screenshot', { tabId });
      await call('navigate', { tabId, url: endpoint + '?document=2' });
      await call('click', { tabId, ...await targetCenter('target') });
      await assertClick();

      await inWorker(`chrome.tabs.setZoom(${tabId}, 1.25)`);
      await eventually(async () => (await viewport()).dpr === 1.25, 'fractional browser zoom');
      await document(() => {
        document.documentElement.style.overflow = 'auto';
        document.body.style.height = '400vh';
        window.scrollTo(0, 500);
      });
      const zoomed = await call('screenshot', { tabId });
      const image = zoomed.content.find(item => item.type === 'image');
      const [start, end] = await pointsInImage(inWorker, `data:${image.mimeType};base64,${image.data}`);
      assert.ok(start && end, 'Both targets remain visible in a scrolled and zoomed viewport');
      await reset();
      await call('click', { tabId, ...start, dragTo: end });
      await assertDrag();
    }
  } catch (error) {
    console.error(chromeLog);
    throw error;
  } finally {
    await mcp.close().catch(() => {});
    if (proc.exitCode === null && proc.signalCode === null) {
      await send('Browser.close').catch(() => proc.kill());
      await Promise.race([exited, delay(3500)]);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await exited;
      }
    }
  }
}

test('Chrome hits click and drag targets located in the delivered MCP screenshot pixels', { timeout: 120000 }, async () => {
  const { bavail, bsize } = await fs.statfs(os.tmpdir());
  assert.ok(bavail * bsize >= 25_000_000_000, 'Disk is below the 25 GB floor');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piko-grid-live-'));
  const bridgeHome = path.join(dir, 'bridge');
  process.env.HUASHU_CHROME_HOME = bridgeHome;
  const { startBridge } = await import('../src/bridge.js');
  const { writeBridgeInfo, EXTENSION_ID } = await import('../src/lib/paths.js');
  const { BridgeClient } = await import('../src/lib/rpc.js');
  let bridge;
  const log = console.log;
  console.log = console.error;
  try {
    await fs.mkdir(bridgeHome);
    bridge = startBridge({ port: 0, writeInfo: false });
    await bridge.ready;
    const port = bridge.wss.address().port;
    writeBridgeInfo({ port, token: bridge.token, pid: process.pid });
    const extension = path.join(dir, 'extension');
    await fs.cp(path.join(repo, 'extension'), extension, { recursive: true });
    await fs.writeFile(path.join(extension, 'preinstalled'), '');
    for (const file of ['background.js', 'offscreen.js']) {
      const fullPath = path.join(extension, file);
      const source = await fs.readFile(fullPath, 'utf8');
      const isolated = source.replace(/const PORTS = \[[^\]]+\];/, `const PORTS = [${port}];`);
      assert.notEqual(isolated, source);
      await fs.writeFile(fullPath, isolated + (file === 'background.js'
        ? '\nglobalThis.__pikoMeasure = { detach: cdp.detach };\n' : ''));
    }
    await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${page.address().port}/`;
    for (const dpr of [1, 2]) {
      const { bavail, bsize } = await fs.statfs(dir);
      assert.ok(bavail * bsize >= 25_000_000_000, 'Disk is below the 25 GB floor');
      await runDpr(dpr, extension, endpoint, dir, bridge, { EXTENSION_ID, BridgeClient });
    }
  } finally {
    console.log = log;
    bridge?.close();
    page.close();
    await fs.rm(dir, { force: true, recursive: true });
  }
});
