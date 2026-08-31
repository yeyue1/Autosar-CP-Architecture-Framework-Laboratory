import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SYSTEM_LAB_PROFILES,
  SystemArchitectureSimulator,
  getSystemLabProfile,
} from '../src/system-lab.mjs';

test('system architecture profiles have coherent nodes, groups, flows and ordered steps', () => {
  assert.deepEqual(SYSTEM_LAB_PROFILES.map((profile) => profile.id), ['cdd', 'multi-ecu', 'multi-core']);
  for (const profile of SYSTEM_LAB_PROFILES) {
    const nodeIds = new Set(profile.nodes.map((node) => node.id));
    assert.equal(nodeIds.size, profile.nodes.length);
    assert.deepEqual(profile.steps.map((step) => step.id), profile.steps.map((_, index) => index + 1));
    assert.ok(profile.summary.length > 20);
    assert.ok(profile.distinction.length > 20);
    for (const group of profile.groups) for (const id of group.nodes) assert.ok(nodeIds.has(id), `${profile.id} group references ${id}`);
    for (const flow of profile.flows) {
      assert.ok(nodeIds.has(flow.from), `${profile.id} flow source ${flow.from}`);
      assert.ok(nodeIds.has(flow.to), `${profile.id} flow target ${flow.to}`);
    }
    for (const step of profile.steps) {
      for (const id of step.actors) assert.ok(nodeIds.has(id), `${profile.id} step actor ${id}`);
      for (const id of Object.keys(step.changes)) assert.ok(nodeIds.has(id), `${profile.id} step change ${id}`);
    }
  }
});

test('every normal architecture profile reaches a complete observable state', () => {
  for (const profile of SYSTEM_LAB_PROFILES) {
    const simulator = new SystemArchitectureSimulator(profile.id);
    const snapshot = simulator.runToEnd();
    assert.equal(snapshot.status, 'complete');
    assert.equal(snapshot.cursor, profile.steps.length);
    assert.equal(snapshot.progress, 1);
    assert.ok(Object.values(snapshot.nodeStates).every((status) => status !== 'waiting'));
    assert.equal(snapshot.logs.length, profile.steps.length);
  }
});

test('CDD lab demonstrates constrained hardware access and blocks unsafe publication', () => {
  const profile = getSystemLabProfile('cdd');
  assert.ok(profile.nodes.some((node) => node.id === 'cdd-angle'));
  assert.ok(profile.flows.some((flow) => flow.from === 'cdd-angle' && flow.to === 'rte-port'));
  assert.ok(profile.concepts.some((concept) => /临界|并发/.test(`${concept.title}${concept.text}`)));

  const simulator = new SystemArchitectureSimulator('cdd', 'fault');
  const snapshot = simulator.runToEnd();
  assert.equal(snapshot.status, 'blocked');
  assert.equal(snapshot.nodeStates['cdd-angle'], 'error');
  assert.equal(snapshot.nodeStates['sensor-swc'], 'waiting');
  assert.match(snapshot.blockReason, /禁止向 RTE 发布/);
});

test('multi-ECU lab keeps ECU ownership independent and supports degraded convergence', () => {
  const profile = getSystemLabProfile('multi-ecu');
  const ecuNodes = profile.nodes.filter((node) => /独立 ECU/.test(node.owner));
  assert.ok(ecuNodes.length >= 4);
  assert.match(profile.distinction, /每个 ECU.*EcuM.*OS/);

  const simulator = new SystemArchitectureSimulator('multi-ecu', 'fault');
  const snapshot = simulator.runToEnd();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.nodeStates.body, 'error');
  assert.equal(snapshot.nodeStates.gateway, 'online');
  assert.equal(snapshot.nodeStates.availability, 'online');
  assert.match(snapshot.degradedReason, /Body ECU/);
});

test('multi-core lab starts secondary cores before OS and blocks on a missing core barrier', () => {
  const profile = getSystemLabProfile('multi-core');
  const startCore = profile.steps.findIndex((step) => step.api.includes('StartCore'));
  const startOs = profile.steps.findIndex((step) => step.api.includes('StartOS'));
  assert.ok(startCore >= 0 && startCore < startOs);
  assert.ok(profile.nodes.filter((node) => /^core\d$/.test(node.id)).length >= 3);
  assert.ok(profile.nodes.some((node) => node.id === 'ioc'));
  assert.ok(profile.nodes.some((node) => node.id === 'spinlock'));

  const simulator = new SystemArchitectureSimulator('multi-core', 'fault');
  const snapshot = simulator.runToEnd();
  assert.equal(snapshot.status, 'blocked');
  assert.equal(snapshot.cursor, profile.fault.blockAt);
  assert.equal(snapshot.nodeStates.core2, 'error');
  assert.equal(snapshot.nodeStates.barrier, 'error');
  assert.equal(snapshot.nodeStates['comm-app'], 'waiting');
});

test('system architecture replay is deterministic, isolated and validates inputs', () => {
  const simulator = new SystemArchitectureSimulator('multi-core');
  const first = simulator.seek(5);
  first.nodeStates.core0 = 'tampered';
  assert.notEqual(simulator.getSnapshot().nodeStates.core0, 'tampered');
  assert.deepEqual(simulator.seek(5), simulator.seek(5));
  assert.equal(simulator.selectProfile('multi-ecu').cursor, 0);
  assert.equal(simulator.selectScenario('fault').scenarioId, 'fault');
  assert.throws(() => simulator.seek(-1), RangeError);
  assert.throws(() => simulator.selectProfile('missing'), RangeError);
  assert.throws(() => simulator.selectScenario('missing'), RangeError);
  assert.throws(() => getSystemLabProfile('missing'), RangeError);
});
