// -----------------------------------------------------------------------------
// The AiDot account of the configuration (the cloud, src/cloud.js: the list
// of the lights with their address and keys) and each light added in Gladys
// on the local network (one TCP connection per light, src/link.js): states,
// commands, Offs held, Discover, "Test the connection". index.js only wires
// the SDK handlers (src/handlers.js).
//
// Cloud: read at start (never sooner than a minute after the read before,
// the time of the attempt in /data before it), every 6 h, at Discover and on
// "Test the connection" (a minute apart at least, but a click or new
// credentials). Only the sign-in route can refuse the credentials (code
// 560080): the refusal is kept in /data (a fingerprint of the account and a
// 6-bit mark of the password) and the password is never posted again by
// itself, until new credentials are saved or the button is clicked. 429 /
// 5xx pause the cloud (60 s doubled up to 6 h, or the Retry-After), in /data.
// The tokens, the user id and the keys of the lights stay in memory.
//
// States: a read (getDevAttrReq) when a connection opens and every poll
// interval, and the attributes the light pushes between. Order: every request
// we send and every push received takes the next `tick`; a light remembers the
// tick of its last push or command (`mark`). The answer to a read applies its
// state only if the read left after that mark.
//
// Offs (power 0, brightness 0) are protective: once the light is known (its key
// in memory), never held by a command or a read in flight (cut once stuck 1 s),
// the configuration not read, a cloud pause or refusal, a connection that fails. Clicked, an Off cancels the
// commands of that light still waiting, skips the pause after dead
// connections on its first send (one connection per click), is tried again
// for 250 ms, then kept (a guard, in /data):
//   - not sent (the light not known yet: its key comes from the cloud; no
//     connection), or sent without an answer: sent again every 10 s (the
//     probe, which also opens the connection), as soon as a connection opens
//     and as soon as the cloud gives the light, never given up;
//   - answered: a read sent right after judges it: off = done; still on (a
//     read or a report of the light) = sent again 10 s after the last send
//     (4 answered tries at most, then the status says it; a new click starts
//     again). A report equal to the state of before never ends it.
// A guard ends when the light is seen off, a newer command of the light left,
// or the device is deleted. After a restart the key of a light comes from the
// cloud first: the read an Off held needs waits a pause 10 min at most and a
// failed read a minute; it cannot happen while the credentials are refused,
// the cloud does not answer or the configuration cannot be read.
//
// Non-protective commands (on, brightness 1-100, colour, temperature) leave
// in line on the connection of the light, those of one light merged while
// waiting (a scene); the ack comes by 3.5 s: done (a state after the send
// shows what was asked, answered by the light or changed from before), or the
// reason. One still waiting then stays in line up to 30 s, and never leaves
// after an Off of its light.
//
// Two clocks: `now` (wall) dates /data and the messages only; `monotonic`
// paces everything else (reads, retries, deadlines, the publication budget).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { accountKeyOf, credentialsChanged, normalizeConfig, passwordMarkOf } from './config.js';
import { CloudClient, CloudError } from './cloud.js';
import { DISCOVERY, FEATURES as F, LIMITS, LOCAL, PRIORITY, TIMINGS } from './constants.js';
import { buildDevice, parseExternalId, valuesOf } from './devices.js';
import { LightLink, LinkError } from './link.js';
import { lanAddress, lightOf } from './model.js';
import { attrOf, discoveryPayload, readDiscovery } from './protocol.js';
import {
  ERRORS,
  T,
  age,
  both,
  cloudReasonOf,
  deviceName,
  reasonOf,
  shortId,
  word,
} from './i18n.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory } from './store.js';

/** A status is cut to this length (Gladys shows one block). */
const STATUS_MAX = 900;
/** Sequence numbers of past requests remembered per light (late answers). */
const PAST_SEQS = 32;

/** A value of Gladys as an integer; undefined when it is not one (never '' as 0). */
export function integerOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d{1,9}\s*$/.test(value)) return Number(value);
  return undefined;
}

/** A command of Gladys -> `{ protective: true }` | `{ target }`; undefined when invalid. */
export function commandOf(key, value) {
  if (value === undefined) return undefined;
  if (key === F.POWER) {
    if (value === 0) return { protective: true };
    if (value === 1) return { target: { power: true } };
    return undefined;
  }
  if (key === F.BRIGHTNESS) {
    if (value === 0) return { protective: true };
    if (value >= 1 && value <= 100) return { target: { power: true, dim: value } };
    return undefined;
  }
  if (key === F.COLOR) {
    if (value >= 1 && value <= 0xffffff) return { target: { power: true, rgb: value } };
    return undefined;
  }
  if (key === F.TEMPERATURE) {
    if (value >= 1000 && value <= 10000) return { target: { power: true, cct: value } };
    return undefined;
  }
  return undefined;
}

/** True when `state` shows every field of `target`. */
export function shows(target, state) {
  if (!state) return false;
  for (const key of ['power', 'dim', 'rgb', 'cct']) {
    if (target[key] !== undefined && state[key] !== target[key]) return false;
  }
  return true;
}

/** A target within the capabilities of `light`; the reason (an ERRORS entry) otherwise. */
export function targetError(target, light) {
  if (
    target.dim !== undefined &&
    !(Number.isInteger(target.dim) && target.dim >= 1 && target.dim <= 100)
  )
    return ERRORS.badValue;
  if (target.rgb !== undefined) {
    if (!(Number.isInteger(target.rgb) && target.rgb >= 1 && target.rgb <= 0xffffff))
      return ERRORS.badValue;
    if (light.caps.known && !light.caps.color) return ERRORS.notSupported;
  }
  if (target.cct !== undefined) {
    const range = light.caps.cct;
    if (!range) return ERRORS.notSupported;
    if (!(Number.isInteger(target.cct) && target.cct >= range.min && target.cct <= range.max))
      return ERRORS.outOfRange(range.min, range.max);
  }
  return undefined;
}

