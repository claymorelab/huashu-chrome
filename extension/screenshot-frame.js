// The opt-in is internal to the MCP/extension protocol. Peers predating it keep CSS input.
export const FRAME_MODE = '__screenshotFrame';
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

export function screenshotSize(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  if (header === 'data:image/png;base64') {
    const bytes = atob(dataUrl.slice(comma + 1, comma + 33));
    if (bytes.length < 24 || bytes.slice(12, 16) !== 'IHDR') throw new Error('Invalid screenshot PNG');
    const uint = (offset) => [...bytes.slice(offset, offset + 4)].reduce((n, b) => n * 256 + b.charCodeAt(0), 0);
    return { width: uint(16), height: uint(20) };
  }
  if (header === 'data:image/jpeg;base64') {
    const bytes = atob(dataUrl.slice(comma + 1));
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes.charCodeAt(offset) !== 0xff) break;
      const marker = bytes.charCodeAt(offset + 1);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const uint = (i) => bytes.charCodeAt(i) * 256 + bytes.charCodeAt(i + 1);
        return { width: uint(offset + 7), height: uint(offset + 5) };
      }
      offset += 2 + bytes.charCodeAt(offset + 2) * 256 + bytes.charCodeAt(offset + 3);
    }
  }
  throw new Error('Unable to read screenshot dimensions');
}

export function captureScale(width, height, preferred = 1) {
  return Math.min(preferred, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / width / height));
}

export function fitsCaptureLimit({ width, height }) {
  return width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
}

export function exceedsStockLimit({ width, height }) {
  return Math.max(width, height) > 2048 || Math.ceil(width / 32) * Math.ceil(height / 32) > 2500;
}

export function cssPoint(point, frame) {
  return frame ? { x: point.x * frame.cssWidth / frame.width, y: point.y * frame.cssHeight / frame.height }
    : { x: point.x, y: point.y };
}

export class ScreenshotFrames {
  #tabs = new Map();

  constructor(storage) {
    this.storage = storage;
  }

  async load(tabId) {
    const current = this.#tabs.get(tabId);
    if (current || !this.storage) return current?.loading ?? current?.frame;
    const entry = {};
    const key = this.key(tabId);
    this.#tabs.set(tabId, entry);
    entry.loading = this.storage.get(key).catch(() => ({})).then((values) => {
      if (this.#tabs.get(tabId) === entry) {
        const frame = values[key];
        if (frame) this.#tabs.set(tabId, { frame });
        else this.#tabs.delete(tabId);
      }
      return this.get(tabId);
    });
    return entry.loading;
  }

  key(tabId) {
    return `screenshot-frame:${tabId}`;
  }

  // A navigation, resize, detach or newer capture can supersede an in-flight capture.
  begin(tabId) {
    const ticket = {};
    this.#tabs.set(tabId, { ticket, frame: this.get(tabId) });
    return ticket;
  }

  finish(tabId, ticket, frame) {
    const entry = this.#tabs.get(tabId);
    if (entry?.ticket !== ticket) return false;
    this.#tabs.set(tabId, { frame });
    // Visible-tab capture has no debugger to keep the service worker awake.
    if (frame.fallback) void this.storage?.set({ [this.key(tabId)]: frame }).catch(() => {});
    else void this.storage?.remove(this.key(tabId)).catch(() => {});
    return true;
  }

  cancel(tabId, ticket) {
    const entry = this.#tabs.get(tabId);
    if (entry?.ticket !== ticket) return;
    if (entry.frame) this.#tabs.set(tabId, { frame: entry.frame });
    else this.clear(tabId);
  }

  get(tabId) {
    return this.#tabs.get(tabId)?.frame;
  }

  dropViewport(tabId) {
    const entry = this.#tabs.get(tabId);
    if (entry?.ticket) {
      delete entry.frame;
      void this.storage?.remove(this.key(tabId)).catch(() => {});
    } else {
      this.clear(tabId);
    }
  }

  clear(tabId) {
    this.#tabs.delete(tabId);
    void this.storage?.remove(this.key(tabId)).catch(() => {});
  }
}

export const screenshotFrames = new ScreenshotFrames(globalThis.chrome?.storage?.session);
