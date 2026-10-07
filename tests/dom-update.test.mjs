import test from 'node:test';
import assert from 'node:assert/strict';
import { updateHtml } from '../src/dom-update.mjs';

// Deliberately small DOM fixture: templates resolve only named test trees. The
// browser regression owns native hover, focus, selection and click behavior.
class FixtureNode {
  constructor(document, name, attributes = {}, children = [], nodeType = 1) {
    this.ownerDocument = document;
    this.nodeName = name;
    this.nodeType = nodeType;
    this.nodeValue = nodeType === 3 ? String(attributes) : null;
    this.attributeMap = new Map(nodeType === 1 ? Object.entries(attributes) : []);
    this.childNodes = [];
    this.parentNode = null;
    this.value = attributes.value ?? '';
    this.checked = Object.hasOwn(attributes, 'checked');
    for (const child of children) this.insertBefore(child, null);
  }
  get attributes() { return [...this.attributeMap].map(([name, value]) => ({ name, value })); }
  get lastChild() { return this.childNodes.at(-1); }
  getAttribute(name) { return this.attributeMap.get(name) ?? null; }
  hasAttribute(name) { return this.attributeMap.has(name); }
  setAttribute(name, value) { this.attributeMap.set(name, String(value)); }
  removeAttribute(name) { this.attributeMap.delete(name); }
  insertBefore(child, reference) {
    child.remove();
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    assert.ok(index >= 0, 'reference node must belong to its parent');
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  cloneNode(deep) {
    const clone = new FixtureNode(this.ownerDocument, this.nodeName,
      this.nodeType === 3 ? this.nodeValue : Object.fromEntries(this.attributeMap),
      deep ? this.childNodes.map(child => child.cloneNode(true)) : [], this.nodeType);
    clone.value = this.value;
    clone.checked = this.checked;
    return clone;
  }
}

function fixture(builders) {
  const document = {
    createElement(name) {
      assert.equal(name, 'template');
      return {
        content: null,
        set innerHTML(value) {
          assert.ok(builders[value], `unknown fixture: ${value}`);
          this.content = new FixtureNode(document, '#document-fragment', {}, builders[value](document), 11);
        },
      };
    },
  };
  return new FixtureNode(document, 'DIV');
}

const element = (document, name, attributes = {}, children = []) => new FixtureNode(document, name, attributes, children);
const text = (document, value) => new FixtureNode(document, '#text', value, [], 3);
const button = (document, attributes, label) => element(document, 'BUTTON', attributes, [text(document, label)]);

test('clock refresh keeps pressed control nodes and updates only changed text', () => {
  const clockTree = value => document => [element(document, 'SECTION', {}, [
    button(document, { 'data-ext': 'protect', class: 'button' }, '开启写保护'),
    element(document, 'SPAN', { id: 'clock' }, [text(document, value)]),
  ])];
  const root = fixture({ initial: clockTree('0 ms'), tick: clockTree('80 ms'), later: clockTree('160 ms') });
  updateHtml(root, 'initial');
  const section = root.childNodes[0];
  const control = section.childNodes[0];
  const clock = section.childNodes[1];
  const clockText = clock.childNodes[0];

  updateHtml(root, 'tick');
  updateHtml(root, 'later');

  assert.equal(root.childNodes[0], section);
  assert.equal(section.childNodes[0], control);
  assert.equal(section.childNodes[1], clock);
  assert.equal(clock.childNodes[0], clockText);
  assert.equal(clockText.nodeValue, '160 ms');
});

test('control labels, disabled state and other attributes change in place', () => {
  const root = fixture({
    paused: document => [button(document, { 'data-system-action': 'play', class: 'button', title: 'start' }, '▶ 播放')],
    running: document => [button(document, { 'data-system-action': 'play', class: 'button playing', disabled: '', 'aria-pressed': 'true' }, 'Ⅱ 暂停')],
  });
  updateHtml(root, 'paused');
  const control = root.childNodes[0];
  const label = control.childNodes[0];
  updateHtml(root, 'running');
  assert.equal(root.childNodes[0], control);
  assert.equal(control.childNodes[0], label);
  assert.equal(label.nodeValue, 'Ⅱ 暂停');
  assert.equal(control.getAttribute('class'), 'button playing');
  assert.ok(control.hasAttribute('disabled'));
  assert.equal(control.getAttribute('aria-pressed'), 'true');
  assert.equal(control.getAttribute('title'), null);

  updateHtml(root, 'paused');
  assert.equal(root.childNodes[0], control);
  assert.equal(control.hasAttribute('disabled'), false);
  assert.equal(control.hasAttribute('aria-pressed'), false);
});

test('keyed sibling insertion, removal and reorder preserve surviving identities', () => {
  const list = ids => document => ids.map(id => button(document, { id }, id));
  const root = fixture({ initial: list(['a', 'b', 'c']), changed: list(['c', 'new', 'a']) });
  updateHtml(root, 'initial');
  const [a, b, c] = root.childNodes;
  updateHtml(root, 'changed');
  assert.equal(root.childNodes[0], c);
  assert.equal(root.childNodes[1].getAttribute('id'), 'new');
  assert.equal(root.childNodes[2], a);
  assert.equal(b.parentNode, null);
  assert.equal(root.childNodes.length, 3);
});

test('compound action and ECU or filter keys cannot reuse a different control', () => {
  const root = fixture({
    initial: document => [
      button(document, { 'data-ext': 'bus-off', 'data-ecu': 'gateway' }, 'Gateway'),
      button(document, { 'data-ext': 'bus-off', 'data-ecu': 'body' }, 'Body'),
      button(document, { 'data-ext': 'filter', 'data-kind': 'ALL' }, 'ALL'),
      button(document, { 'data-ext': 'filter', 'data-kind': 'NM' }, 'NM'),
    ],
    reordered: document => [
      button(document, { 'data-ext': 'filter', 'data-kind': 'NM' }, 'NM'),
      button(document, { 'data-ext': 'bus-off', 'data-ecu': 'body' }, 'Body'),
      button(document, { 'data-ext': 'filter', 'data-kind': 'ALL' }, 'ALL'),
      button(document, { 'data-ext': 'bus-off', 'data-ecu': 'gateway' }, 'Gateway'),
    ],
  });
  updateHtml(root, 'initial');
  const [gateway, body, all, nm] = root.childNodes;
  updateHtml(root, 'reordered');
  assert.deepEqual(root.childNodes, [nm, body, all, gateway]);
});

const formTree = defaults => document => {
  const input = element(document, 'INPUT', { name: 'gain', value: defaults.gain, type: 'number' });
  const checkbox = element(document, 'INPUT', { name: 'enabled', type: 'checkbox', ...(defaults.enabled ? { checked: '' } : {}) });
  const select = element(document, 'SELECT', { name: 'mode' }, ['classic', 'fd'].map(mode => element(document, 'OPTION', {
    value: mode, ...(mode === defaults.mode ? { selected: '' } : {}),
  }, [text(document, mode)])));
  select.value = defaults.mode;
  const textarea = element(document, 'TEXTAREA', { name: 'note' }, [text(document, defaults.note)]);
  textarea.value = defaults.note;
  return [element(document, 'FORM', { 'data-form': 'calibrate' }, [input, checkbox, select, textarea])];
};

test('same ECU refresh preserves input, checkbox, select and textarea drafts', () => {
  const root = fixture({ initial: formTree({ gain: '1', enabled: false, mode: 'classic', note: 'initial' }), next: formTree({ gain: '2', enabled: true, mode: 'fd', note: 'fresh' }) });
  updateHtml(root, 'initial');
  const form = root.childNodes[0];
  const [input, checkbox, select, textarea] = form.childNodes;
  input.value = '2.4'; checkbox.checked = false; select.value = 'classic'; textarea.value = 'draft';

  updateHtml(root, 'next', { preserveFormValues: true });

  assert.equal(root.childNodes[0], form);
  assert.deepEqual(form.childNodes, [input, checkbox, select, textarea]);
  assert.equal(input.value, '2.4');
  assert.equal(checkbox.checked, false);
  assert.equal(select.value, 'classic');
  assert.equal(textarea.value, 'draft');
  assert.equal(input.getAttribute('value'), '1');
  assert.equal(select.childNodes[0].hasAttribute('selected'), true);
  assert.equal(select.childNodes[1].hasAttribute('selected'), false);
});

test('ECU reset restores incoming form defaults without replacing form controls', () => {
  const root = fixture({ initial: formTree({ gain: '1', enabled: false, mode: 'classic', note: 'initial' }), reset: formTree({ gain: '2', enabled: true, mode: 'fd', note: 'reset' }) });
  updateHtml(root, 'initial');
  const form = root.childNodes[0];
  const [input, checkbox, select, textarea] = form.childNodes;
  input.value = '9'; checkbox.checked = false; select.value = 'classic'; textarea.value = 'draft';

  updateHtml(root, 'reset');

  assert.equal(root.childNodes[0], form);
  assert.deepEqual(form.childNodes, [input, checkbox, select, textarea]);
  assert.equal(input.value, '2');
  assert.equal(checkbox.checked, true);
  assert.equal(select.value, 'fd');
  assert.equal(textarea.value, 'reset');
  assert.equal(input.getAttribute('value'), '2');
  assert.equal(checkbox.hasAttribute('checked'), true);
  assert.equal(select.childNodes[0].hasAttribute('selected'), false);
  assert.equal(select.childNodes[1].hasAttribute('selected'), true);
});