export class App {
  constructor({
    gladys,
    logger = createLogger({ name: 'aidot' }),
    connect,
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    publisher,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = publisher ?? new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.configLoading = undefined;
    this.configLoader = undefined;
    this.lastConfigAsk = -Infinity;
    this.memory = emptyMemory();
    this.memoryLoaded = false;
    this.memoryLoading = undefined;
    this.storeUnreadable = false;
    this.storeTimer = undefined;
    this.saveFailed = false;
    this.saving = undefined;
    this.saveTickets = 0;
    this.storeReading = undefined;
    /** The cloud: the client of the credentials of the configuration, its state. */
    this.cloud = undefined;
    this.userId = undefined;
    /** A user's act allows the password to be posted despite a refusal kept (new credentials, a click). */
    this.mayPost = false;
    this.signedInOk = false;
    this.cloudReading = undefined;
    this.cloudTimer = undefined;
    this.cloudDueAt = undefined;
    this.lastCloudAt = undefined;
    this.cloudOkAt = undefined;
    this.cloudFailures = 0;
    this.cloudError = undefined;
    this.cloudRetryAt = undefined;
    this.pauseUntil = undefined;
    this.pauseStep = 0;
    this.lastTestAt = -Infinity;
    this.lastDiscoveryAt = -Infinity;
    this.discoveryTimer = undefined;
    this.tooMany = false;
    this.lightCount = 0;
    /** id -> the entry of a light (known from the cloud, from Gladys, or from a guard). */
    this.lights = new Map();
    /** id -> guard of an Off. */
    this.guards = new Map();
    this.probeTimer = undefined;
    /** id -> the non-protective command of the light not sent yet (merged). */
    this.waiting = new Map();
    /** id -> Set of watchers of the states of the light ({ onState(state) }). */
    this.watchers = new Map();
    this.tick = 0;
    this.seq = 0;
    this.ready = false;
    this.readyWaiters = new Set();
    this.lifecycle = Promise.resolve();
    this.configSeq = 0;
    this.lastStatus = undefined;
    this.published = undefined;
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connected to Gladys (each time): /data read (once), then the configuration read (`load`,
   * the SDK's getConfig), read again on failure (5 s, 15 s, then every minute) with a status.
   */
  async onConnected(load) {
    this.configLoader = load;
    this.publisher.start();
    await this.ensureMemory();
    this.configTries = 0;
    this.clearConfigTimer();
    await this.loadConfig();
  }

  loadConfig() {
    if (!this.configLoading) {
      this.configLoading = this.loadConfigNow().finally(() => {
        this.configLoading = undefined;
      });
    }
    return this.configLoading;
  }

  /** A command came before the configuration: read it now, or 2 s after the last read at most. */
  askConfig() {
    if (!this.configLoader || this.configLoading) return;
    const wait = Math.max(0, this.lastConfigAsk + TIMINGS.configAskGap - this.monotonic());
    this.clearConfigTimer();
    this.configTimer = this.timers.setTimeout(() => {
      this.configTimer = undefined;
      return this.loadConfig().catch(() => {});
    }, wait);
  }

  async loadConfigNow() {
    const generation = ++this.configGeneration;
    this.lastConfigAsk = this.monotonic();
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) return;
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `aidot: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      // Not awaited: a slow Gladys never delays the next read of the configuration.
      this.setStatus(false, T.configNotRead(age(wait))).catch(() => {});
      return;
    }
    if (generation !== this.configGeneration) return;
    this.configTries = 0;
    await this.connected(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** The configuration read at a connection to Gladys (a reconnection resends what Gladys forgot). */
  connected(raw = {}) {
    return this.enqueue(raw, true);
  }

  /** A configuration saved by the user. */
  configUpdated(raw = {}) {
    return this.enqueue(raw, false);
  }

  /** One configuration at a time, in order; one superseded by a newer one still waiting is skipped. */
  enqueue(raw, reconnection) {
    const seq = ++this.configSeq;
    const job = async () => {
      if (seq === this.configSeq) await this.startSession(raw, { saved: !reconnection });
      if (reconnection) {
        this.gladys.forgetPublishedStates?.();
        this.published = undefined;
        const status = this.lastStatus;
        this.lastStatus = undefined;
        if (status) {
          const [connected, message] = JSON.parse(status);
          await this.setStatus(connected, message ?? undefined);
        }
        await this.publishDevices();
      }
    };
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch((err) =>
      this.logger.error(`aidot: configuration not applied (${err?.name ?? 'Error'})`),
    );
    return this.lifecycle;
  }

  /**
   * A session: the cloud client of the credentials typed (kept when they did not change), the
   * lights it knows kept. New credentials saved by the user may be posted at once, even after
   * a refusal.
   */
  async startSession(raw, { saved }) {
    await this.ensureMemory();
    const config = normalizeConfig(raw);
    const changed = !this.configLoaded || credentialsChanged(config, this.config);
    this.config = config;
    this.configLoaded = true;
    if (config.error) {
      this.dropCloud();
    } else if (changed || !this.cloud) {
      this.dropCloud();
      this.cloud = new CloudClient({
        transport: this.transport,
        account: { email: config.email, password: config.password, country: config.country },
        terminalId: this.memory.terminal,
      });
      // Saved by the user with other credentials: tried at once (a refusal kept is for the
      // credentials refused, never for new ones).
      if (saved) this.mayPost = true;
    }
    this.setReady();
    this.scheduleCloud({ soon: changed && saved });
    await this.refreshStatus();
    await this.publishDevices();
    for (const entry of this.lights.values()) this.scheduleRead(entry);
  }

  setReady() {
    this.ready = true;
    for (const resolve of this.readyWaiters) resolve(true);
    this.readyWaiters.clear();
  }

  /** Resolves true once a session started, false at `deadline` (monotonic). */
  waitReady(deadline) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        this.timers.clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = this.timers.setTimeout(
        () => done(false),
        Math.max(0, deadline - this.monotonic()),
      );
      this.readyWaiters.add(done);
    });
  }

  stop() {
    this.stopped = true;
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.publisher.stop();
    for (const name of ['probeTimer', 'cloudTimer', 'discoveryTimer', 'storeTimer']) {
      if (this[name] !== undefined) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
    for (const set of [...this.watchers.values()]) for (const watcher of [...set]) watcher.end();
    for (const guard of this.guards.values()) guard.end?.('stopped');
    for (const done of [...this.readyWaiters]) done(false);
    for (const entry of this.lights.values()) {
      if (entry.followTimer !== undefined) this.timers.clearTimeout(entry.followTimer);
      entry.followTimer = undefined;
      this.dropLink(entry);
    }
  }

  /** The container stops: /data written (bounded), then every timer and connection. */
  async shutdown() {
    this.configGeneration += 1;
    this.clearConfigTimer();
    await this.saveMemory();
    this.stop();
  }

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  // --- /data -------------------------------------------------------------------

  /** `{ value }` once `promise` settles within `ms`, `{ late: true }` otherwise. */
  bounded(promise, ms = TIMINGS.storeWait) {
    let timer;
    return Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve({ late: true }), Math.max(0, ms));
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  /** One read of /data at a time, waited TIMINGS.storeWait at most from its start. */
  loadStore() {
    let entry = this.storeReading;
    if (!entry) {
      let promise;
      try {
        promise = Promise.resolve(this.store.load());
      } catch (err) {
        promise = Promise.reject(err);
      }
      entry = { at: this.monotonic(), promise };
      this.storeReading = entry;
      promise
        .catch(() => {})
        .finally(() => {
          if (this.storeReading === entry) this.storeReading = undefined;
        });
    }
    const left = entry.at + TIMINGS.storeWait - this.monotonic();
    if (left <= 0) return Promise.resolve({ late: true });
    return this.bounded(entry.promise, left);
  }

  /** /data read once (bounded): unreadable is not empty, nothing is written over it. */
  ensureMemory() {
    if (this.memoryLoaded) return Promise.resolve();
    this.memoryLoading ??= (async () => {
      let loaded = null;
      try {
        const answer = await this.loadStore();
        if (answer.late) throw Object.assign(new Error('no answer'), { code: 'timeout' });
        loaded = answer.value;
        this.storeUnreadable = false;
      } catch (err) {
        this.storeUnreadable = true;
        this.logger.warn(`aidot: /data unreadable (${err?.code ?? err?.name ?? 'error'})`);
        this.armStoreRetry();
      }
      this.adoptMemory(normalizeMemory(loaded, this.now()));
      this.memoryLoaded = true;
      if (!this.storeUnreadable && (!loaded?.salt || !loaded?.terminal)) this.saveSoon();
    })().finally(() => {
      this.memoryLoading = undefined;
    });
    return this.memoryLoading;
  }

  /** /data unreadable: read again on a timer of its own (one read at a time), until it reads. */
  armStoreRetry() {
    if (this.storeTimer !== undefined || this.stopped) return;
    this.storeTimer = this.timers.setTimeout(() => {
      this.storeTimer = undefined;
      if (!this.storeUnreadable || this.stopped) return;
      this.reloadMemory()
        .catch(() => false)
        .then((ok) => {
          if (!ok) this.armStoreRetry();
        });
    }, TIMINGS.storeRetry);
  }

  /**
   * What /data holds, merged with what this process already knows (which wins): the guards
   * clicked meanwhile, a session accepted meanwhile, the salt and terminal id in use.
   */
  adoptMemory(saved) {
    const kept = this.memory;
    const mono = this.monotonic();
    const now = this.now();
    this.memory = saved;
    const salt = saved.salt ?? kept.salt ?? randomBytes(16).toString('hex');
    this.memory.salt = salt;
    this.memory.terminal ??= kept.terminal ?? randomBytes(16).toString('hex');
    if (kept.refused && kept.salt !== salt && !this.config.error) {
      // Made with the salt of this process: made again with the salt of /data.
      kept.refused = {
        account: accountKeyOf(this.config, salt),
        mark: passwordMarkOf(this.config.password, salt),
      };
    }
    if (this.signedInOk) this.memory.refused = undefined;
    else if (kept.refused && !saved.refused) this.memory.refused = kept.refused;
    if (saved.pause?.until !== undefined) {
      const until = mono + (saved.pause.until - now);
      if (this.pauseUntil === undefined || until > this.pauseUntil) this.pauseUntil = until;
    }
    if (saved.pause) this.pauseStep = Math.max(this.pauseStep, saved.pause.step);
    if (saved.lastCloudAt !== undefined) {
      const at = mono - (now - saved.lastCloudAt);
      if (this.lastCloudAt === undefined || at > this.lastCloudAt) this.lastCloudAt = at;
    }
    for (const g of saved.guards) {
      if (!this.guards.has(g.id)) this.guards.set(g.id, this.makeGuard(g));
    }
  }

  /** /data reads again after it could not be read; true once it reads. */
  async reloadMemory() {
    let answer;
    try {
      answer = await this.loadStore();
    } catch {
      return false;
    }
    if (answer.late) return false;
    if (!this.storeUnreadable) return true;
    this.storeUnreadable = false;
    this.adoptMemory(normalizeMemory(answer.value, this.now()));
    this.logger.info('aidot: /data reads again');
    this.sendPendingGuards();
    this.armProbe();
    this.saveSoon();
    this.refreshStatus().catch(() => {});
    return true;
  }

  /** The pace, the pause and the guards into the memory written to /data. */
  syncMemory() {
    const now = this.now();
    const mono = this.monotonic();
    if (this.lastCloudAt !== undefined) {
      this.memory.lastCloudAt = Math.min(now, now - (mono - this.lastCloudAt));
    }
    if (this.pauseUntil !== undefined && this.pauseUntil > mono) {
      this.memory.pause = { until: now + (this.pauseUntil - mono), step: this.pauseStep };
    } else {
      this.memory.pause =
        this.pauseStep > 0 ? { until: undefined, step: this.pauseStep } : undefined;
    }
    this.memory.guards = [...this.guards.values()].slice(0, LIMITS.guards).map((g) => ({
      id: g.id,
      left: g.left,
      tries: g.tries,
      ...(g.okSeen ? { accepted: true } : {}),
    }));
  }

  /** true when /data holds the state of now; bounded, one save at a time (gladys-deako 0.1.1). */
  async saveMemory() {
    if (!this.memoryLoaded) return false;
    if (this.storeUnreadable && !(await this.reloadMemory())) return false;
    const ticket = ++this.saveTickets;
    for (;;) {
      const entry = this.saving ?? this.startSave();
      const left = entry.at + TIMINGS.storeWait - this.monotonic();
      const answer = left <= 0 ? { late: true } : await this.bounded(entry.done, left);
      if (answer.late) {
        if (this.saving === entry) this.saving = undefined;
        return this.storeFailed({ code: 'timeout' });
      }
      if (entry.ticket >= ticket) {
        return answer.value === true ? this.storeWritten() : this.storeFailed(answer.value);
      }
    }
  }

  startSave() {
    this.syncMemory();
    let promise;
    try {
      promise = Promise.resolve(this.store.save(this.memory));
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry = { at: this.monotonic(), ticket: this.saveTickets };
    entry.done = promise
      .then(
        () => true,
        (err) => err ?? { code: 'error' },
      )
      .finally(() => {
        if (this.saving !== entry) return;
        this.saving = undefined;
        if (this.saveTickets > entry.ticket) this.saveMemory().catch(() => {});
      });
    this.saving = entry;
    return entry;
  }

  storeWritten() {
    if (this.saveFailed) {
      this.saveFailed = false;
      this.logger.info('aidot: /data written again');
      this.refreshStatus().catch(() => {});
    }
    return true;
  }

  storeFailed(err) {
    if (!this.saveFailed) {
      this.saveFailed = true;
      this.logger.warn(
        `aidot: saving the state to /data failed (${err?.code ?? err?.name ?? 'error'})`,
      );
      this.refreshStatus().catch(() => {});
    }
    return false;
  }

  /** Saved without waiting (an Off never waits for the disk). */
  saveSoon() {
    this.saveMemory().catch(() => {});
  }

  // --- The cloud ---------------------------------------------------------------

  dropCloud() {
    this.cloud = undefined;
    this.mayPost = false;
    this.cloudError = undefined;
    this.cloudFailures = 0;
    this.cloudRetryAt = undefined;
  }

  /** The refusal kept in /data applies to the credentials of the configuration. */
  refusedNow() {
    const refused = this.memory.refused;
    if (!refused || this.config.error || !this.memory.salt) return false;
    return (
      refused.account === accountKeyOf(this.config, this.memory.salt) &&
      refused.mark === passwordMarkOf(this.config.password, this.memory.salt)
    );
  }

  paused(mono = this.monotonic()) {
    return this.pauseUntil !== undefined && this.pauseUntil > mono;
  }

  /**
   * When the next read of the cloud may start (monotonic), Infinity when none may: no
   * credentials, refused (and no user's act), paused, a minute after the last attempt, after a
   * failure its retry.
   */
  cloudAllowedAt(mono, { force = false } = {}) {
    if (!this.cloud || this.stopped) return Infinity;
    if (this.refusedNow() && !this.mayPost) return Infinity;
    // An Off held for a light whose key is not known yet (after a restart: the keys stay in
    // memory only) is protective: its read waits for a pause 10 min at most from the last
    // attempt, and for a failed read a minute, never more.
    const needy = this.guardNeedsCloud();
    const last = this.lastCloudAt ?? -Infinity;
    let at = mono;
    if (this.paused(mono)) {
      at = Math.max(
        at,
        needy ? Math.min(this.pauseUntil, last + TIMINGS.guardCloudPause) : this.pauseUntil,
      );
    }
    if (!force) {
      if (this.lastCloudAt !== undefined) at = Math.max(at, this.lastCloudAt + TIMINGS.cloudGap);
      if (this.cloudRetryAt !== undefined) {
        at = Math.max(
          at,
          needy ? Math.min(this.cloudRetryAt, last + this.needyRetry()) : this.cloudRetryAt,
        );
      }
    }
    return at;
  }

  /**
   * For an Off held whose key is missing: a cloud that does not answer (network, timeout) is
   * tried every minute; an error answered (the sign-in included: never a password posted every
   * minute) keeps the growing retries, 10 min apart at most.
   */
  needyRetry() {
    return this.noAnswer(this.cloudError) ? TIMINGS.cloudGap : TIMINGS.guardCloudPause;
  }

  noAnswer(err) {
    return err instanceof CloudError && (err.kind === 'network' || err.kind === 'timeout');
  }

  /** Why an Off held for a light not known cannot leave yet (the key from the cloud). */
  guardWhy(mono) {
    if (this.config.error || !this.cloud) return 'config';
    if (this.refusedNow() && !this.mayPost) return 'refused';
    if (this.cloudOkAt !== undefined) return 'unlisted';
    if (this.paused(mono)) return 'paused';
    if (this.cloudError) return this.noAnswer(this.cloudError) ? 'failed' : 'error';
    return 'pending';
  }

  /** An Off held for a light not known yet, and no good read of the cloud since the start. */
  guardNeedsCloud() {
    if (this.cloudOkAt !== undefined || !this.configLoaded) return false;
    for (const guard of this.guards.values()) {
      if (!this.usable(this.lights.get(guard.id))) return true;
    }
    return false;
  }

  /**
   * The next read of the cloud: soon when no light is known yet (or `soon`), otherwise 6 h
   * after the last good one; never before it is allowed.
   */
  scheduleCloud({ soon = false } = {}) {
    if (this.cloudTimer !== undefined) this.timers.clearTimeout(this.cloudTimer);
    this.cloudTimer = undefined;
    this.cloudDueAt = undefined;
    if (this.stopped || !this.cloud) return;
    const mono = this.monotonic();
    const allowed = this.cloudAllowedAt(mono, { force: soon && this.mayPost });
    if (allowed === Infinity) return;
    const wanted =
      soon || this.cloudOkAt === undefined ? mono : this.cloudOkAt + TIMINGS.cloudRefresh;
    const at = Math.max(allowed, wanted);
    this.cloudDueAt = at;
    this.cloudTimer = this.timers.setTimeout(
      () => {
        this.cloudTimer = undefined;
        this.cloudDueAt = undefined;
        this.readCloud({ force: soon && this.mayPost }).catch(() => {});
      },
      Math.max(0, at - mono),
    );
  }

  /** A read wanted soon (an Off for a light not known yet, a light whose key changed). */
  askCloud() {
    if (this.cloudReading) return;
    const mono = this.monotonic();
    if (this.cloudDueAt !== undefined && this.cloudDueAt <= this.cloudAllowedAt(mono)) return;
    this.scheduleCloud({ soon: true });
  }

  /**
   * One read of the cloud at a time: sign-in when needed (allowed: no refusal kept for these
   * credentials, or a user's act), houses, devices, products. `force` (new credentials, a
   * click) skips the minute between two reads, never a pause.
   */
  readCloud({ force = false, click = false } = {}) {
    if (this.cloudReading) return this.cloudReading;
    this.cloudReading = this.readCloudNow({ force, click }).finally(() => {
      this.cloudReading = undefined;
    });
    return this.cloudReading;
  }

  async readCloudNow({ force, click }) {
    const cloud = this.cloud;
    if (!cloud || this.stopped) return { skipped: true };
    const mono = this.monotonic();
    if (click) this.mayPost = true;
    if (this.cloudAllowedAt(mono, { force: force || click }) > mono) {
      this.scheduleCloud();
      return { skipped: true };
    }
    // The time of the attempt goes to /data before it (a restart never reads sooner).
    this.lastCloudAt = mono;
    this.saveSoon();
    this.refreshStatus().catch(() => {});
    const mayPost = this.mayPost || !this.refusedNow();
    let result;
    try {
      result = await cloud.readDevices({ maySignIn: mayPost });
    } catch (err) {
      if (cloud !== this.cloud || this.stopped) return { error: err };
      this.cloudFailed(err);
      return { error: err };
    }
    if (cloud !== this.cloud || this.stopped) return { skipped: true };
    this.cloudOk(cloud, result);
    return { ok: true };
  }

  cloudOk(cloud, result) {
    this.signedInOk = true;
    this.userId = cloud.userId;
    this.mayPost = false;
    this.cloudOkAt = this.monotonic();
    this.cloudError = undefined;
    this.cloudFailures = 0;
    this.cloudRetryAt = undefined;
    // A good read ends a pause (the next one in 6 h).
    this.pauseUntil = undefined;
    this.pauseStep = 0;
    if (this.memory.refused) {
      this.memory.refused = undefined;
      this.logger.info('aidot: the AiDot cloud accepted the credentials again');
    }
    this.applyLights(result);
    this.saveSoon();
    this.scheduleCloud();
    this.publishDevices().catch(() => {});
    this.refreshStatus().catch(() => {});
    this.sendPendingGuards();
    this.armProbe();
    for (const entry of this.lights.values()) this.ensureConnection(entry);
  }

  cloudFailed(err) {
    const mono = this.monotonic();
    this.cloudError = err;
    if (err instanceof CloudError && err.kind === 'refused') {
      // The one refusal of the credentials: kept, never posted again by itself.
      this.mayPost = false;
      this.memory.refused = {
        account: accountKeyOf(this.config, this.memory.salt),
        mark: passwordMarkOf(this.config.password, this.memory.salt),
      };
      this.logger.warn('aidot: the AiDot cloud refused the e-mail or the password');
    } else if (err instanceof CloudError && (err.kind === 'rate' || err.kind === 'unavailable')) {
      const base = Math.min(TIMINGS.pauseMin * 2 ** this.pauseStep, TIMINGS.pauseMax);
      const asked = Number.isFinite(err.retryAfter) ? err.retryAfter : base;
      const wait = Math.min(Math.max(asked, TIMINGS.pauseMin), TIMINGS.pauseMax);
      this.pauseUntil = mono + wait;
      this.pauseStep = Math.min(this.pauseStep + 1, 20);
      this.logger.warn(`aidot: AiDot cloud ${err.kind}, paused ${Math.round(wait / 1000)} s`);
    } else {
      const steps = TIMINGS.cloudRetry;
      this.cloudRetryAt = mono + steps[Math.min(this.cloudFailures, steps.length - 1)];
      this.cloudFailures += 1;
      this.logger.warn(`aidot: AiDot cloud not read (${err?.kind ?? err?.name ?? 'error'})`);
    }
    this.saveSoon();
    this.scheduleCloud();
    this.refreshStatus().catch(() => {});
  }

  /** The lights of the cloud list into the entries; a changed address or key renews the link. */
  applyLights({ devices, productsRead }) {
    const seen = new Set();
    let count = 0;
    this.tooMany = false;
    for (const raw of devices) {
      const { light } = lightOf(raw);
      if (!light || seen.has(light.id)) continue;
      if (count >= LIMITS.devices) {
        this.tooMany = true;
        break;
      }
      count += 1;
      seen.add(light.id);
      const entry = this.entryOf(light.id);
      const before = entry.light;
      if (before && !productsRead && !light.caps.known) light.caps = before.caps;
      // The address found by the discovery stays when the cloud gives none.
      if (!light.ip && before?.ip) light.ip = before.ip;
      entry.light = light;
      entry.listed = true;
      if (before && this.linkKeyOf(entry) !== entry.lastKey) {
        // The address or the keys changed: a new identity failure may ask the cloud again soon.
        entry.cloudAsks = 0;
        entry.nextCloudAsk = undefined;
      }
      entry.lastKey = this.linkKeyOf(entry);
      if (entry.link && entry.linkKey !== this.linkKeyOf(entry)) this.dropLink(entry);
    }
    this.lightCount = count;
    for (const entry of this.lights.values()) {
      if (entry.listed && !seen.has(entry.id)) entry.listed = false;
    }
  }

  // --- Discovery through the core ----------------------------------------------

  /**
   * The devDiscoveryReq broadcast by the Gladys core (UDP 6666): the answers give the address
   * of each light (its devId); a MAC that differs from the cloud's is another light. Never
   * blocking: any failure leaves the addresses as they were.
   */
  async discover() {
    const mono = this.monotonic();
    if (!this.userId || typeof this.gladys.scanNetwork !== 'function') return 0;
    if (mono - this.lastDiscoveryAt < 10_000) return 0;
    this.lastDiscoveryAt = mono;
    let replies;
    try {
      const payload = discoveryPayload({ userId: this.userId, now: this.now() });
      if (payload.length > DISCOVERY.maxPayload) return 0;
      const answer = await this.bounded(
        Promise.resolve(
          this.gladys.scanNetwork('udp-active-broadcast', {
            port: DISCOVERY.port,
            payload,
            timeoutSeconds: TIMINGS.discoverySeconds,
          }),
        ),
        TIMINGS.discoverySeconds * 1000 + 5000,
      );
      replies = answer.late ? [] : answer.value;
    } catch (err) {
      this.logger.warn(`aidot: discovery failed (${err?.name ?? 'Error'})`);
      return 0;
    }
    let found = 0;
    for (const reply of (Array.isArray(replies) ? replies : []).slice(0, LIMITS.discoveryReplies)) {
      const parsed = readDiscovery(Buffer.from(String(reply?.payload_base64 ?? ''), 'base64'));
      const ip = lanAddress(reply?.source_ip);
      const entry = parsed ? this.lights.get(parsed.id) : undefined;
      if (!entry?.light || !ip) continue;
      if (parsed.mac && entry.light.mac && parsed.mac !== entry.light.mac) continue;
      found += 1;
      if (entry.light.ip !== ip) {
        entry.light.ip = ip;
        this.dropLink(entry);
        this.ensureConnection(entry);
      }
    }
    return found;
  }

  /** A light added cannot be reached: a discovery, 5 min apart at most. */
  askDiscovery() {
    if (this.discoveryTimer !== undefined || this.stopped || !this.userId) return;
    const wait = Math.max(0, this.lastDiscoveryAt + TIMINGS.discoveryGap - this.monotonic());
    this.discoveryTimer = this.timers.setTimeout(() => {
      this.discoveryTimer = undefined;
      this.discover().catch(() => {});
    }, wait);
  }

  // --- The lights and their connections ------------------------------------------

  entryOf(id) {
    let entry = this.lights.get(id);
    if (!entry) {
      entry = {
        id,
        light: undefined,
        listed: false,
        link: undefined,
        linkKey: undefined,
        conn: undefined,
        connecting: false,
        failures: 0,
        lastReason: undefined,
        reconnectTimer: undefined,
        reconnectAt: undefined,
        readTimer: undefined,
        lastReadAt: undefined,
        reading: false,
        state: {},
        mark: 0,
        stateConn: undefined,
        pastSeqs: new Map(),
      };
      this.lights.set(id, entry);
    }
    return entry;
  }

  /** Known well enough to be reached: its key and address from the cloud, the user id. */
  usable(entry) {
    return Boolean(entry?.light && entry.light.ip && this.userId);
  }

  /** Connected for: added in Gladys, or an Off held. */
  wanted(entry) {
    return this.guards.has(entry.id) || this.createdOf(entry.id) !== undefined;
  }

  /** What the link depends on (address, key, password, form, user): a change renews it. */
  linkKeyOf(entry) {
    const l = entry.light;
    if (!l) return undefined;
    return createHash('sha256')
      .update(
        [
          l.ip,
          l.key.toString('hex'),
          l.password ?? '',
          l.simpleVersion ?? '',
          l.modelId ?? '',
          this.userId ?? '',
        ].join('\u0000'),
      )
      .digest('hex');
  }

  /** The link of a usable light (made when needed); undefined otherwise. */
  linkOf(entry) {
    if (!this.usable(entry) || this.stopped) return undefined;
    const key = this.linkKeyOf(entry);
    if (entry.link && entry.linkKey === key) return entry.link;
    this.dropLink(entry);
    const link = new LightLink({
      light: entry.light,
      userId: this.userId,
      connect: this.connect,
      now: this.now,
      monotonic: this.monotonic,
      timers: this.timers,
      logger: this.logger,
      onMessage: (message, conn, job) => this.onMessage(entry, link, message, conn, job),
      onOpen: (conn) => this.onOpen(entry, link, conn),
      onClose: (conn, reason) => this.onClose(entry, link, conn, reason),
      onConnectError: (err) => this.onConnectError(entry, link, err),
    });
    entry.link = link;
    entry.linkKey = key;
    entry.failures = 0;
    entry.lastReason = undefined;
    return link;
  }

  dropLink(entry) {
    if (entry.reconnectTimer !== undefined) this.timers.clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
    entry.reconnectAt = undefined;
    if (entry.readTimer !== undefined) this.timers.clearTimeout(entry.readTimer);
    entry.readTimer = undefined;
    const link = entry.link;
    if (!link) return;
    entry.link = undefined;
    entry.linkKey = undefined;
    entry.conn = undefined;
    entry.reading = false;
    const waiting = this.waiting.get(entry.id);
    if (waiting && !waiting.sent) {
      this.waiting.delete(entry.id);
      waiting.settle(this.refusal(ERRORS.restarting));
    }
    link.stop();
  }

  /** Opens the connection of a light wanted and usable, unless open, opening, or waiting. */
  ensureConnection(entry) {
    if (this.stopped || !this.wanted(entry)) return;
    const link = this.linkOf(entry);
    if (!link) {
      if (entry.light && !entry.light.ip) this.askDiscovery();
      return;
    }
    if (link.isOpen || entry.connecting || entry.reconnectTimer) return;
    entry.connecting = true;
    link
      .open()
      .catch(() => {})
      .finally(() => {
        entry.connecting = false;
      });
  }

  onOpen(entry, link, conn) {
    if (link !== entry.link) return;
    entry.conn = conn;
    entry.failures = 0;
    entry.lastReason = undefined;
    if (entry.reconnectTimer !== undefined) this.timers.clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
    entry.reconnectAt = undefined;
    this.logger.info(`aidot: ${shortId(entry.id)} connected`);
    // The Off held first: before any read.
    const guard = this.guards.get(entry.id);
    if (guard && !guard.inFlight && !guard.userInFlight && this.canSend(guard) && !guard.okSeen) {
      this.sendGuard(guard).catch(() => {});
    } else if (guard && this.awaitingJudgement(guard)) {
      this.judgeRead(entry);
    }
    this.readLight(entry);
    this.refreshStatus().catch(() => {});
  }

  onConnectError(entry, link, err) {
    if (link !== entry.link || this.stopped) return;
    if (entry.reconnectTimer === undefined) entry.failures += 1;
    entry.lastReason = reasonOf(err);
    this.logger.warn(`aidot: ${shortId(entry.id)} not reached (${err.code})`);
    const loginUnanswered = err.code === 'timeout' && err.detail === 'no answer to the login';
    if (err.code === 'identity' || err.code === 'login' || loginUnanswered) {
      // Another light at this address, or the key or the password changed (a light does not
      // answer a login it cannot open): the cloud and the discovery tell. A read of the cloud
      // that did not change the light: the next one asked twice later (1, 2, 4… min, 6 h at most).
      const mono = this.monotonic();
      if (mono >= (entry.nextCloudAsk ?? -Infinity)) {
        entry.cloudAsks = (entry.cloudAsks ?? 0) + 1;
        entry.nextCloudAsk =
          mono + Math.min(TIMINGS.cloudGap * 2 ** (entry.cloudAsks - 1), TIMINGS.cloudRefresh);
        this.askCloud();
      }
      this.askDiscovery();
    } else if (entry.failures >= 2) {
      this.askDiscovery();
    }
    this.scheduleReconnect(entry);
    this.refreshStatus().catch(() => {});
  }

  onClose(entry, link, conn, reason) {
    if (link !== entry.link) return;
    if (entry.conn === conn) entry.conn = undefined;
    entry.reading = false;
    if (this.stopped) return;
    if (reason !== 'cut') {
      entry.lastReason = both('connection closed', 'connexion fermée');
      this.logger.warn(`aidot: ${shortId(entry.id)} connection closed (${reason})`);
    }
    this.scheduleReconnect(entry);
    this.armProbe();
    this.refreshStatus().catch(() => {});
  }

  scheduleReconnect(entry) {
    if (entry.reconnectTimer !== undefined || this.stopped || !entry.link) return;
    const steps = TIMINGS.backoff;
    const wait = steps[Math.min(entry.failures, steps.length - 1)];
    entry.reconnectAt = this.monotonic() + wait;
    entry.reconnectTimer = this.timers.setTimeout(() => {
      entry.reconnectTimer = undefined;
      entry.reconnectAt = undefined;
      // An Off held due: the probe (every 10 s) opens the connection for it.
      const guard = this.guards.get(entry.id);
      if (guard && this.due(guard, this.monotonic())) {
        this.scheduleReconnect(entry);
        return;
      }
      this.ensureConnection(entry);
    }, wait);
  }

  // --- Reads -----------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The next read of a connected light: every interval (10 s for the first generation). */
  scheduleRead(entry) {
    if (entry.readTimer !== undefined) this.timers.clearTimeout(entry.readTimer);
    entry.readTimer = undefined;
    if (!entry.conn || this.stopped) return;
    const every =
      entry.light?.modelId === LOCAL.firstGeneration
        ? Math.min(this.interval, TIMINGS.heartbeatFirstGeneration)
        : this.interval;
    const mono = this.monotonic();
    const wait = Math.max(0, (entry.lastReadAt ?? mono) + every - mono);
    entry.readTimer = this.timers.setTimeout(() => {
      entry.readTimer = undefined;
      this.readLight(entry);
    }, wait);
  }

  /** A getDevAttrReq on the open connection; resolves true when answered. */
  readLight(entry, { priority = PRIORITY.READ, onSent } = {}) {
    const link = entry.link;
    const conn = entry.conn;
    if (!link || !conn || this.stopped) return Promise.resolve(false);
    if (priority === PRIORITY.READ) {
      if (entry.reading) return Promise.resolve(false);
      entry.reading = true;
      entry.lastReadAt = this.monotonic();
    }
    const first = entry.light?.modelId === LOCAL.firstGeneration;
    return link
      .request(
        { method: 'get', attr: first ? [...LOCAL.firstGenerationAttrs] : [] },
        {
          priority,
          onSent: (at, seq) => {
            const tick = ++this.tick;
            this.rememberSeq(entry, seq, tick);
            onSent?.(tick);
          },
        },
      )
      .then(() => true)
      .catch((err) => {
        if (err instanceof LinkError && err.code === 'timeout' && first && entry.conn === conn) {
          // The first generation answers no heartbeat: 3 reads without a byte close it.
          if (link.silentFor() >= TIMINGS.heartbeatFirstGeneration * TIMINGS.heartbeatMisses)
            link.close('closed');
        }
        return false;
      })
      .finally(() => {
        if (priority === PRIORITY.READ) {
          entry.reading = false;
          this.scheduleRead(entry);
        }
      });
  }

  rememberSeq(entry, seq, tick) {
    entry.pastSeqs.set(seq, tick);
    if (entry.pastSeqs.size > PAST_SEQS) entry.pastSeqs.delete(entry.pastSeqs.keys().next().value);
  }

  /**
   * A message of a light. The answer to a read (or a late one) applies only if the read left
   * after the last command or push of the light; any other message with a state is a push.
   */
  onMessage(entry, link, message, conn, job) {
    if (link !== entry.link || conn !== entry.conn || !message.state) return;
    const seq = job ? job.seq : message.seq;
    const at = seq !== undefined ? entry.pastSeqs.get(seq) : undefined;
    let kind = 'push';
    if (job) kind = job.method === 'getDevAttrReq' ? 'read' : 'answer';
    else if (at !== undefined) kind = this.isSetSeq(entry, seq) ? 'answer' : 'read';
    // The answer to a request that is not matched (no `seq` echoed, or an unknown one): its time
    // of departure is not known, so it is never applied (a push carries no answer code).
    else if (message.code !== undefined || /Resp$/.test(message.method ?? '')) return;
    // A read that left before the last command or push of the light, or the answer to a command
    // older than the last one: what it says is not the state of now.
    if (kind === 'read' && !((at ?? 0) > entry.mark)) return;
    if (kind === 'answer' && !((at ?? 0) >= entry.mark)) return;
    if (kind === 'push') entry.mark = ++this.tick;
    Object.assign(entry.state, message.state);
    entry.stateConn = conn;
    this.queueStates(entry);
    this.flush().catch(() => {});
    for (const watcher of [...(this.watchers.get(entry.id) ?? [])]) watcher.onState(entry.state);
    this.judgeGuard(entry, message.state.power, kind, at ?? 0);
  }

  isSetSeq(entry, seq) {
    return entry.setSeqs?.has(seq) ?? false;
  }

  /** Watches the states of `id` until `until` (monotonic); `test(state)` true ends it. */
  watch(id, until, test) {
    return new Promise((resolve) => {
      const set = this.watchers.get(id) ?? new Set();
      this.watchers.set(id, set);
      let last;
      const end = (result) => {
        this.timers.clearTimeout(timer);
        set.delete(watcher);
        if (set.size === 0 && this.watchers.get(id) === set) this.watchers.delete(id);
        resolve(result);
      };
      const watcher = {
        onState: (state) => {
          last = { ...state };
          if (test(state)) end({ done: true, last });
        },
        end: () => end({ done: false, last }),
      };
      set.add(watcher);
      const timer = this.timers.setTimeout(
        () => end({ done: false, last }),
        Math.max(0, until - this.monotonic()),
      );
    });
  }

  // --- Guards (the Offs held) ------------------------------------------------------

  makeGuard({ id, left = false, tries = 0, accepted = false, seq = 0 }) {
    const guard = {
      id,
      seq,
      tick: ++this.tick,
      left,
      tries,
      okSeen: accepted,
      contradicted: false,
      // Answered before a restart: its last send counts as now (sent again 10 s later at the earliest).
      sentAt: accepted ? this.monotonic() : -Infinity,
      sentTick: 0,
      checks: 0,
      inFlight: false,
      userInFlight: false,
      lastError: undefined,
      ended: undefined,
    };
    guard.endPromise = new Promise((resolve) => {
      guard.end = (reason) => {
        if (guard.ended) return;
        guard.ended = reason;
        resolve(reason);
      };
    });
    return guard;
  }

  endGuard(guard, reason) {
    if (this.guards.get(guard.id) === guard) this.guards.delete(guard.id);
    guard.end(reason);
    this.saveSoon();
    this.refreshStatus().catch(() => {});
  }

  /** May be sent again: fewer than 4 answered tries. */
  canSend(guard) {
    return guard.tries <= TIMINGS.resendMax;
  }

  /** Answered by the light, not judged yet (neither seen off nor contradicted). */
  awaitingJudgement(guard) {
    return guard.okSeen && !guard.contradicted && !guard.inFlight && guard.checks < 3;
  }

  /** Due for a send: never answered (pending), or contradicted 10 s after its last send. */
  due(guard, mono) {
    if (guard.inFlight || guard.userInFlight || !this.canSend(guard)) return false;
    if (!guard.okSeen) return !guard.left || mono - guard.sentAt >= TIMINGS.guardProbe * 0.9;
    return guard.contradicted && mono - guard.sentAt >= TIMINGS.guardProbe * 0.9;
  }

  /**
   * An observation of the light: `kind` push (pushed by the light), answer (to one of our
   * commands), read (the answer to a read that left at `tick`). Off: the guard ends. On, after
   * the Off was answered: it contradicts it (sent again, 4 answered tries at most).
   */
  judgeGuard(entry, power, kind, tick) {
    const guard = this.guards.get(entry.id);
    if (!guard || power === undefined) return;
    // Seen off (a push, an answer, or a read that left after the click), even while the Off is
    // in flight: done.
    if (power === false && (kind !== 'read' || tick > guard.tick)) {
      this.logger.info(`aidot: Off of ${shortId(entry.id)} seen applied`);
      this.endGuard(guard, 'off');
      return;
    }
    if (guard.inFlight) return;
    if (kind === 'read' && !(tick > guard.sentTick && guard.left)) {
      // A read that left before the Off was sent: it says nothing of the Off.
      if (power === false && tick > guard.tick) {
        this.logger.info(`aidot: Off of ${shortId(entry.id)} seen applied`);
        this.endGuard(guard, 'off');
      }
      return;
    }
    if (power === false) {
      this.logger.info(`aidot: Off of ${shortId(entry.id)} seen applied`);
      this.endGuard(guard, 'off');
      return;
    }
    // On, after the Off was answered (a read that left after it, or a report of the light): not
    // applied, sent again within the 4 answered tries. A report equal to the state of before is
    // never taken for a light turned on elsewhere.
    if (!guard.okSeen) return;
    if (!guard.contradicted) {
      guard.contradicted = true;
      this.saveSoon();
      this.refreshStatus().catch(() => {});
    }
    this.armProbe();
  }

  armProbe() {
    if (this.probeTimer !== undefined || this.stopped) return;
    const watched = [...this.guards.values()].some(
      (g) => (this.canSend(g) && (!g.okSeen || g.contradicted)) || this.awaitingJudgement(g),
    );
    if (!watched) return;
    this.probeTimer = this.timers.setTimeout(() => {
      this.probeTimer = undefined;
      this.probe();
    }, TIMINGS.guardProbe);
  }

  /** Every 10 s: the Offs due are sent (a connection opened for them); those answered are judged by a read. */
  probe() {
    const mono = this.monotonic();
    for (const guard of this.guards.values()) {
      if (this.due(guard, mono)) {
        const entry = this.lights.get(guard.id);
        if (!this.usable(entry)) {
          // The key from the cloud until a first good read; then a light without address is
          // looked for by the discovery, one not in the list waits for the 6 h read.
          if (this.cloudOkAt === undefined) this.askCloud();
          else if (entry?.light && !entry.light.ip) this.askDiscovery();
        }
        this.sendGuard(guard).catch(() => {});
      } else if (this.awaitingJudgement(guard)) {
        const entry = this.lights.get(guard.id);
        if (entry?.conn) {
          guard.checks += 1;
          this.judgeRead(entry);
        }
      }
    }
    this.armProbe();
  }

  /** The Offs never answered (or contradicted and due): sent now, before any read. */
  sendPendingGuards() {
    const mono = this.monotonic();
    for (const guard of this.guards.values()) {
      const entry = this.lights.get(guard.id);
      if (!this.usable(entry)) continue;
      const pending =
        !guard.okSeen && !guard.inFlight && !guard.userInFlight && this.canSend(guard);
      if (pending || this.due(guard, mono)) this.sendGuard(guard).catch(() => {});
    }
  }

  /** A read of the light that judges `guard` (it leaves after the send of the Off). */
  judgeRead(entry) {
    return this.readLight(entry, { priority: PRIORITY.COMMAND });
  }

  /**
   * Sends the Off of `guard` (OnOff 0), protective. Resolves with the answer; rejects with the
   * LinkError (`sent` tells whether it left). A send counts as a try only once the light
   * answered it. Then a read judges it. `hurry`: the first send of a click.
   */
  sendGuard(guard, { hurry = false } = {}) {
    const entry = this.lights.get(guard.id) ?? this.entryOf(guard.id);
    const link = this.linkOf(entry);
    if (!link) return Promise.reject(new LinkError('unknown', { detail: 'light not known yet' }));
    if (guard.inFlight)
      return Promise.reject(new LinkError('late', { detail: 'already in flight' }));
    guard.inFlight = true;
    const { id } = guard;
    let sent = false;
    return link
      .request(
        { method: 'set', attr: { OnOff: 0 } },
        {
          priority: PRIORITY.PROTECTIVE,
          // No deadline to leave: only its answer is awaited once it left.
          deadline: Infinity,
          timeout: TIMINGS.answerTimeout,
          hurry,
          beforeSend: () => {
            if (this.guards.get(id) !== guard)
              throw new LinkError('late', { detail: 'superseded' });
          },
          onSent: (at, seq) => {
            sent = true;
            guard.left = true;
            guard.okSeen = false;
            guard.contradicted = false;
            guard.checks = 0;
            guard.sentAt = this.monotonic();
            guard.sentTick = ++this.tick;
            entry.mark = guard.sentTick;
            this.rememberSet(entry, seq, guard.sentTick);
          },
          onAnswer: () => {
            guard.okSeen = true;
            guard.tries += 1;
          },
        },
      )
      .then((answer) => answer)
      .catch((err) => {
        guard.lastError = err;
        if (err instanceof LinkError && err.sent && err.code === 'refused') guard.tries += 1;
        throw err;
      })
      .finally(() => {
        guard.inFlight = false;
        // Sent: a read judges it now (off = done), answered or not.
        if (sent && this.guards.get(id) === guard && entry.conn) this.judgeRead(entry);
        this.saveSoon();
        this.armProbe();
        this.refreshStatus().catch(() => {});
      });
  }

  rememberSet(entry, seq, tick) {
    entry.setSeqs ??= new Set();
    entry.setSeqs.add(seq);
    if (entry.setSeqs.size > PAST_SEQS) entry.setSeqs.delete(entry.setSeqs.values().next().value);
    this.rememberSeq(entry, seq, tick);
  }

  // --- Commands --------------------------------------------------------------------

  /** A command from Gladys. */
  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const parsed = parseExternalId(feature?.external_id, this.gladys.selector);
    if (!parsed?.key) throw this.refusal(ERRORS.notCommandable);
    const command = commandOf(parsed.key, integerOf(value));
    if (!command) throw this.refusal(ERRORS.badValue);
    if (command.protective) return this.protective(parsed.id, received);
    return this.command(parsed.id, command.target, received);
  }

  /**
   * An Off: no command, read, pause, refusal nor configuration stops it once the light is
   * known. It cancels the commands of the light waiting, is tried again for 250 ms, and stays
   * as a guard (in /data) until the light is seen off.
   */
  async protective(id, received) {
    this.cancelCommands(id);
    const entry = this.entryOf(id);
    this.seq += 1;
    const old = this.guards.get(id);
    const guard = this.makeGuard({ id, seq: this.seq });
    guard.userInFlight = true;
    this.guards.set(id, guard);
    old?.end('superseded');
    // Written to /data without waiting: an Off never waits for the disk.
    this.saveSoon();
    this.logger.info(`aidot: Off of ${shortId(id)}`);
    const answerBy = received + TIMINGS.offAck;
    if (!this.usable(entry)) {
      // Not known yet (the cloud gives the key): a read of the cloud is asked; one in progress
      // is awaited a little.
      if (!this.configLoaded) this.askConfig();
      this.askCloud();
      if (this.cloudReading)
        await this.bounded(this.cloudReading, Math.max(0, received + 1500 - this.monotonic()));
    }
    const first = this.monotonic();
    let lastError;
    let queued = false;
    for (let attempt = 0; ; attempt += 1) {
      const sent = this.sendGuard(guard, { hurry: attempt === 0 }).then(
        () => ({}),
        (error) => ({ error }),
      );
      let timer;
      const outcome = await Promise.race([
        sent,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(
            () => resolve({ late: true }),
            Math.max(0, answerBy - this.monotonic()),
          );
        }),
      ]);
      this.timers.clearTimeout(timer);
      if (outcome.late) {
        queued = true;
        break;
      }
      lastError = outcome.error;
      if (!lastError) break;
      const mono = this.monotonic();
      if (
        !(lastError instanceof LinkError) ||
        lastError.sent ||
        lastError.code === 'unknown' ||
        this.guards.get(id) !== guard ||
        mono - first >= TIMINGS.protectiveRetry ||
        this.stopped ||
        entry.link?.reopenWait(mono) > TIMINGS.reopenFirst
      ) {
        break;
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.protectiveRetryGap));
      if (this.guards.get(id) !== guard) break;
    }
    guard.userInFlight = false;
    this.saveSoon();
    if (queued) {
      this.armProbe();
      this.refreshStatus().catch(() => {});
      throw this.refusal(
        guard.left
          ? ERRORS.offUnconfirmed
          : ERRORS.protectiveKept(reasonOf(new LinkError('timeout'))),
      );
    }
    if (!guard.left) {
      if (this.guards.get(id) !== guard) throw this.refusal(ERRORS.cancelledByStop);
      // Never abandoned: kept, sent every 10 s, as soon as a connection opens or the cloud gives it.
      this.armProbe();
      this.ensureConnection(entry);
      this.refreshStatus().catch(() => {});
      throw this.refusal(ERRORS.protectiveKept(reasonOf(lastError)));
    }
    if (lastError && lastError instanceof LinkError && lastError.code === 'refused') {
      this.armProbe();
      this.refreshStatus().catch(() => {});
      throw this.refusal(ERRORS.offRefused(reasonOf(lastError)));
    }
    // Sent (answered or not): the read right after it tells.
    let timer;
    const ended = await Promise.race([
      guard.endPromise,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve(undefined),
          Math.max(0, answerBy - this.monotonic()),
        );
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (ended === 'off') return undefined;
    this.armProbe();
    this.refreshStatus().catch(() => {});
    if (ended === 'superseded' || ended === 'deleted') throw this.refusal(ERRORS.cancelledByStop);
    throw this.refusal(ERRORS.offUnconfirmed);
  }

  /** The commands of `id` not sent yet: dropped (an Off of the light was clicked). */
  cancelCommands(id) {
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    const link = this.lights.get(id)?.link;
    link?.cancel(
      (job) => job.tag === entry,
      () => this.refusal(ERRORS.cancelledByStop),
    );
    entry.settle(this.refusal(ERRORS.cancelledByStop));
  }

  /** A non-protective command: in line on the connection of the light, merged with the one waiting. */
  async command(id, target, received) {
    if (!this.ready) {
      if (!this.configLoaded) this.askConfig();
      if (!(await this.waitReady(received + TIMINGS.configWait))) {
        throw this.refusal(ERRORS.configNotLoaded);
      }
    }
    const light = this.lights.get(id);
    if (!light?.light || !this.userId) {
      this.askCloud();
      throw this.refusal(ERRORS.lightUnknown);
    }
    if (!light.light.ip) {
      this.askDiscovery();
      throw this.refusal(ERRORS.noAddress);
    }
    if (this.guards.get(id)?.userInFlight) throw this.refusal(ERRORS.stopPending);
    let entry = this.waiting.get(id);
    const merged = entry ? { ...entry.target, ...target } : target;
    const invalid = targetError(merged, light.light);
    if (invalid) throw this.refusal(invalid);
    if (entry) {
      // Merged: the last value asked of each field (a scene).
      entry.target = merged;
    } else {
      if (this.waiting.size >= LIMITS.commandQueue) throw this.refusal(ERRORS.queueFull);
      entry = this.makeEntry(light, id, target, received);
      if (!entry) throw this.refusal(ERRORS.lightUnknown);
    }
    let timer;
    const result = await Promise.race([
      entry.done,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve({ pending: true }),
          Math.max(0, received + TIMINGS.commandAck - this.monotonic()),
        );
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (result.pending) {
      if (!entry.sent) throw this.refusal(ERRORS.queued);
      const other = entry.lastState && !shows(entry.target, entry.lastState);
      throw this.refusal(other ? ERRORS.notApplied : ERRORS.unconfirmed);
    }
    if (result.error) throw result.error;
    return undefined;
  }

  makeEntry(light, id, target, received) {
    const link = this.linkOf(light);
    if (!link) return undefined;
    let settle;
    const entry = {
      id,
      target: { ...target },
      received,
      sent: false,
      answered: false,
      before: undefined,
      lastState: undefined,
      done: new Promise((resolve) => {
        settle = resolve;
      }),
      settled: false,
    };
    entry.settle = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      settle(error ? { error } : {});
    };
    this.waiting.set(id, entry);
    let restored;
    const until = received + TIMINGS.commandAck;
    link
      .request(
        { method: 'set', attr: () => attrOf(entry.target) },
        {
          priority: PRIORITY.COMMAND,
          tag: entry,
          deadline: received + TIMINGS.commandMaxAge,
          timeout: TIMINGS.answerTimeout,
          hurry: true,
          beforeSend: () => {
            if (light.link !== link || this.stopped) throw this.refusal(ERRORS.restarting);
            // The value written, bounded right before it leaves (merged commands included).
            const invalid = light.light ? targetError(entry.target, light.light) : ERRORS.badValue;
            if (invalid) throw this.refusal(invalid);
          },
          onSent: (at, seq) => {
            entry.sent = true;
            if (this.waiting.get(id) === entry) this.waiting.delete(id);
            entry.before = { ...light.state };
            light.mark = ++this.tick;
            this.rememberSet(light, seq, light.mark);
            entry.watching = this.watch(
              id,
              Math.max(until, this.monotonic() + TIMINGS.answerTimeout),
              (state) => {
                entry.lastState = { ...state };
                return (
                  shows(entry.target, state) &&
                  (entry.answered || !shows(entry.target, entry.before))
                );
              },
            );
            // A newer command of the light left: the Off held for it ends here.
            const guard = this.guards.get(id);
            if (guard) {
              restored = guard;
              this.guards.delete(id);
              guard.end('superseded');
              this.saveSoon();
            }
          },
          onAnswer: () => {
            entry.answered = true;
            // The state pushed with the answer (or before it) may already show it.
            if (shows(entry.target, light.state)) {
              for (const watcher of [...(this.watchers.get(id) ?? [])])
                watcher.onState(light.state);
            }
          },
        },
      )
      .then(
        () => ({ ok: true }),
        (err) => ({ err }),
      )
      .then(async ({ err }) => {
        if (err) {
          if (this.waiting.get(id) === entry) this.waiting.delete(id);
          if (!(err instanceof LinkError)) {
            entry.settle(err);
            return;
          }
          if (!err.sent) {
            entry.settle(
              this.refusal(err.code === 'late' ? ERRORS.tooOld : ERRORS.notSent(reasonOf(err))),
            );
            return;
          }
          if (err.code === 'refused') {
            // Refused by the light: not a newer command, the Off stands.
            if (restored && !this.guards.has(id)) {
              const back = this.makeGuard({
                id,
                left: restored.left,
                tries: restored.tries,
                accepted: restored.okSeen,
                seq: restored.seq,
              });
              this.guards.set(id, back);
              this.saveSoon();
              this.armProbe();
            }
            entry.settle(this.refusal(ERRORS.rejected(reasonOf(err))));
            return;
          }
        }
        // Answered, or sent without an answer: a read tells (unless already seen).
        if (light.conn) this.readLight(light, { priority: PRIORITY.COMMAND });
        const seen = await entry.watching;
        if (seen?.done) {
          entry.settle();
          return;
        }
        this.followUp(light);
        entry.settle(
          this.refusal(
            seen?.last && !shows(entry.target, seen.last) ? ERRORS.notApplied : ERRORS.unconfirmed,
          ),
        );
      });
    return entry;
  }

  /** A read of the light 5 s later (a command not seen applied). */
  followUp(entry) {
    if (entry.followTimer !== undefined || this.stopped) return;
    entry.followTimer = this.timers.setTimeout(() => {
      entry.followTimer = undefined;
      this.readLight(entry, { priority: PRIORITY.COMMAND });
    }, TIMINGS.followUp);
  }

  // --- Gladys --------------------------------------------------------------------

  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) =>
      parseExternalId(d?.external_id, this.gladys.selector),
    );
  }

  createdOf(id) {
    const deviceId = this.gladys.externalIds('light', id).device;
    return this.createdDevices().find((d) => d.external_id === deviceId);
  }

  /** The states of a light, for the features its Gladys device has. */
  queueStates(entry) {
    const created = this.createdOf(entry.id);
    if (!created) return;
    const ids = this.gladys.externalIds('light', entry.id);
    const have = new Set((created.features ?? []).map((f) => f.external_id));
    for (const [key, value] of valuesOf(entry.state)) {
      const featureId = ids.feature(key);
      if (have.has(featureId)) this.publisher.push(featureId, { state: value });
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discover list: the lights of the cloud list. */
  async publishDevices() {
    const devices = [];
    for (const entry of this.lights.values()) {
      if (!entry.listed || !entry.light) continue;
      devices.push(
        buildDevice(this.gladys, entry.light, {
          language: this.config.language,
          created: this.createdOf(entry.id),
        }),
      );
    }
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    this.published = json;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.published = undefined;
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** Created or updated: connected; its state published only when fresh (the open connection's). */
  async deviceCreated(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (!parsed) return;
    this.gladys.forgetPublishedStates?.(device.external_id);
    this.published = undefined;
    const entry = this.lights.get(parsed.id);
    if (entry && entry.stateConn && entry.stateConn === entry.conn && !entry.conn.closed) {
      this.queueStates(entry);
      this.flush().catch(() => {});
    }
    if (entry) this.ensureConnection(entry);
    await this.publishDevices();
    await this.refreshStatus();
  }

  /** Deleted: its Off held is dropped and its connection closed (no device to drive any more). */
  async deviceDeleted(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (!parsed) return;
    this.publisher.forget(device.external_id);
    const guard = this.guards.get(parsed.id);
    if (guard) this.endGuard(guard, 'deleted');
    const entry = this.lights.get(parsed.id);
    if (entry) this.dropLink(entry);
    this.published = undefined;
    await this.publishDevices();
    await this.refreshStatus();
  }

  /** Discover: the cloud list read now if allowed (a minute apart), the discovery, then the list. */
  async scan() {
    if (this.cloud) await this.readCloud();
    await this.discover();
    this.published = undefined;
    await this.publishDevices();
    await this.refreshStatus();
  }

  // --- Status --------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  nameOf(id) {
    const created = this.createdOf(id);
    const entry = this.lights.get(id);
    return created?.name ?? deviceName(entry?.light ?? { id }, this.config.language);
  }

  async refreshStatus() {
    if (!this.configLoaded) return;
    const mono = this.monotonic();
    const parts = [];
    let connected = false;
    const createdLights = [...this.lights.values()].filter((e) => e.listed && this.createdOf(e.id));
    const reachable = createdLights.filter((e) => e.conn && !e.conn.closed).length;
    if (this.config.error) {
      parts.push(T.configError(this.config.error));
    } else {
      if (this.config.countryError) parts.push(T.countryError);
      if (this.refusedNow() && !this.mayPost) {
        parts.push(T.refused);
      } else if (this.paused(mono)) {
        parts.push(T.paused(age(this.pauseUntil - mono)));
      } else if (this.cloudError && this.cloudRetryAt !== undefined) {
        parts.push(
          T.cloudFailed(
            cloudReasonOf(this.cloudError),
            age(Math.max(0, (this.cloudDueAt ?? this.cloudRetryAt) - mono)),
          ),
        );
      } else if (this.cloudOkAt === undefined) {
        if (this.cloudReading) parts.push(T.signingIn);
        else if (this.cloudDueAt !== undefined && this.cloudDueAt > mono)
          parts.push(T.waitingGap(age(this.cloudDueAt - mono)));
        else parts.push(T.signingIn);
      }
      if (this.cloudOkAt !== undefined) {
        if (this.lightCount === 0) parts.push(T.noLight);
        else parts.push(T.lights(this.lightCount, createdLights.length, reachable));
        connected = createdLights.length === 0 || reachable > 0;
      }
    }
    if (this.tooMany) parts.push(T.tooMany(LIMITS.devices));
    const toAdd = [...this.lights.values()].filter((e) => e.listed && !this.createdOf(e.id)).length;
    if (toAdd > 0) parts.push(T.toAdd(toAdd));
    for (const entry of createdLights) {
      if (entry.conn && !entry.conn.closed) continue;
      const name = this.nameOf(entry.id);
      if (!entry.light?.ip) parts.push(T.noAddress(name));
      else if (entry.lastReason) {
        const wait = entry.reconnectAt === undefined ? 0 : entry.reconnectAt - mono;
        parts.push(T.unreachable(name, entry.lastReason, age(Math.max(0, wait))));
      }
    }
    for (const guard of this.guards.values()) {
      const name = this.nameOf(guard.id);
      if (!this.usable(this.lights.get(guard.id)))
        parts.push(T.guardUnknown(name, this.guardWhy(mono)));
      else if (!this.canSend(guard)) parts.push(T.guardExhausted(name));
      else if (!guard.okSeen) parts.push(T.guardPending(name));
      else parts.push(T.guardWaiting(name, guard.tries));
    }
    if (this.storeUnreadable) parts.push(T.storeUnreadable);
    else if (this.saveFailed) parts.push(T.storeProblem);
    const cut = (text) => (text.length > STATUS_MAX ? `${text.slice(0, STATUS_MAX - 1)}…` : text);
    const message = both(
      cut(parts.map((p) => p.en).join(' ')),
      cut(parts.map((p) => p.fr).join(' ')),
    );
    await this.setStatus(connected, message);
  }

  // --- Configuration button -------------------------------------------------------

  /**
   * "Test the connection": a sign-in and a read of the cloud now (even after a refusal, 10 s
   * apart at most, never during a pause), then the lights connected.
   */
  async testConnection() {
    const started = this.monotonic();
    if (!this.configLoaded) {
      this.askConfig();
      await this.waitReady(started + TIMINGS.configWait);
    }
    const lang = this.config.language;
    if (this.config.error || !this.cloud) return word(T.test.config(this.config.error), lang);
    const mono = this.monotonic();
    if (this.paused(mono)) return word(T.test.paused(age(this.pauseUntil - mono)), lang);
    const left = this.lastTestAt + TIMINGS.testCooldown - mono;
    if (left > 0) return word(T.test.cooldown(age(left)), lang);
    this.lastTestAt = mono;
    // A read in progress (a start, Discover) ends first: the click gets a read of its own.
    if (this.cloudReading) await this.cloudReading.catch(() => {});
    if (!this.cloud) return word(T.test.config(this.config.error), lang);
    // A click: the session is renewed with the password typed (a refusal kept is lifted by it).
    this.cloud.session = undefined;
    const result = await this.readCloud({ force: true, click: true });
    await this.refreshStatus();
    if (result?.error) {
      if (result.error instanceof CloudError && result.error.kind === 'refused')
        return word(T.test.refused, lang);
      return word(T.test.failed(cloudReasonOf(result.error)), lang);
    }
    if (result?.skipped) {
      const wait = this.paused() ? this.pauseUntil - this.monotonic() : TIMINGS.testCooldown;
      return word(T.test.paused(age(wait)), lang);
    }
    const created = [...this.lights.values()].filter((e) => e.listed && this.createdOf(e.id));
    const reachable = created.filter((e) => e.conn && !e.conn.closed).length;
    return word(T.test.ok(this.lightCount, created.length, reachable), lang);
  }
}
