// 配置目录与 token —— 桥和 MCP server 共用的落盘约定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// HUASHU_CHROME_HOME 让宿主指定配置目录。Piko 给 MCP server 的 HOME 是每个
// 会话隔离的，按 HOME 推出来的目录各不相同，几个会话就会各起一个桥、互相抢
// 8899 端口。宿主给同一个账号级目录，大家就共用一个桥。只接受绝对路径。
export function homeDir(env = process.env) {
  const configured = String(env.HUASHU_CHROME_HOME ?? '').trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(os.homedir(), '.huashu-chrome');
}

export const HOME = homeDir();
export const BRIDGE_FILE = path.join(HOME, 'bridge.json');
export const LOCK_FILE = path.join(HOME, 'bridge.lock');
export const AUDIT_FILE = path.join(HOME, 'audit.jsonl');
export const ALLOWLIST_FILE = path.join(HOME, 'allowlist.json');
export const LOG_FILE = path.join(HOME, 'bridge.log');

export const DEFAULT_PORT = 8899;

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  return HOME;
}

// 桥启动时写：端口、token、pid。token 每次启动轮换。
export function writeBridgeInfo(info) {
  ensureHome();
  const tmp = BRIDGE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BRIDGE_FILE);
}

export function readBridgeInfo() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 常数时间比较，避免 token 被计时侧信道试探出来
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// 审计日志：每条命令一行，出事能查。桥是唯一写入方。
export function audit(entry) {
  try {
    ensureHome();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // 审计失败不能拖垮主流程
  }
}
