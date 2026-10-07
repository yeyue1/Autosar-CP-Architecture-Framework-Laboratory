import { MODULES, PHASES, SCENARIOS, STEPS, TASKS } from "./model.mjs";

const VALID_SCENARIOS = new Set(SCENARIOS.map((scenario) => scenario.id));
const MODULE_IDS = MODULES.map((module) => module.id);
const MODULE_ID_SET = new Set(MODULE_IDS);
const STEP_COUNT = STEPS.length;
const LOG_LIMIT = 160;
const FRAME_LIMIT = 80;
const TASK_EVENT_LIMIT = 220;
const WARNING_LIMIT = 24;
const BUSY_SEGMENT_LIMIT = 512;
const EPSILON = 1e-9;
const BOOT_BASE_TIME = STEPS.reduce((sum, step) => sum + step.duration, 0);
const SCENARIO_BOOT_DELAY = Object.freeze({
  normal: 0,
  "pll-failure": 0,
  "nvm-slow": 18,
  "nvm-crc": 0,
  "can-bus-off": 0,
});

const clone = (value) => structuredClone(value);
const round3 = (value) => Number(value.toFixed(3));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const createModuleState = () =>
  Object.fromEntries(MODULE_IDS.map((id) => [id, "uninit"]));

const createRuntimeTasks = () =>
  TASKS.map((task) => ({
    ...task,
    nextRelease: 0,
  }));

const createBaseState = (scenario) => ({
  scenario,
  cursor: 0,
  status: "off",
  time: 0,
  runtimeMs: 0,
  phase: 0,
  ecum: "OFF",
  bswm: "STOPPED",
  os: "STOPPED",
  rte: "STOPPED",
  nvm: {
    state: "IDLE",
    source: "UNSET",
    pending: false,
  },
  can: {
    requested: "NO_COM",
    actual: "NO_COM",
    state: "STOPPED",
    txEnabled: false,
  },
  comm: {
    communicationAllowed: false,
    requested: "NO_COM",
    actual: "NO_COM",
  },
  cpuLoad: 0,
  modules: createModuleState(),
  activeModules: [],
  logs: [],
  taskEvents: [],
  frames: [],
  signals: {
    sensor: 0,
    filtered: 0,
    actuator: 0,
    heartbeat: 0,
  },
  blockReason: null,
  warnings: [],
});

/**
 * A deliberately small teaching model of Classic Platform startup.
 *
 * Boot steps are discrete and inspectable. RUN is a deterministic, single-core,
 * non-preemptive scheduler: releases are periodic, shorter periods win ties,
 * and a job that crosses a tick boundary is carried to the next tick. Keeping
 * that job state internally makes tick(100) equivalent to ten tick(10) calls.
 */
export class BootSimulator {
  constructor({ scenario = "normal" } = {}) {
    this._seq = 0;
    this._runtimeTasks = [];
    this._runtimeReady = [];
    this._runtimeJob = null;
    this._runtimeBusy = [];
    this._busOffLogged = false;
    this.reset(scenario);
  }

  getSnapshot() {
    return clone(this._snapshot());
  }

  reset(scenario = this.scenario) {
    this._assertScenario(scenario);
    this.scenario = scenario;
    this._state = createBaseState(scenario);
    this._runtimeTasks = createRuntimeTasks();
    this._runtimeReady = [];
    this._runtimeJob = null;
    this._runtimeBusy = [];
    this._seq = 0;
    this._busOffLogged = false;
    return this.getSnapshot();
  }

  setBusOff(enabled) {
    if (this._state.status !== "running") return this.getSnapshot();
    const busOff = Boolean(enabled);
    this._state.can.actual = busOff ? "SILENT_COM" : "FULL_COM";
    this._state.can.state = busOff ? "BUS_OFF" : "ONLINE";
    this._state.can.txEnabled = !busOff;
    this._state.comm.actual = busOff ? "SILENT_COM" : "FULL_COM";
    if (!busOff) this._busOffLogged = false;
    return this.getSnapshot();
  }

