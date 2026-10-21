#!/usr/bin/env node
// 打 Claymore Piko 扩展的 zip 包。
//
// manifest 里的 `key` **保留**：扩展 ID（afnglaiimnjpcdnnihploelgnoalaogm）由它算出（这把公钥来自 Chrome 应用商店后台的 View public key，商店版和解包加载的 ID 相同），
// 本机的桥只接受这个 ID（src/lib/paths.js 的 EXTENSION_ID）。剥掉 key 的包装出来是另一个 ID，
// 连不上桥。Chrome 应用商店上架时同样要保证商店给的 ID 就是这一个，否则桥会拒绝商店版。
// 不改 extension/ 目录本身——那是 unpacked 加载和 doctor 指向的真源。
//
//   node scripts/pack-extension.mjs            → dist/claymore-piko-<version>.zip
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, 'dist', `claymore-piko-${manifest.version}.zip`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pack-'));
fs.cpSync(SRC, stage, { recursive: true, filter: (p) => !/\.DS_Store$|\/content\/?$/.test(p) });
if (!manifest.key) throw new Error('extension/manifest.json 没有 key：扩展 ID 会变，桥不会接受它');
fs.mkdirSync(path.dirname(out), { recursive: true });
try { fs.unlinkSync(out); } catch { /* 没有旧包 */ }
execFileSync('zip', ['-qr', out, '.'], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

console.log(`${out}  (${Math.round(fs.statSync(out).size / 1024)}KB)`);
console.log(`保留了 manifest.key（扩展 ID 不变）；版本 ${manifest.version}。`);
