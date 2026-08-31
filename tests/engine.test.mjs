import test from "node:test";
import assert from "node:assert/strict";

import { BootSimulator } from "../src/engine.mjs";
import { MODULES, PHASES, SCENARIOS, STEPS, TASKS } from "../src/model.mjs";

const runToRun = (scenario = "normal") => {
  const simulator = new BootSimulator({ scenario });
  return { simulator, snapshot: simulator.seek(42) };
};

test("model exports cover the seven phases, 42 steps, scenarios and tasks", () => {
  assert.equal(PHASES.length, 7);
  assert.equal(STEPS.length, 42);
  assert.equal(SCENARIOS.length, 5);
  assert.deepEqual(
    TASKS.map((task) => task.period),
    [1, 5, 10, 100],
  );
  assert.deepEqual(
    STEPS.map((step) => step.id),
    Array.from({ length: 42 }, (_, index) => index + 1),
  );
});

test("the normal startup reaches RUN after all 42 steps", () => {
  const { snapshot } = runToRun();
  assert.equal(snapshot.cursor, 42);
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.ecum, "RUN");
  assert.equal(snapshot.os, "RUNNING");
  assert.equal(snapshot.rte, "RUNNING");
  assert.equal(snapshot.phase, 6);
  assert.equal(snapshot.comm.actual, "FULL_COM");
  assert.equal(snapshot.nvm.state, "READY");
  assert.equal(snapshot.nvm.source, "NVRAM");
});

test("critical APIs remain in a defensible Classic startup order", () => {
  const step = (id) => STEPS.find((item) => item.id === id);
  assert.equal(step(7).api, "EcuM_Init");
  assert.equal(step(14).api, "StartOS");
  assert.equal(step(16).api, "EcuM_StartupTwo");
  assert.equal(step(17).api, "SchM_Start");
  assert.equal(step(18).api, "BswM_Init");
  assert.equal(step(19).api, "SchM_Init");
  assert.equal(step(20).api, "SchM_StartTiming");
  assert.equal(step(26).api, "NvM_ReadAll");
  assert.equal(step(31).api, "BswM_NvM_CurrentJobMode");
  assert.equal(step(35).api, "Rte_Start");
  assert.equal(step(36).api, "Rte_Init_Startup");
  assert.equal(step(37).api, "Rte_StartTiming");
  assert.ok(step(14).id < step(16).id);
  assert.ok(step(17).id < step(18).id);
  assert.ok(step(18).id < step(19).id);
  assert.ok(step(19).id < step(20).id);
  assert.ok(step(26).id < step(31).id);
  assert.ok(step(35).id < step(36).id);
  assert.ok(step(36).id < step(37).id);
});

test("PLL failure blocks at Mcu clock status and cannot cross StartOS", () => {
  const { snapshot } = runToRun("pll-failure");
  assert.equal(snapshot.cursor, 12);
  assert.equal(snapshot.status, "blocked");
  assert.match(snapshot.blockReason, /PLL/);
  assert.equal(snapshot.os, "STOPPED");
  assert.equal(snapshot.modules.mcu, "error");
  assert.ok(snapshot.logs.some((log) => log.level === "error"));
});

test("NvM remains asynchronous and CRC fallback is explicit", () => {
  const slowSimulator = new BootSimulator({ scenario: "nvm-slow" });
  const pending = slowSimulator.seek(29);
  assert.equal(pending.nvm.state, "PENDING");
  assert.equal(pending.nvm.pending, true);
  assert.ok(pending.warnings.some((warning) => warning.includes("pending")));

  const slow = slowSimulator.seek(31);
  assert.equal(slow.nvm.state, "READY");
  assert.equal(slow.nvm.source, "NVRAM");
  assert.ok(slow.time > new BootSimulator().seek(31).time);

  const crc = new BootSimulator({ scenario: "nvm-crc" }).seek(31);
  assert.equal(crc.nvm.state, "READY");
  assert.equal(crc.nvm.source, "ROM_DEFAULT");
  assert.ok(crc.warnings.some((warning) => warning.includes("ROM 默认值")));
});

test("requested and actual communication modes stay separate", () => {
  const simulator = new BootSimulator();
  const requested = simulator.seek(32);
  assert.equal(requested.comm.requested, "FULL_COM");
  assert.equal(requested.comm.actual, "NO_COM");
  assert.equal(requested.can.actual, "NO_COM");

  const online = simulator.seek(34);
  assert.equal(online.comm.actual, "FULL_COM");
  assert.equal(online.can.actual, "FULL_COM");
  assert.equal(online.can.txEnabled, true);
});

