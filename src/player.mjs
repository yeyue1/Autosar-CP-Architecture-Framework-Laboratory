import { STEPS, SCENARIOS } from './model.mjs';

/** Playback time is deliberately separate from the engine's virtual ECU time. */
export class LabPlayer {
  constructor(engine) {
    this.engine = engine;
    this.playing = false;
    this.speed = 1;
    this.breakpoints = new Set();
    this.elapsed = 0;
    this.stoppedAtBreakpoint = null;
    this.skipBreakpoint = null;
  }

  play() {
    const state = this.engine.getSnapshot();
    if (state.status === 'blocked') return false;
    this.skipBreakpoint = this.stoppedAtBreakpoint === state.cursor + 1
      ? this.stoppedAtBreakpoint : null;
    this.stoppedAtBreakpoint = null;
    this.playing = true;
    return true;
  }

  pause() {
    this.playing = false;
    this.elapsed = 0;
  }

  setSpeed(speed) {
    if (![0.5, 1, 2, 4, 8].includes(speed)) throw new RangeError('Unsupported playback speed.');
    this.speed = speed;
  }

  toggleBreakpoint(stepId) {
    if (!Number.isInteger(stepId) || stepId < 1 || stepId > STEPS.length) {
      throw new RangeError('Breakpoint must refer to an existing step.');
    }
    if (this.breakpoints.has(stepId)) {
      this.breakpoints.delete(stepId);
      return false;
    }
    this.breakpoints.add(stepId);
    return true;
  }

  reset(scenario = this.engine.getSnapshot().scenario) {
    if (!SCENARIOS.some(item => item.id === scenario)) throw new RangeError('Unknown scenario.');
    this.pause();
    this.stoppedAtBreakpoint = null;
    this.skipBreakpoint = null;
    return this.engine.reset(scenario);
  }

  seek(cursor) {
    this.pause();
    this.stoppedAtBreakpoint = null;
    this.skipBreakpoint = null;
    return this.engine.seek(cursor);
  }

  step() {
    this.pause();
    this.stoppedAtBreakpoint = null;
    this.skipBreakpoint = null;
    const state = this.engine.getSnapshot();
    if (state.status === 'running' && state.cursor === STEPS.length) return this.engine.tick(10);
    return this.engine.step();
  }

  advance(wallTimeMs) {
    if (!Number.isFinite(wallTimeMs) || wallTimeMs < 0) throw new RangeError('Time must be non-negative and finite.');
    if (!this.playing || wallTimeMs === 0) return { changed: false, breakpoint: null };
    let state = this.engine.getSnapshot();
    if (state.status === 'blocked') {
      this.pause();
      return { changed: false, breakpoint: null };
    }
    if (state.status === 'running' && state.cursor === STEPS.length) {
      this.engine.tick(wallTimeMs * this.speed);
      return { changed: true, breakpoint: null };
    }
    this.elapsed += wallTimeMs * this.speed;
    let changed = false;
    while (this.elapsed >= 900 && this.playing) {
      const next = state.cursor + 1;
      if (this.breakpoints.has(next) && this.skipBreakpoint !== next) {
        this.pause();
        this.stoppedAtBreakpoint = next;
        return { changed, breakpoint: next };
      }
      this.skipBreakpoint = null;
      this.elapsed -= 900;
      state = this.engine.step();
      changed = true;
      if (state.status === 'blocked') this.pause();
      if (state.cursor === STEPS.length) {
        this.elapsed = 0;
        break;
      }
    }
    return { changed, breakpoint: null };
  }
}