  step() {
    if (this._state.status === "blocked" || this._state.status === "running") {
      return this.getSnapshot();
    }
    if (this._state.cursor >= STEP_COUNT) {
      return this.getSnapshot();
    }

    this._applyStep(STEPS[this._state.cursor]);
    return this.getSnapshot();
  }

  seek(cursor) {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > STEP_COUNT) {
      throw new Error(`cursor must be an integer between 0 and ${STEP_COUNT}`);
    }

    if (cursor === 0) {
      return this.reset(this.scenario);
    }

    const replay = new BootSimulator({ scenario: this.scenario });
    while (
      replay._state.cursor < cursor &&
      replay._state.status !== "blocked" &&
      replay._state.status !== "running"
    ) {
      replay._applyStep(STEPS[replay._state.cursor]);
    }

    this._state = clone(replay._state);
    this._runtimeTasks = clone(replay._runtimeTasks);
    this._runtimeReady = clone(replay._runtimeReady);
    this._runtimeJob = clone(replay._runtimeJob);
    this._runtimeBusy = clone(replay._runtimeBusy);
    this._seq = replay._seq;
    this._busOffLogged = replay._busOffLogged;
    return this.getSnapshot();
  }

  tick(deltaMs = 10) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error("deltaMs must be a finite number >= 0");
    }
    if (this._state.status !== "running" || deltaMs === 0) {
      return this.getSnapshot();
    }

    const runtimeStart = this._state.runtimeMs;
    const runtimeEnd = round3(runtimeStart + deltaMs);
    let clock = runtimeStart;

    this._enqueueReleasesThrough(clock);
    while (clock < runtimeEnd - EPSILON) {
      if (!this._runtimeJob) {
        this._enqueueReleasesThrough(clock);
        if (this._runtimeReady.length === 0) {
          const nextRelease = Math.min(
            ...this._runtimeTasks.map((task) => task.nextRelease),
          );
          if (!Number.isFinite(nextRelease) || nextRelease >= runtimeEnd - EPSILON) {
            clock = runtimeEnd;
            break;
          }
          clock = round3(Math.max(clock, nextRelease));
          this._enqueueReleasesThrough(clock);
          continue;
        }

        this._runtimeReady.sort((left, right) =>
          left.task.period - right.task.period ||
          left.release - right.release ||
          left.sequence - right.sequence,
        );
        const next = this._runtimeReady.shift();
        this._runtimeJob = {
          task: next.task,
          release: next.release,
          start: round3(clock),
          remaining: next.task.duration,
          executed: 0,
        };
      }

      const job = this._runtimeJob;
      const slice = Math.min(job.remaining, runtimeEnd - clock);
      if (slice <= EPSILON) {
        break;
      }

      const sliceStart = clock;
      const sliceEnd = round3(clock + slice);
      const actualSlice = Math.max(0, sliceEnd - sliceStart);
      this._recordBusy(sliceStart, actualSlice);
      job.executed = round3(job.executed + actualSlice);
      job.remaining = round3(job.remaining - actualSlice);
      clock = sliceEnd;

      if (job.remaining > EPSILON) {
        break;
      }

      const absoluteStart = round3(this._bootBaseTime() + job.start);
      const absoluteEnd = round3(this._bootBaseTime() + job.start + job.task.duration);
      this._pushTaskEvent({
        task: job.task.name,
        start: absoluteStart,
        duration: job.task.duration,
        release: round3(job.release),
        end: absoluteEnd,
      });
      this._runTask(job.task, absoluteEnd, job.release);
      this._runtimeJob = null;
      this._enqueueReleasesThrough(clock);
    }

    this._state.runtimeMs = runtimeEnd;
    this._state.time = round3(this._bootBaseTime() + runtimeEnd);
    this._updateCpuLoad();
    this._syncActiveModules();
    return this.getSnapshot();
  }

  _snapshot() {
    return {
      ...this._state,
      activeModules: [...this._state.activeModules],
      logs: clone(this._state.logs),
      taskEvents: clone(this._state.taskEvents),
      frames: clone(this._state.frames),
      signals: clone(this._state.signals),
      warnings: [...this._state.warnings],
      modules: { ...this._state.modules },
      nvm: clone(this._state.nvm),
      can: clone(this._state.can),
      comm: clone(this._state.comm),
    };
  }

  _assertScenario(scenario) {
    if (!VALID_SCENARIOS.has(scenario)) {
      throw new Error(`unknown scenario: ${scenario}`);
    }
  }

  _applyStep(step) {
    const state = this._state;
    state.status = "booting";
    state.cursor = step.id;
    state.phase = step.phase;
    const scenarioDelay = step.id === 29 ? SCENARIO_BOOT_DELAY[this.scenario] ?? 0 : 0;
    state.time = round3(state.time + step.duration + scenarioDelay);

    this._activateModules(step.modules);
    this._pushLog({
      time: state.time,
      level: "info",
      source: step.caller,
      message: `${step.api}: ${step.title}`,
      stepId: step.id,
    });

    switch (step.id) {
      case 1:
        state.modules.power = "active";
        break;
      case 12:
        if (this.scenario === "pll-failure") {
          state.modules.mcu = "error";
          state.status = "blocked";
          state.blockReason =
            "PLL 锁定失败，教学模型不会继续越过 Mcu_DistributePllClock / StartOS。";
          this._pushWarning(state.blockReason);
          this._pushLog({
            time: state.time,
            level: "error",
            source: "mcu",
            message: "Mcu_GetPllStatus did not reach MCU_PLL_LOCKED before project timeout.",
            stepId: step.id,
          });
        }
        break;
      case 7:
        state.ecum = "STARTUP_ONE";
        break;
      case 11:
        state.modules.wdg = "active";
        break;
      case 14:
        state.os = "RUNNING";
        break;
      case 16:
        state.ecum = "STARTUP_TWO";
        break;
      case 18:
        state.bswm = "STARTUP";
        break;
      case 20:
        this._pushWarning(
          "从这里开始允许通过 SchM 周期推进异步服务，后续 BSW 排布属于示例配置。",
        );
        break;
      case 21:
        this._pushWarning(
          "Board_PostOsHook 仅为教学示例，用来展示项目自定义 post-OS 钩子。",
        );
        break;
      case 25:
        state.nvm = {
          state: "IDLE",
          source: "NVRAM",
          pending: false,
        };
        break;
      case 26:
        state.nvm = {
          state: "PENDING",
          source: "NVRAM",
          pending: true,
        };
        break;
      case 29:
        if (this.scenario === "nvm-slow") {
          this._pushWarning(
            "NvM_ReadAll 在 slow 场景下仍处于 pending，完成时刻依赖后续 MainFunction 轮询。",
          );
          this._pushLog({
            time: state.time,
            level: "warn",
            source: "nvm",
            message: "NvM_ReadAll still pending after the extended polling window (+18 ms).",
            stepId: step.id,
          });
        }
        break;
      case 30:
        state.comm.communicationAllowed = false;
        state.comm.requested = "NO_COM";
        state.comm.actual = "NO_COM";
        break;
      case 31:
        if (this.scenario === "nvm-crc") {
          state.nvm = {
            state: "READY",
            source: "ROM_DEFAULT",
            pending: false,
          };
          this._pushWarning(
            "NvM CRC 失败后装载 ROM 默认值继续启动，这是教学示例策略。",
          );
          this._pushLog({
            time: state.time,
            level: "warn",
            source: "nvm",
            message: "CRC mismatch detected, fallback to ROM defaults.",
            stepId: step.id,
          });
        } else {
          state.nvm = {
            state: "READY",
            source: "NVRAM",
            pending: false,
          };
          if (this.scenario === "nvm-slow") {
            this._pushLog({
              time: state.time,
              level: "info",
              source: "nvm",
              message: "NvM_ReadAll completed after extended polling.",
              stepId: step.id,
            });
          }
        }
        break;
      case 32:
        state.comm.communicationAllowed = true;
        state.comm.requested = "FULL_COM";
        state.can.requested = "FULL_COM";
        state.can.state = "REQUESTED";
        break;
      case 33:
        state.can.state = "STARTING";
        break;
      case 34:
        if (this.scenario === "can-bus-off") {
          state.can.actual = "SILENT_COM";
          state.can.state = "BUS_OFF";
          state.can.txEnabled = false;
          state.comm.actual = "SILENT_COM";
          this._pushWarning(
            "CAN 进入 Bus-Off；系统仍可 RUN，但会停在 SILENT_COM，不会产生成功的 CAN 发送帧。",
          );
          this._pushLog({
            time: state.time,
            level: "error",
            source: "cansm",
            message: "Bus-off reported by CanSM; ComM actual mode is SILENT_COM.",
            stepId: step.id,
          });
        } else {
          state.can.actual = "FULL_COM";
          state.can.state = "ONLINE";
          state.can.txEnabled = true;
          state.comm.actual = "FULL_COM";
        }
        break;
      case 35:
        state.rte = "INITIALIZED";
        break;
      case 37:
        state.rte = "RUNNING";
        state.bswm = "APP_RUN_PENDING";
        this._pushWarning(
          "把应用 runnable 放在网络上线后统一放开是项目门控示例，不是 AUTOSAR 普遍硬约束。",
        );
        break;
      case 38:
        state.signals.sensor = 51.2;
        break;
      case 39:
        state.signals.filtered = 50.6;
        state.signals.actuator = 18.4;
        break;
      case 40:
        state.signals.heartbeat = 1;
        if (state.can.txEnabled) {
          this._pushFrame({
            time: state.time,
            id: "0x5A0",
            direction: "TX",
            data: [1, 18, 50, 0],
            label: "Boot Heartbeat",
          });
        }
        break;
      case 42:
        state.ecum = "RUN";
        state.bswm = "APP_RUN";
        state.status = "running";
        this._runtimeTasks = createRuntimeTasks();
        this._runtimeReady = [];
        this._runtimeJob = null;
        this._runtimeBusy = [];
        this._pushLog({
          time: state.time,
          level: "info",
          source: "ecum",
          message: "Boot sequence complete, runtime scheduler enabled.",
          stepId: step.id,
        });
        break;
      default:
        break;
    }

    this._syncActiveModules();
  }

  _activateModules(moduleIds) {
    const current = new Set(moduleIds.filter((id) => MODULE_ID_SET.has(id)));
    for (const id of MODULE_IDS) {
      if (this._state.modules[id] === "active" && !current.has(id)) {
        this._state.modules[id] = "ready";
      }
    }
    for (const id of current) {
      if (this._state.modules[id] !== "error") {
        this._state.modules[id] = "active";
      }
    }
  }

  _syncActiveModules() {
    // `ready` means initialized earlier; the UI's active rail is reserved for
    // the module touched by the current boot step or currently running task.
    this._state.activeModules = MODULE_IDS.filter(
      (id) => this._state.modules[id] === "active",
    );
  }

  _pushLog(entry) {
    this._state.logs.push({
      seq: ++this._seq,
      ...entry,
    });
    if (this._state.logs.length > LOG_LIMIT) {
      this._state.logs.splice(0, this._state.logs.length - LOG_LIMIT);
    }
  }

  _pushWarning(message) {
    if (!this._state.warnings.includes(message)) {
      this._state.warnings.push(message);
      if (this._state.warnings.length > WARNING_LIMIT) {
        this._state.warnings.splice(
          0,
          this._state.warnings.length - WARNING_LIMIT,
        );
      }
    }
  }

  _pushFrame(frame) {
    this._state.frames.push(frame);
    if (this._state.frames.length > FRAME_LIMIT) {
      this._state.frames.splice(0, this._state.frames.length - FRAME_LIMIT);
    }
  }

  _pushTaskEvent(event) {
    this._state.taskEvents.push(event);
    if (this._state.taskEvents.length > TASK_EVENT_LIMIT) {
      this._state.taskEvents.splice(
        0,
        this._state.taskEvents.length - TASK_EVENT_LIMIT,
      );
    }
  }

  _bootBaseTime() {
    return BOOT_BASE_TIME + (SCENARIO_BOOT_DELAY[this.scenario] ?? 0);
  }

  _enqueueReleasesThrough(clock) {
    for (const task of this._runtimeTasks) {
      while (task.nextRelease <= clock + EPSILON) {
        this._runtimeReady.push({
          task,
          release: round3(task.nextRelease),
          sequence: task.nextRelease,
        });
        task.nextRelease = round3(task.nextRelease + task.period);
      }
    }
  }

  _recordBusy(start, duration) {
    if (duration <= EPSILON) return;
    this._runtimeBusy.push({ start: round3(start), duration: round3(duration) });
    if (this._runtimeBusy.length > BUSY_SEGMENT_LIMIT) {
      this._runtimeBusy.splice(0, this._runtimeBusy.length - BUSY_SEGMENT_LIMIT);
    }
  }

  _runTask(task, absoluteTime, release) {
    switch (task.id) {
      case "task-1ms":
        this._activateModules(["rte", "sensor", "adc", "wdgif"]);
        this._state.signals.sensor = Number(
          (
            50 +
            Math.sin(release / 9) * 8 +
            Math.cos(release / 21) * 2
          ).toFixed(2),
        );
        break;
      case "task-5ms":
        this._activateModules(["rte", "controller"]);
        this._state.signals.filtered = Number(
          (
            this._state.signals.filtered * 0.78 +
            this._state.signals.sensor * 0.22
          ).toFixed(2),
        );
        this._state.signals.actuator = Number(
          clamp((this._state.signals.filtered - 48) * 1.6, 0, 100).toFixed(2),
        );
        break;
      case "task-10ms":
        this._activateModules(["rte", "actuator", "com", "canif"]);
        this._state.signals.heartbeat += 1;
        if (this._state.can.txEnabled) {
          this._pushFrame({
            time: absoluteTime,
            id: "0x5A0",
            direction: "TX",
            data: [
              this._state.signals.heartbeat & 0xff,
              Math.round(this._state.signals.actuator),
              Math.round(this._state.signals.filtered),
              Math.round(this._state.signals.sensor),
            ],
            label: "Heartbeat",
          });
        } else if (this.scenario === "can-bus-off" && !this._busOffLogged) {
          this._busOffLogged = true;
          this._pushLog({
            time: absoluteTime,
            level: "warn",
            source: "com",
            message: "Heartbeat suppressed because CAN actual mode is SILENT_COM.",
            stepId: 40,
          });
        }
        break;
      case "task-100ms":
        this._activateModules(["rte", "logger", "dem", "wdgm"]);
        this._pushLog({
          time: absoluteTime,
          level: "info",
          source: "logger",
          message: `Runtime snapshot hb=${this._state.signals.heartbeat}, actuator=${this._state.signals.actuator.toFixed(1)}`,
          stepId: 41,
        });
        break;
      default:
        break;
    }
  }

  _updateCpuLoad() {
    const now = this._state.runtimeMs;
    const window = Math.min(100, Math.max(EPSILON, now));
    const cutoff = now - window;
    let busy = 0;
    for (const segment of this._runtimeBusy) {
      const segmentEnd = segment.start + segment.duration;
      busy += Math.max(
        0,
        Math.min(segmentEnd, now) - Math.max(segment.start, cutoff),
      );
    }
    this._runtimeBusy = this._runtimeBusy.filter(
      (segment) => segment.start + segment.duration > cutoff - EPSILON,
    );
    this._state.cpuLoad = Number(
      clamp((busy / window) * 100, 0, 100).toFixed(1),
    );
  }
}

export { PHASES };
