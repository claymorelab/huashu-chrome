#!/usr/bin/env node
// 打云端 Home 预装用的 CRX。
//
// 云端 Chromium 用外部扩展文件（external_crx）真正安装它，而不是每次启动 --load-extension：
// 命令行加载的扩展每次启动都算全新安装，chrome.storage 被清空。
// CRX 用我们自己的私钥签（商店 key 的私钥在 Google 手里），ID 由这把私钥算出，
// 桥认它（src/lib/paths.js 的 CLOUD_EXTENSION_ID）。manifest 里的商店 `key` 去掉，免得和签名公钥对不上。
// 包里放一个空的 preinstalled 标记文件：云端没人看欢迎页（extension/background.js 的 onInstalled）。
// 用 Google Chrome 自己的 --pack-extension 签，私钥只按路径传，不进仓库、不复制。
//
//   node scripts/pack-cloud-crx.mjs <私钥.pem>   → dist/claymore-piko-<version>.crx
//   CHROME=<chrome 可执行文件> 覆盖默认的 macOS Google Chrome 路径。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLOUD_EXTENSION_ID } from '../src/lib/paths.js';

const keyPath = process.argv[2];
if (!keyPath) throw new Error('用法：node scripts/pack-cloud-crx.mjs <私钥.pem>');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, 'dist', `claymore-piko-${manifest.version}.crx`);

const spki = crypto.createPublicKey(fs.readFileSync(keyPath)).export({ type: 'spki', format: 'der' });
const hex = crypto.createHash('sha256').update(spki).digest('hex').slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
if (id !== CLOUD_EXTENSION_ID) throw new Error(`这把私钥算出的 ID 是 ${id}，桥只认 ${CLOUD_EXTENSION_ID}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-crx-'));
const stage = path.join(tmp, 'extension');
fs.cpSync(SRC, stage, { recursive: true, filter: (p) => !/\.DS_Store$|\/content\/?$/.test(p) });
delete manifest.key;
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(stage, 'preinstalled'), '');
execFileSync(chrome, ['--headless=new', '--no-first-run', `--user-data-dir=${path.join(tmp, 'profile')}`,
  `--pack-extension=${stage}`, `--pack-extension-key=${path.resolve(keyPath)}`], { stdio: 'ignore' });
const crx = fs.readFileSync(`${stage}.crx`);
if (crx.subarray(0, 4).toString() !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error('Chrome 没打出 CRX3');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, crx);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(out);
console.log(`id      ${id}`);
console.log(`version ${manifest.version}`);
console.log(`sha256  ${crypto.createHash('sha256').update(crx).digest('hex')}`);
