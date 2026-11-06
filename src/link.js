// -----------------------------------------------------------------------------
// The TCP connection to one AiDot light (port 10000): one connection at a
// time, logged in (loginReq) before anything else, one request in flight at a
// time (no pipeline), by priority (Off, command, read).
//
// - The connection opens only once the light answered the loginReq with code
//   200 under its key: a frame that does not open with the key (another light
//   at that address, a key changed in the cloud) or another `deviceId` is an
//   `identity` failure, never a connection.
// - A request is answered by the message carrying its `seq` (or, when the
//   light does not echo it, the `...Resp` of its method); `onAnswer` runs
//   synchronously, before the next frame of the same chunk is read. Without an
//   answer by its timeout the request ends `timeout` (sent, no answer).
// - A request in flight with no byte for TIMINGS.stuck is cut when an Off
//   waits behind it (or another Off behind a silent Off): the connection is
//   destroyed, then a new one opened for the Off (never two at once). A cut is
//   "left, without answer", never "not sent".
// - Only an Off or a command opens a connection; a read waiting fails when
//   there is none (the app opens connections, with its pauses).
// - After connections that never logged in, the automatic ones wait 1 s
//   doubled up to 10 s; a click (`hurry`) skips that wait once, one such skip
//   per second at most.
// - A heartbeat (frame type 2) when idle for TIMINGS.heartbeat; no byte for 3
//   heartbeats closes the connection. The first generation of lights answers
//   no heartbeat: the app reads it instead (src/app.js).
// - Frames are LIMITS.frameBytes at most: a larger one closes the connection.
// - `beforeSend` runs right before the first byte of a request, on an open
//   connection; it may throw (nothing sent). `onSent` runs once it is written.
// Every wait is bounded (connect, login, answer); the timers are injected.
// Nothing secret is logged (the key, the password, the user id).
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { LIMITS, LOCAL, PRIORITY, TIMINGS } from './constants.js';
import {
  actionRequest,
  encodeMessage,
  frameReader,
  loginRequest,
  openBody,
  pingRequest,
  readMessage,
} from './protocol.js';

/** A closed connection is waited for this long at most before the next one. */
const CLOSE_WAIT = 200;

export class LinkError extends Error {
  /**
   * code: network (no connection), identity (the key or the id of another light), login (the
   * light refused the login), timeout (no answer), cut, closed, late (not sent in time, or
   * refused by beforeSend), refused (an answer with an error code), stopped. `sent`: the
   * request left (fully written to the connection).
   */
  constructor(code, { sent = false, detail, deviceCode } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LinkError';
    this.code = code;
    this.sent = sent;
    this.detail = detail;
    this.deviceCode = deviceCode;
  }
}

/** The default socket: a plain TCP connection, Nagle off (small frames). */
export function tcpConnect({ host, port }) {
  const socket = createConnection({ host, port });
  socket.setNoDelay?.(true);
  return socket;
}

export class LightLink {
  /**
   * `light`: `{ id, ip, key, password, simpleVersion, modelId }`; `userId`: the id of the
   * account (its messages carry it).
   */
  constructor({
    light,
    userId,
    port = LOCAL.port,
    connect = tcpConnect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    logger,
    onMessage = () => {},
    onOpen = () => {},
    onClose = () => {},
    onConnectError = () => {},
  }) {
    this.light = light;
    this.userId = userId;
    this.host = light.ip;
    this.port = port;
    this.connectFn = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.logger = logger;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onConnectError = onConnectError;
    /** The open (logged in) connection: { id, socket, reader, closed, lastByteAt, asc }. */
    this.conn = undefined;
    this.opening = undefined;
    this.closing = undefined;
    this.deadStreak = 0;
    this.lastConnectAt = -Infinity;
    this.backoff = undefined;
    this.trying = false;
    this.clickAt = -Infinity;
    this.clickTryAt = -Infinity;
    this.closeWait = undefined;
    this.connSeq = 0;
    this.queue = [];
    this.inFlight = undefined;
    this.cutTimer = undefined;
    this.beatTimer = undefined;
    this.pumping = false;
    this.again = false;
    this.seq = 0;
    this.loginSeq = 0;
    this.stopped = false;
  }

