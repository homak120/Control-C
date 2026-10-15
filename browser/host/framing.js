// Length-prefixed JSON frames: a 4-byte little-endian length, then UTF-8 JSON.
//
// This is Chrome's native-messaging format. The broker uses it on both sides
// (stdio to the browser, the Unix socket to clients) so one decoder serves both.
// Chrome refuses host→extension messages over 1 MiB, so that is our cap too.

export const MAX_FRAME = 1024 * 1024;

export function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_FRAME) throw new Error(`message too large (${body.length} bytes)`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Incremental decoder. Feed it chunks; it calls onMessage per complete frame and
 * onError (then stops) on a bad length or bad JSON, since a desynced stream
 * can't be trusted again.
 */
export class FrameReader {
  constructor(onMessage, onError = () => {}) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.buf = Buffer.alloc(0);
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len === 0 || len > MAX_FRAME) return this.fail(new Error(`bad frame length ${len}`));
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { return this.fail(new Error('bad JSON frame')); }
      this.onMessage(msg);
    }
  }

  fail(err) {
    this.dead = true;
    this.buf = Buffer.alloc(0);
    this.onError(err);
  }
}
