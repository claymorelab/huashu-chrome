import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

// CHROME must point to a build that permits enabling a local signed CRX,
// such as Chromium on Linux or Chrome for Testing on macOS.
const chrome = process.env.CHROME;
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const flags = ['--headless=new', '--use-mock-keychain', '--password-store=basic',
  '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-gpu'];
const oldVersion = '1.0.0';
const newVersion = '1.0.1';

async function until(check, description) {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function devtools(proc) {
  let seq = 0, buffer = '';
  const pending = new Map();
  proc.stdio[3].on('error', () => {});
  proc.stdio[4].setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout for ${method}`));
    }, 5000);
    pending.set(id, ({ error, result }) => {
      clearTimeout(timer);
      pending.delete(id);
      error ? reject(new Error(error.message)) : resolve(result);
    });
    proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

async function openPage(send, url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  return {
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      }, sessionId);
      if (exceptionDetails) throw new Error(result.description || exceptionDetails.text);
      return result.value;
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
}

test('a signed update defers while a bridge command runs and reconnects without restarting Chrome',
  { skip: !chrome && 'Set CHROME to an eligible Chromium or Chrome for Testing executable', timeout: 45000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piko-extension-update-'));
    const profile = path.join(root, 'profile');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const hash = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const id = [...hash.slice(0, 32)].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('');
    const key = path.join(root, 'fixture.pem');
    await fs.writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

    let offered = oldVersion;
    let held;
    let available;
    const packages = new Map();
    const update = http.createServer((req, res) => {
      if (req.url.startsWith('/update?')) {
        res.setHeader('Content-Type', 'text/xml');
        res.end(`<?xml version="1.0"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${id}"><updatecheck codebase="${origin}/${offered}.crx" version="${offered}"/></app></gupdate>`);
      } else if (packages.has(req.url)) {
        res.setHeader('Content-Type', 'application/x-chrome-extension');
        res.end(packages.get(req.url));
      } else if (req.url === '/hold') {
        held = res;
      } else if (req.url.startsWith('/available/')) {
        available = req.url.split('/').at(-1);
        res.end();
      } else {
        res.writeHead(404).end();
      }
    });
    update.listen(0, '127.0.0.1');
    await once(update, 'listening');
    const origin = `http://127.0.0.1:${update.address().port}`;
    t.after(() => { update.closeAllConnections(); update.close(); });

    const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(bridge, 'listening');
    t.after(() => { for (const ws of bridge.clients) ws.terminate(); bridge.close(); });
    const messages = [];
    let connected;
    bridge.on('connection', (socket) => socket.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'hello' && msg.extId === id) {
        connected = socket;
        messages.push(msg);
        socket.send(JSON.stringify({ type: 'welcome', bridge: msg.version, v: 1 }));
        socket.send(JSON.stringify({ type: 'event', event: 'sessions', live: [] }));
      } else if (msg.type === 'res') {
        messages.push(msg);
      } else if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    }));

    for (const version of [oldVersion, newVersion]) {
      const source = path.join(root, version);
      await fs.cp(extension, source, { recursive: true });
      const manifestPath = path.join(source, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      delete manifest.key;
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, version, update_url: `${origin}/update` }));
      await fs.writeFile(path.join(source, 'preinstalled'), '');
      await fs.writeFile(path.join(source, 'probe.html'), '<!doctype html><title>Piko update fixture</title>');
      for (const name of ['background.js', 'offscreen.js']) {
        const file = path.join(source, name);
        const code = (await fs.readFile(file, 'utf8')).replace(/const PORTS = \[[^\]]+\]/,
          `const PORTS = [${bridge.address().port}]`);
        const probes = name === 'background.js' ? `
NO_SLOT_CMDS.add('testHold');
HANDLERS.testHold = async () => ({ text: await fetch('${origin}/hold').then((res) => res.text()) });
chrome.runtime.onUpdateAvailable.addListener(({ version }) => {
  void fetch('${origin}/available/' + version);
});
` : '';
        await fs.writeFile(file, code + probes);
      }
      execFileSync(chrome, [...flags, `--user-data-dir=${path.join(root, 'pack-profile')}`,
        `--pack-extension=${source}`, `--pack-extension-key=${key}`], { timeout: 10000 });
      packages.set(`/${version}.crx`, await fs.readFile(`${source}.crx`));
    }
    const external = path.join(profile, 'External Extensions');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, id + '.json'), JSON.stringify({
      external_crx: path.join(root, oldVersion + '.crx'), external_version: oldVersion,
    }));

    const proc = spawn(chrome, [...flags, `--user-data-dir=${profile}`,
      '--enable-logging=stderr', '--remote-debugging-pipe', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const exited = once(proc, 'exit');
    const send = devtools(proc);
    let chromeLog = '';
    proc.stderr.setEncoding('utf8').on('data', (chunk) => { chromeLog = (chromeLog + chunk).slice(-4000); });
    try {
      const admin = await openPage(send, 'chrome://extensions');
      const info = () => admin.evaluate(`chrome.developerPrivate?.getExtensionInfo('${id}')`).catch(() => null);
      const installed = await until(info, 'initial signed CRX install');
      if (installed.state !== 'ENABLED') await admin.evaluate(`chrome.management.setEnabled('${id}', true)`);
      await until(() => messages.find((msg) => msg.version === oldVersion), 'old extension hello');
      const initial = await openPage(send, `chrome-extension://${id}/probe.html`);
      await until(() => initial.evaluate('chrome.runtime?.getManifest()?.version').catch(() => null), 'extension update page');
      connected.send(JSON.stringify({ type: 'cmd', cmd: 'testHold', id: 'update-test', sid: 'update-test' }));
      await until(() => held, 'command waiting on the local server');
      offered = newVersion;
      await initial.evaluate('chrome.runtime.requestUpdateCheck()');
      await initial.close();
      await until(() => available === newVersion, 'onUpdateAvailable for the downloaded CRX');
      assert.equal((await info()).version, oldVersion);
      assert.equal(messages.some((msg) => msg.version === newVersion), false);
      held.end('command completed');
      const reply = await until(() => messages.find((msg) => msg.id === 'update-test'), 'reply from the old extension');
      assert.deepEqual(reply.data, { text: 'command completed' });
      const newHello = await until(() => messages.find((msg) => msg.version === newVersion), 'new extension hello in the same browser');
      assert.ok(messages.indexOf(reply) < messages.indexOf(newHello));
      assert.equal(newHello.instanceId, messages[0].instanceId);
      assert.equal(proc.exitCode, null);
    } catch (error) {
      t.diagnostic(chromeLog);
      throw error;
    } finally {
      const close = send('Browser.close').catch(() => {});
      await Promise.race([exited, delay(6000, null, { ref: false }).then(() => proc.kill('SIGKILL'))]);
      await exited;
      await close;
    }
  });