  get isOpen() {
    return this.conn !== undefined && !this.conn.closed;
  }

  get busy() {
    return this.inFlight !== undefined;
  }

  /** The tag of the light in a log line: its first 8 characters (never the address key). */
  get tag() {
    return String(this.light.id).slice(0, 8);
  }

  // --- Connection ------------------------------------------------------------

  /** Opens and logs in (shared), bounded by the connect and login timeouts and `deadline`. */
  open(deadline = Infinity, { hurry = false } = {}) {
    if (this.stopped) return Promise.reject(new LinkError('stopped'));
    if (this.isOpen) return Promise.resolve(this.conn);
    if (hurry) this.hurry(this.monotonic());
    if (!this.opening) {
      this.opening = this.connectNow().finally(() => {
        this.opening = undefined;
      });
    }
    const left = deadline - this.monotonic();
    if (left <= 0) return Promise.reject(new LinkError('late', { detail: 'no time left' }));
    if (left >= TIMINGS.connectTimeout + TIMINGS.loginTimeout) return this.opening;
    let timer;
    return Promise.race([
      this.opening,
      new Promise((_, reject) => {
        timer = this.timers.setTimeout(
          () => reject(new LinkError('late', { detail: 'no time left to connect' })),
          left,
        );
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  async connectNow() {
    if (this.closing) await this.closing;
    for (;;) {
      if (this.stopped) throw new LinkError('stopped');
      const mono = this.monotonic();
      const wait = this.connectWait(mono);
      if (wait <= 0) {
        if (this.clicked(mono)) this.clickTryAt = mono;
        this.clickAt = -Infinity;
        this.lastConnectAt = mono;
        break;
      }
      await new Promise((resolve) => {
        this.backoff = { resolve, timer: this.timers.setTimeout(() => this.endBackoff(), wait) };
      });
    }
    this.trying = true;
    try {
      return await this.connectSocket();
    } finally {
      this.trying = false;
    }
  }

  /** The wait before the next connection (ms), `mono` read once (see the header). */
  connectWait(mono) {
    const wait = this.reopenWait(mono);
    if (wait <= 0 || !this.clicked(mono)) return wait;
    return Math.min(wait, Math.max(0, this.clickTryAt + TIMINGS.reopenFirst - mono));
  }

  /** The pause after dead connections still to wait (ms): 0 after a connection that logged in. */
  reopenWait(mono = this.monotonic()) {
    if (this.deadStreak === 0) return 0;
    const pause = Math.min(TIMINGS.reopenFirst * 2 ** (this.deadStreak - 1), TIMINGS.reopenMax);
    return Math.max(0, this.lastConnectAt + pause - mono);
  }

  clicked(mono) {
    return mono - this.clickAt <= TIMINGS.reopenMax;
  }

  /** A click asks for its connection now (once; a try in progress or an open connection serves it). */
  hurry(mono) {
    if (this.isOpen || this.trying) return;
    this.clickAt = mono;
    this.endBackoff();
  }

  endBackoff() {
    const backoff = this.backoff;
    if (!backoff) return;
    this.backoff = undefined;
    this.timers.clearTimeout(backoff.timer);
    backoff.resolve();
  }

  connectSocket() {
    return new Promise((resolve, reject) => {
      let socket;
      let timer;
      let done = false;
      let conn;
      const fail = (err) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        if (conn) conn.closed = true;
        try {
          socket?.destroy();
        } catch {
          // already gone
        }
        this.deadStreak += 1;
        try {
          this.onConnectError(err);
        } catch {
          // the app's own problem
        }
        reject(err);
      };
      try {
        socket = this.connectFn({ host: this.host, port: this.port });
      } catch (err) {
        fail(new LinkError('network', { detail: err?.code ?? 'error' }));
        return;
      }
      socket.on('error', () => {});
      timer = this.timers.setTimeout(
        () => fail(new LinkError('network', { detail: 'connect timeout' })),
        TIMINGS.connectTimeout,
      );
      socket.once('error', (err) =>
        fail(new LinkError('network', { detail: err?.code ?? 'error' })),
      );
      socket.once('close', () => fail(new LinkError('closed', { detail: 'closed at login' })));
      socket.once('connect', () => {
        if (done) return;
        this.timers.clearTimeout(timer);
        if (this.stopped) {
          fail(new LinkError('stopped'));
          return;
        }
        conn = {
          id: ++this.connSeq,
          socket,
          reader: frameReader(LIMITS.frameBytes),
          closed: false,
          lastByteAt: this.monotonic(),
          lastSendAt: this.monotonic(),
          asc: 1,
          loggedIn: false,
        };
        const loginSeq = String(Math.floor(this.now()) + this.loginSeq++).slice(-9);
        // The login: the first frame back must open with the key of this light and say 200.
        socket.on('data', (chunk) => {
          if (conn.closed) return;
          if (!conn.loggedIn) {
            let frames;
            try {
              frames = conn.reader.push(chunk);
            } catch {
              fail(new LinkError('identity', { detail: 'not an AiDot frame' }));
              return;
            }
            if (frames.length === 0) return;
            const json = openBody(frames[0].body, this.light.key);
            const message = json ? readMessage(json) : undefined;
            if (!message) {
              fail(new LinkError('identity', { detail: 'the answer does not open with the key' }));
              return;
            }
            if (message.deviceId !== undefined && message.deviceId !== this.light.id) {
              fail(new LinkError('identity', { detail: 'another light answers' }));
              return;
            }
            if (message.code !== 200) {
              fail(new LinkError('login', { detail: `code ${message.code ?? 'none'}` }));
              return;
            }
            done = true;
            this.timers.clearTimeout(timer);
            conn.loggedIn = true;
            conn.asc = message.ascNumber !== undefined ? message.ascNumber + 1 : 1;
            conn.lastByteAt = this.monotonic();
            this.deadStreak = 0;
            this.conn = conn;
            socket.on('error', () => this.drop(conn, 'closed'));
            socket.on('end', () => this.drop(conn, 'closed'));
            socket.on('close', () => {
              conn.socketClosed = true;
              this.drop(conn, 'closed');
            });
            try {
              this.onOpen(conn);
            } catch (err) {
              this.logger?.warn?.(`aidot: open handler failed (${err?.name ?? 'Error'})`);
            }
            resolve(conn);
            // Frames glued behind the login answer.
            this.handleFrames(conn, frames.slice(1));
            this.armBeat();
            this.pump();
            return;
          }
          this.onData(conn, chunk);
        });
        timer = this.timers.setTimeout(
          () => fail(new LinkError('timeout', { detail: 'no answer to the login' })),
          TIMINGS.loginTimeout,
        );
        try {
          socket.write(
            encodeMessage(
              loginRequest({
                seq: loginSeq,
                userId: this.userId,
                deviceId: this.light.id,
                password: this.light.password,
                now: this.now(),
              }),
              this.light.key,
            ),
          );
        } catch {
          fail(new LinkError('closed', { detail: 'write failed' }));
        }
      });
    });
  }

  /** Closes `conn` (the current one only): the request in flight on it ends as cut / closed. */
  drop(conn, reason) {
    if (!conn || conn.closed) return;
    conn.closed = true;
    if (this.conn === conn) this.conn = undefined;
    const closing = new Promise((resolve) => {
      if (conn.socketClosed) {
        resolve();
        return;
      }
      const wait = {
        resolve,
        timer: this.timers.setTimeout(() => this.endCloseWait(wait), CLOSE_WAIT),
      };
      this.closeWait = wait;
      conn.socket.once?.('close', () => this.endCloseWait(wait));
    }).finally(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    try {
      conn.socket.destroy();
    } catch {
      // already gone
    }
    this.clearBeat();
    this.cancel(
      (j) => j.priority === PRIORITY.READ,
      () => new LinkError('closed', { detail: 'connection closed' }),
    );
    const job = this.inFlight;
    if (job && job.conn === conn) {
      this.finish(job, null, new LinkError(reason === 'cut' ? 'cut' : 'closed', { sent: true }));
    }
    this.clearCut();
    try {
      this.onClose(conn, reason);
    } catch (err) {
      this.logger?.warn?.(`aidot: close handler failed (${err?.name ?? 'Error'})`);
    }
    this.pump();
  }

  endCloseWait(wait) {
    if (this.closeWait === wait) this.closeWait = undefined;
    this.timers.clearTimeout(wait.timer);
    wait.resolve();
  }

  close(reason = 'closed') {
    this.drop(this.conn, reason);
  }

  onData(conn, chunk) {
    if (conn.closed) return;
    conn.lastByteAt = this.monotonic();
    let frames;
    try {
      frames = conn.reader.push(chunk);
    } catch {
      this.logger?.warn?.(`aidot: ${this.tag}: a frame not understood or too large, closed`);
      this.drop(conn, 'size');
      return;
    }
    this.handleFrames(conn, frames);
    if (!conn.closed) {
      this.armCut();
      this.armBeat();
    }
  }

  handleFrames(conn, frames) {
    for (const frame of frames) {
      if (conn.closed) return;
      const json = openBody(frame.body, this.light.key);
      const message = json ? readMessage(json) : undefined;
      if (!message) continue;
      if (message.ascNumber !== undefined) conn.asc = message.ascNumber;
      this.handle(conn, message);
    }
  }

  handle(conn, message) {
    const job = this.inFlight;
    const answers =
      job &&
      job.conn === conn &&
      ((message.seq !== undefined && message.seq === job.seq) ||
        (message.seq === undefined && message.method === job.method.replace(/Req$/, 'Resp')));
    if (answers) {
      if (message.code !== undefined && message.code !== 200) {
        this.finish(
          job,
          null,
          new LinkError('refused', {
            sent: true,
            deviceCode: message.code,
            detail: `code ${message.code}`,
          }),
        );
        try {
          this.onMessage(message, conn, job);
        } catch (err) {
          this.logger?.warn?.(`aidot: message not handled (${err?.name ?? 'Error'})`);
        }
        return;
      }
      try {
        job.onAnswer?.(message);
      } catch (err) {
        this.logger?.warn?.(`aidot: answer handler failed (${err?.name ?? 'Error'})`);
      }
      try {
        this.onMessage(message, conn, job);
      } catch (err) {
        this.logger?.warn?.(`aidot: message not handled (${err?.name ?? 'Error'})`);
      }
      this.finish(job, message);
      return;
    }
    try {
      this.onMessage(message, conn, undefined);
    } catch (err) {
      this.logger?.warn?.(`aidot: message not handled (${err?.name ?? 'Error'})`);
    }
  }

  // --- Heartbeat -------------------------------------------------------------

  /** Idle for a heartbeat: one is written (no request in flight); 3 without a byte close it. */
  armBeat() {
    this.clearBeat();
    const conn = this.conn;
    if (!conn || this.stopped || this.light.modelId === LOCAL.firstGeneration) return;
    const mono = this.monotonic();
    const quiet = mono - conn.lastByteAt;
    if (quiet >= TIMINGS.heartbeat * TIMINGS.heartbeatMisses) {
      this.logger?.warn?.(`aidot: ${this.tag}: no byte for 90 s, connection closed`);
      this.drop(conn, 'closed');
      return;
    }
    const idleSince = Math.max(conn.lastByteAt, conn.lastSendAt);
    const wait = Math.max(0, idleSince + TIMINGS.heartbeat - mono);
    this.beatTimer = this.timers.setTimeout(() => {
      this.beatTimer = undefined;
      if (this.conn !== conn || conn.closed) return;
      const at = this.monotonic();
      if (at - conn.lastByteAt >= TIMINGS.heartbeat * TIMINGS.heartbeatMisses) {
        this.armBeat();
        return;
      }
      if (!this.inFlight && this.queue.length === 0 && at - conn.lastSendAt >= TIMINGS.heartbeat) {
        try {
          conn.socket.write(encodeMessage(pingRequest(), this.light.key, LOCAL.HEARTBEAT));
          conn.lastSendAt = at;
        } catch {
          this.drop(conn, 'closed');
          return;
        }
      }
      this.armBeat();
    }, wait);
  }

  clearBeat() {
    if (this.beatTimer !== undefined) this.timers.clearTimeout(this.beatTimer);
    this.beatTimer = undefined;
  }

  /** No byte from the light for 3 heartbeats (the app checks it for the first generation). */
  silentFor(mono = this.monotonic()) {
    return this.conn ? mono - this.conn.lastByteAt : 0;
  }

  // --- Requests --------------------------------------------------------------

  /**
   * Queues a `getDevAttrReq` (`method: 'get'`) or a `setDevAttrReq` (`method: 'set'`) with
   * `attr`; resolves with the answer (or rejects with a LinkError). Options: priority,
   * deadline (monotonic: not sent after it, not awaited after it), timeout (the answer),
   * beforeSend, onSent(at, seq), onAnswer(message) (synchronous), tag, hurry.
   */
  request(
    { method, attr },
    { priority = PRIORITY.READ, deadline, timeout, beforeSend, onSent, onAnswer, tag, hurry } = {},
  ) {
    if (this.stopped) return Promise.reject(new LinkError('stopped'));
    return new Promise((resolve, reject) => {
      const job = {
        method: method === 'set' ? 'setDevAttrReq' : 'getDevAttrReq',
        attr,
        priority,
        deadline:
          deadline ??
          this.monotonic() + TIMINGS.readTimeout + TIMINGS.connectTimeout + TIMINGS.loginTimeout,
        timeout: timeout ?? (method === 'set' ? TIMINGS.answerTimeout : TIMINGS.readTimeout),
        beforeSend,
        onSent,
        onAnswer,
        tag,
        seq: undefined,
        order: ++this.seq,
        resolve,
        reject,
        conn: undefined,
        timer: undefined,
        sentAt: undefined,
      };
      const at = this.queue.findIndex((j) => j.priority < priority);
      if (at === -1) this.queue.push(job);
      else this.queue.splice(at, 0, job);
      if (hurry) this.hurry(this.monotonic());
      this.pump();
      this.armCut();
    });
  }

  /** Removes the queued (not sent) requests for which `match(job)` is true; each rejected with `error`. */
  cancel(match, error) {
    for (const job of [...this.queue]) {
      if (match(job)) {
        this.queue.splice(this.queue.indexOf(job), 1);
        job.reject(typeof error === 'function' ? error(job) : error);
      }
    }
  }

  finish(job, answer, error) {
    if (this.inFlight !== job) return;
    this.inFlight = undefined;
    this.timers.clearTimeout(job.timer);
    this.clearCut();
    if (error) job.reject(error);
    else job.resolve(answer);
    this.pump();
  }

  pump() {
    if (this.stopped) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    this.again = false;
    this.pumpNow()
      .catch((err) => this.logger?.warn?.(`aidot: line error (${err?.name ?? 'Error'})`))
      .finally(() => {
        this.pumping = false;
        if (this.again && !this.stopped) this.pump();
      });
  }

  async pumpNow() {
    while (!this.inFlight && this.queue.length > 0 && !this.stopped) {
      const job = this.queue[0];
      const mono = this.monotonic();
      if (mono >= job.deadline) {
        this.queue.shift();
        job.reject(new LinkError('late', { detail: 'not sent in time' }));
        continue;
      }
      if (!this.isOpen) {
        if (job.priority === PRIORITY.READ) {
          this.queue.shift();
          job.reject(new LinkError('network', { detail: 'not connected' }));
          continue;
        }
        try {
          await this.open(job.deadline);
        } catch (err) {
          const failed = err instanceof LinkError ? err : new LinkError('network');
          for (const j of this.queue.splice(0)) j.reject(failed);
          return;
        }
        continue;
      }
      this.queue.shift();
      try {
        job.beforeSend?.();
      } catch (err) {
        job.reject(err);
        continue;
      }
      const conn = this.conn;
      const at = this.monotonic();
      job.seq = `${LOCAL.seqPrefix}${String(job.order % 100000).padStart(5, '0')}`;
      let frame;
      try {
        frame = encodeMessage(
          actionRequest({
            method: job.method,
            userId: this.userId,
            deviceId: this.light.id,
            password: this.light.password,
            ascNumber: conn.asc,
            attr: typeof job.attr === 'function' ? job.attr() : job.attr,
            seq: job.seq,
            simpleVersion: this.light.simpleVersion,
            tst: Math.floor(this.now()),
          }),
          this.light.key,
        );
        conn.socket.write(frame);
      } catch {
        job.reject(new LinkError('closed', { detail: 'write failed' }));
        this.drop(conn, 'closed');
        continue;
      }
      job.conn = conn;
      job.sentAt = at;
      conn.lastSendAt = at;
      this.inFlight = job;
      try {
        job.onSent?.(at, job.seq);
      } catch (err) {
        this.logger?.warn?.(`aidot: sent handler failed (${err?.name ?? 'Error'})`);
      }
      const wait = Math.max(0, Math.min(job.timeout, job.deadline - at));
      job.timer = this.timers.setTimeout(() => {
        this.finish(job, null, new LinkError('timeout', { sent: true }));
      }, wait);
      this.armCut();
    }
  }

  /** An Off waits behind a request in flight (or another Off behind a silent Off): cut it once stuck. */
  armCut() {
    this.clearCut();
    const job = this.inFlight;
    if (!job) return;
    if (!this.queue.some((j) => j.priority === PRIORITY.PROTECTIVE)) return;
    const conn = job.conn;
    const quietSince = Math.max(job.sentAt, conn.lastByteAt);
    const wait = Math.max(0, quietSince + TIMINGS.stuck - this.monotonic());
    this.cutTimer = this.timers.setTimeout(() => {
      this.cutTimer = undefined;
      if (this.inFlight !== job || conn.closed) return;
      this.logger?.info?.(`aidot: ${this.tag}: a request without answer cut for an Off`);
      this.drop(conn, 'cut');
    }, wait);
  }

  clearCut() {
    if (this.cutTimer !== undefined) {
      this.timers.clearTimeout(this.cutTimer);
      this.cutTimer = undefined;
    }
  }

  stop() {
    this.stopped = true;
    this.clearCut();
    this.clearBeat();
    this.endBackoff();
    if (this.closeWait) this.endCloseWait(this.closeWait);
    for (const job of this.queue.splice(0)) job.reject(new LinkError('stopped'));
    const job = this.inFlight;
    if (job) {
      this.inFlight = undefined;
      this.timers.clearTimeout(job.timer);
      job.reject(new LinkError('stopped', { sent: true }));
    }
    if (this.conn) {
      const conn = this.conn;
      conn.closed = true;
      this.conn = undefined;
      try {
        conn.socket.destroy();
      } catch {
        // already gone
      }
    }
  }
}
