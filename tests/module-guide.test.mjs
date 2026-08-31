import test from 'node:test';
import assert from 'node:assert/strict';

import { ARCHITECTURE_FLOWS, getModuleGuide, getStepRole } from '../src/module-guide.mjs';
import { MODULES, STEPS } from '../src/model.mjs';

test('architecture learning flows only reference known modules and cover the full diagram', () => {
  const moduleIds = new Set(MODULES.map((module) => module.id));
  const covered = new Set();
  for (const flow of ARCHITECTURE_FLOWS) {
    assert.ok(flow.id && flow.label && flow.description);
    assert.equal(new Set(flow.modules).size, flow.modules.length, `${flow.id} contains duplicate nodes`);
    for (const id of flow.modules) {
      assert.ok(moduleIds.has(id), `${flow.id} references unknown module ${id}`);
      covered.add(id);
    }
  }
  assert.deepEqual([...covered].sort(), [...moduleIds].sort());
});

test('every module produces a coherent guide derived from the startup model', () => {
  for (const module of MODULES) {
    const guide = getModuleGuide(module.id);
    assert.equal(guide.module, module);
    assert.ok(guide.startupRole.length > 10);
    assert.ok(guide.runtimeRole.length > 10);
    assert.ok(guide.caution.length > 10);
    assert.deepEqual(guide.steps.map((step) => step.id), [...guide.steps.map((step) => step.id)].sort((a, b) => a - b));
    for (const step of guide.steps) assert.ok(step.modules.includes(module.id));
  }
});

test('central module guides expose expected lifecycle and architecture relationships', () => {
  const ecum = getModuleGuide('ecum');
  assert.equal(ecum.firstStep.id, 7);
  assert.ok(ecum.flows.some((flow) => flow.id === 'startup-control'));
  assert.ok(ecum.downstream.some((module) => module.id === 'os'));

  const nvm = getModuleGuide('nvm');
  assert.ok(nvm.steps.some((step) => step.api === 'NvM_ReadAll'));
  assert.ok(nvm.flows.some((flow) => flow.id === 'persistent-storage'));
  assert.ok(nvm.downstream.some((module) => module.id === 'memif'));

  const dcm = getModuleGuide('dcm');
  assert.deepEqual(dcm.flows.find((flow) => flow.id === 'diagnostic').modules, ['candrv', 'canif', 'cantp', 'pdur', 'dcm', 'dem']);
  assert.ok(dcm.upstream.some((module) => module.id === 'pdur'));
  assert.ok(dcm.downstream.some((module) => module.id === 'dem'));

  const rte = getModuleGuide('rte');
  assert.ok(rte.steps.some((step) => step.api === 'Rte_Start'));
  assert.ok(rte.flows.length >= 4);
});

test('step roles distinguish caller, target and collaborating participants', () => {
  const direct = STEPS.find((step) => step.caller === 'ecum' && step.target === 'os');
  assert.equal(getStepRole(direct, 'ecum'), '发起调用');
  assert.equal(getStepRole(direct, 'os'), '主要目标');
  const collaborator = direct.modules.find((id) => id !== direct.caller && id !== direct.target);
  if (collaborator) assert.equal(getStepRole(direct, collaborator), '协同参与');
  assert.throws(() => getModuleGuide('missing-module'), RangeError);
});
