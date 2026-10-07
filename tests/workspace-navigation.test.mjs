import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const vehicleStyles = await readFile(new URL('../src/vehicle.css', import.meta.url), 'utf8');

test('all seven learning labs are peer workspaces', () => {
  const ids = ['startup', 'uds', 'system', 'communication', 'storage', 'scheduler', 'calibration'];
  for (const id of ids) {
    assert.match(index, new RegExp(`data-lab-view="${id}"`));
    assert.match(index, new RegExp(`<section id="${id}-workspace"[^>]+role="tabpanel"`));
  }
  assert.doesNotMatch(index, /<dialog id="(?:uds|system)-dialog"/);
});

test('workspace switching keeps one visible panel and preserves simulator instances', () => {
  assert.match(app, /let activeWorkspace = 'startup'/);
  assert.match(app, /function switchWorkspace\(workspaceId, systemProfileId = null\)/);
  assert.match(app, /\$\(config\.panel\)\.hidden = !selected/);
  assert.match(app, /const vehicle = new VehicleSimulator\(\)/);
  assert.match(app, /const diagnosticViews = new Map\(\)/);
  assert.match(app, /if \(workspaceId !== 'system'\) stopSystemPlayback\(\)/);
  assert.match(app, /activeWorkspace !== 'startup'/);
  assert.doesNotMatch(app, /\$\('(?:uds|system)-workspace'\)\.showModal/);
});

test('full workspaces remove dialog size limits and expose a responsive top-level switcher', () => {
  assert.match(styles, /\.lab-switcher\{/);
  assert.match(styles, /\.lab-full-workspace\{/);
  assert.match(styles, /\.uds-dialog\.lab-full-workspace \.uds-body\{/);
  assert.match(styles, /\.system-dialog\.lab-full-workspace \.system-lab-body\{/);
  assert.match(vehicleStyles, /grid-template-columns:\s*repeat\(7,\s*minmax\(1(?:12|50|55)px,\s*1fr\)\)/);
  assert.match(vehicleStyles, /overflow-x:\s*auto/);
});