test("seek replay is deterministic and reset restores the base state", () => {
  const bySeek = new BootSimulator().seek(42);
  const byStep = new BootSimulator();
  for (let index = 0; index < 42; index += 1) byStep.step();
  assert.deepEqual(byStep.getSnapshot(), bySeek);

  const reset = byStep.reset("can-bus-off");
  assert.equal(reset.status, "off");
  assert.equal(reset.cursor, 0);
  assert.equal(reset.scenario, "can-bus-off");
  assert.equal(reset.frames.length, 0);
});

test("snapshots are isolated and invalid cursor input throws", () => {
  const simulator = new BootSimulator();
  const snapshot = simulator.seek(10);
  snapshot.modules.ecum = "error";
  snapshot.logs.push({ seq: 999 });
  assert.notEqual(simulator.getSnapshot().modules.ecum, "error");
  assert.notEqual(simulator.getSnapshot().logs.at(-1)?.seq, 999);
  assert.throws(() => simulator.seek(-1), /cursor/);
  assert.throws(() => simulator.seek(43), /cursor/);
  assert.throws(() => simulator.reset("missing"), /unknown scenario/);
});

test("runtime scheduling is partition-invariant and non-overlapping", () => {
  for (const scenario of ["normal", "nvm-slow", "nvm-crc", "can-bus-off"]) {
    const oneShot = new BootSimulator({ scenario });
    oneShot.seek(42);
    const one = oneShot.tick(100);

    const partitioned = new BootSimulator({ scenario });
    partitioned.seek(42);
    for (let index = 0; index < 10; index += 1) partitioned.tick(10);
    const many = partitioned.getSnapshot();

    assert.deepEqual(many, one, `${scenario} must not depend on tick partitioning`);
    assert.equal(many.runtimeMs, 100);
    assert.ok(many.signals.heartbeat > 1);
    assert.ok(many.taskEvents.length > 0);
    for (let index = 1; index < many.taskEvents.length; index += 1) {
      const previous = many.taskEvents[index - 1];
      const current = many.taskEvents[index];
      assert.ok(
        current.start >= previous.start + previous.duration,
        "task events must not overlap on the single-core timeline",
      );
    }
  }
});

test("a fractional tick never publishes work or effects in the future", () => {
  const simulator = new BootSimulator();
  simulator.seek(42);
  const snapshot = simulator.tick(0.01);
  assert.equal(snapshot.runtimeMs, 0.01);
  assert.equal(snapshot.taskEvents.length, 0);
  assert.equal(snapshot.frames.length, 1, "boot heartbeat is already a completed boot step");
  assert.equal(snapshot.signals.heartbeat, 1);
  assert.ok(snapshot.cpuLoad >= 0 && snapshot.cpuLoad <= 100);
  assert.ok(snapshot.time < 121.02);
});

test("runtime buffers stay bounded and utilization is plausible", () => {
  const simulator = new BootSimulator();
  simulator.seek(42);
  const snapshot = simulator.tick(10_000);
  assert.ok(snapshot.logs.length <= 160);
  assert.ok(snapshot.taskEvents.length <= 220);
  assert.ok(snapshot.frames.length <= 80);
  assert.ok(snapshot.cpuLoad >= 0 && snapshot.cpuLoad <= 100);
  assert.ok(Math.abs(snapshot.cpuLoad - 27.4) < 0.2);
});

test("bus-off reaches RUN in SILENT_COM without successful frames", () => {
  const { simulator, snapshot: boot } = runToRun("can-bus-off");
  assert.equal(boot.can.state, "BUS_OFF");
  assert.equal(boot.can.actual, "SILENT_COM");
  assert.equal(boot.comm.actual, "SILENT_COM");
  assert.equal(boot.frames.length, 0);
  const runtime = simulator.tick(120);
  assert.equal(runtime.status, "running");
  assert.equal(runtime.frames.length, 0);
  assert.ok(runtime.warnings.some((warning) => warning.includes("Bus-Off")));
});

test("module references and APIs remain internally coherent", () => {
  const ids = new Set(MODULES.map((module) => module.id));
  for (const step of STEPS) {
    for (const moduleId of step.modules) assert.ok(ids.has(moduleId), `${step.id} references ${moduleId}`);
  }
  assert.equal(MODULES.find((module) => module.id === "cdd").layer, "abstraction");
  assert.ok(MODULES.find((module) => module.id === "wdg").apis.includes("Wdg_SetTriggerCondition"));
  assert.ok(!MODULES.find((module) => module.id === "wdg").apis.includes("Wdg_Trigger"));
});

test("invalid runtime ticks are rejected without mutating state", () => {
  const simulator = new BootSimulator();
  simulator.seek(42);
  const before = simulator.getSnapshot();
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => simulator.tick(value), /deltaMs/);
  }
  assert.deepEqual(simulator.getSnapshot(), before);
});
