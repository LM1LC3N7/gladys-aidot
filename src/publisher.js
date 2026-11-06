// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute.
//
// push(): the current value of a feature. The last one wins; unchanged values
// are skipped by publishChangedStates and sent again every 30 min. Everything
// left over (budget spent, Gladys unreachable) waits for the next flush,
// every second. Taken from gladys-deako 0.1.1 (approved, same author).
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, now = Date.now, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    this.stateWindow = [];
    this.timer = undefined;
    this.flushing = undefined;
    this.again = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forgets what is pending for a deleted device and its features. */
  forget(deviceId) {
    for (const id of [...this.pending.keys()]) {
      if (id === deviceId || id.startsWith(`${deviceId}:`)) {
        this.pending.delete(id);
      }
    }
  }

  /** One flush at a time; a flush asked during another one runs right after it. */
  flush() {
    if (this.flushing) {
      this.again ??= this.flushing
        .catch(() => {})
        .then(() => {
          this.again = undefined;
          return this.flush();
        });
      return this.again;
    }
    this.flushing = this.flushStates().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  async flushStates() {
    const now = this.now();
    this.stateWindow = this.stateWindow.filter((t) => now - t < MINUTE);
    const room = Math.min(
      LIMITS.statesPerMinute - this.stateWindow.length,
      LIMITS.statesPerRequest,
    );
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.stateWindow.push(now);
      }
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
