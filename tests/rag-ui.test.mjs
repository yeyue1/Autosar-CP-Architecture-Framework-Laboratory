// 知识库检索 UI 的进程内测试：零依赖、不 spawn 子进程（本沙箱 pipe stdio 会 EPERM）。
// 自带一个最小 DOM 桩，足以让真实的 src/dom-update.mjs（updateHtml）在其上做
// 「解析 HTML → 按节点类型/身份属性 patch」的完整流程，因此能验证组件确实复用了 updateHtml。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RagWorkspaceUi } from '../src/rag-ui.mjs';

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : raw;
  });
}

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeName = '#text';
    this.nodeValue = String(value);
    this.childNodes = [];
    this.parentNode = null;
  }
  get textContent() { return this.nodeValue; }
  cloneNode() { return new FakeText(this.nodeValue); }
  remove() { detachNode(this); }
}

class FakeElement {
  constructor(name, ownerDocument = null) {
    this.nodeType = 1;
    this.nodeName = String(name).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = [];
    this.childNodes = [];
    this.parentNode = null;
    this.value = '';
    this.checked = false;
    this.focused = false;
    this.listeners = new Map();
  }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get textContent() { return this.childNodes.map(node => node.textContent ?? '').join(''); }
  getAttribute(name) {
    const found = this.attributes.find(item => item.name === name);
    return found ? found.value : null;
  }
  hasAttribute(name) { return this.attributes.some(item => item.name === name); }
  setAttribute(name, value) {
    const next = String(value);
    const found = this.attributes.find(item => item.name === name);
    if (found) found.value = next; else this.attributes.push({ name, value: next });
    if (this.nodeName === 'INPUT' && name === 'value') this.value = next;
  }
  removeAttribute(name) {
    const index = this.attributes.findIndex(item => item.name === name);
    if (index >= 0) this.attributes.splice(index, 1);
  }
  insertBefore(node, reference) {
    if (node.parentNode) detachNode(node);
    node.parentNode = this;
    if (!reference) { this.childNodes.push(node); return node; }
    const index = this.childNodes.indexOf(reference);
    if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node);
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  cloneNode(deep) {
    const copy = new FakeElement(this.nodeName.toLowerCase(), this.ownerDocument);
    copy.attributes = this.attributes.map(item => ({ ...item }));
    copy.value = this.value;
    copy.checked = this.checked;
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  remove() { detachNode(this); }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    if (!list.includes(handler)) list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
  dispatch(type, event = {}) {
    const payload = { type, target: this, preventDefault() {}, ...event };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(payload);
    return payload;
  }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (matchesSelector(child, selector)) found.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return found;
  }
  focus() { this.focused = true; }
}

class FakeTemplate {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.content = { childNodes: [] };
  }
  set innerHTML(html) { this.content = { childNodes: parseHtml(html, this.ownerDocument) }; }
  get innerHTML() { return this.content.childNodes.map(serializeNode).join(''); }
}

class FakeDocument {
  createElement(name) {
    return String(name).toLowerCase() === 'template' ? new FakeTemplate(this) : new FakeElement(name, this);
  }
}

function detachNode(node) {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index >= 0) parent.childNodes.splice(index, 1);
  node.parentNode = null;
}

function parseHtml(html, ownerDocument) {
  const roots = [];
  const stack = [{ childNodes: roots }];
  const append = node => {
    const parent = stack[stack.length - 1];
    parent.childNodes.push(node);
    node.parentNode = parent === stack[0] ? null : parent;
  };
  const tokenizer = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let cursor = 0;
  let token;
  while ((token = tokenizer.exec(html))) {
    if (token.index > cursor) {
      const text = decodeEntities(html.slice(cursor, token.index));
      if (text) append(new FakeText(text));
    }
    cursor = tokenizer.lastIndex;
    if (token[0].startsWith('<!--')) continue;
    if (token[1]) {
      const name = token[1].toUpperCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].nodeName === name) { stack.length = index; break; }
      }
      continue;
    }
    const element = new FakeElement(token[2], ownerDocument);
    const attributePattern = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
    let attribute;
    while ((attribute = attributePattern.exec(token[3] || ''))) {
      const rawValue = attribute[3] ?? attribute[4] ?? attribute[5] ?? '';
      element.setAttribute(attribute[1], decodeEntities(rawValue));
    }
    append(element);
    if (!VOID_ELEMENTS.has(element.nodeName.toLowerCase()) && token[4] !== '/') stack.push(element);
  }
  if (cursor < html.length) {
    const text = decodeEntities(html.slice(cursor));
    if (text) append(new FakeText(text));
  }
  return roots;
}

function matchesSelector(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  const value = String(selector).trim();
  if (value.startsWith('#')) return node.getAttribute('id') === value.slice(1);
  if (value.startsWith('.')) return (node.getAttribute('class') || '').split(/\s+/).includes(value.slice(1));
  const head = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/.exec(value);
  if (!head) return false;
  const [, tag, rest] = head;
  if (!tag && !rest) return false;
  if (tag && node.nodeName !== tag.toUpperCase()) return false;
  const attributePattern = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let attribute;
  while ((attribute = attributePattern.exec(rest || ''))) {
    const current = node.getAttribute(attribute[1]);
    if (current === null) return false;
    const expected = attribute[2] ?? attribute[3] ?? attribute[4];
    if (expected !== undefined && current !== expected) return false;
  }
  return true;
}

function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  const attributes = node.attributes.map(item => ` ${item.name}="${escapeText(item.value)}"`).join('');
  return `<${node.nodeName.toLowerCase()}${attributes}>${node.childNodes.map(serializeNode).join('')}</${node.nodeName.toLowerCase()}>`;
}

const outerHtml = root => root.childNodes.map(serializeNode).join('');

function createRoot() {
  const document = new FakeDocument();
  const root = document.createElement('div');
  root.setAttribute('id', 'knowledge-content');
  return { document, root };
}

// ---------------------------------------------------------------------------
// 假 RagService（契约 3.5 的接口形状）
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: 'startup', label: '启动与 EcuM', order: 1, count: 30 },
  { id: 'uds', label: '诊断与刷写', order: 2, count: 28 },
  { id: 'methodology', label: '方法论与工程实践', order: 8, count: 12 },
];

const ECUM_TEXT = 'EcuM 完成 StartupTwo 之后调用 StartOS，控制权边界就在这里交给 OS。';

function makeHit(overrides = {}) {
  return {
    chunkId: 'startup-ecum-flexible#1',
    docId: 'startup-ecum-flexible',
    docTitle: 'EcuM Flexible 启动顺序',
    heading: 'StartOS 是控制权边界',
    text: ECUM_TEXT,
    category: 'startup',
    tags: ['EcuM', 'StartOS'],
    sourcePath: 'knowledge/06-startup-ecum.md',
    score: 2.3456,
    matched: ['ecum', 'startos'],
    highlights: [[0, 4]],
    level: 2,
    ...overrides,
  };
}

function makeAnswer(query) {
  return {
    query,
    coverage: 'high',
    sentences: [
      { text: ECUM_TEXT, chunkId: 'startup-ecum-flexible#1', docTitle: 'EcuM Flexible 启动顺序', heading: 'StartOS 是控制权边界', score: 3.2 },
      { text: 'BswM 在 RTE 启动前后接管模式请求，不直接参与启动顺序。', chunkId: 'startup-bswm#1', docTitle: 'BswM 模式管理', heading: 'BswM 的时机', score: 2.1 },
    ],
    citations: [
      { index: 1, chunkId: 'startup-ecum-flexible#1', docTitle: 'EcuM Flexible 启动顺序', heading: 'StartOS 是控制权边界', sourcePath: 'knowledge/06-startup-ecum.md' },
      { index: 2, chunkId: 'startup-bswm#1', docTitle: 'BswM 模式管理', heading: 'BswM 的时机', sourcePath: 'knowledge/07-bswm.md' },
    ],
    relatedTerms: ['StartOS', 'BswM'],
    followUps: ['EcuM 与 BswM 的调用顺序', 'StartOS 之后中断何时打开'],
    boundary: '教学仿真不等同量产 EcuM 配置。',
  };
}

function makeService(overrides = {}) {
  const state = {
    status: overrides.status ?? 'ready',
    stats: overrides.stats === undefined ? { status: 'ready', size: 3, documents: 2, categories: CATEGORIES, loadMs: 12.4 } : overrides.stats,
  };
  const calls = { load: 0, search: [], answer: [], suggest: [], related: [] };
  const service = {
    calls,
    error: overrides.error ?? null,
    get status() { return state.status; },
    set status(value) { state.status = value; },
    stats() { return state.stats; },
    load() { calls.load += 1; return Promise.resolve(); },
    search(query, options = {}) {
      calls.search.push({ query, options });
      return overrides.search ? overrides.search(query, options) : [makeHit()];
    },
    answer(query) {
      calls.answer.push(query);
      return overrides.answer ? overrides.answer(query) : makeAnswer(query);
    },
    suggest(query, options = {}) {
      calls.suggest.push({ query, options });
      return overrides.suggest ? overrides.suggest(query, options) : [];
    },
    related(chunkId, options = {}) {
      calls.related.push({ chunkId, options });
      return overrides.related ? overrides.related(chunkId, options) : [makeHit({ chunkId: 'startup-ecum-flexible#2', heading: 'BswM 与 EcuM 的交接' })];
    },
  };
  return service;
}

function mountUi(uiOptions = {}, serviceOptions = {}) {
  const { root, document } = createRoot();
  const service = mountUi.service ?? makeService(serviceOptions);
  const notes = [];
  const navigations = [];
  const ui = new RagWorkspaceUi({
    service,
    notify: (message, isError) => notes.push({ message, isError }),
    onNavigateLab: workspaceId => navigations.push(workspaceId),
    ...uiOptions,
  });
  ui.mount(root);
  return { root, document, service, ui, notes, navigations, html: () => outerHtml(root) };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('mount 只绑定一次事件委托', () => {
  const { root, ui } = mountUi();
  ui.mount(root);
  ui.mount(root);
  assert.equal(root.listenerCount('click'), 1);
  assert.equal(root.listenerCount('submit'), 1);
  assert.equal(root.listenerCount('input'), 1);
});

test('render 幂等：连续重绘不改变 DOM 结构', () => {
  const { ui, html } = mountUi();
  const first = html();
  ui.render();
  ui.render();
  assert.equal(html(), first);
  assert.match(first, /rag-workspace/);
});

test('dispose 解绑监听且之后的操作不再触发检索', () => {
  const { root, service, ui } = mountUi();
  ui.query = '启动顺序';
  ui.runSearch();
  const before = service.calls.search.length;
  ui.dispose();
  assert.equal(root.listenerCount('click'), 0);
  assert.equal(root.listenerCount('submit'), 0);
  assert.equal(root.listenerCount('input'), 0);
  root.dispatch('submit', { target: root });
  ui.dispose(); // 二次 dispose 安全
  assert.equal(service.calls.search.length, before);
});

test('idle 状态：mount 自动调用一次 service.load()，并渲染加载态', () => {
  const service = makeService({ status: 'idle', stats: null });
  const { root, html } = (() => {
    const { root, document } = createRoot();
    const ui = new RagWorkspaceUi({ service });
    ui.mount(root);
    assert.equal(service.calls.load, 1);
    return { root, html: () => outerHtml(root) };
  })();
  assert.match(html(), /正在构建知识索引/);
  assert.match(html(), /rag-skeleton/);
});

test('loading 状态：骨架 + 索引构建提示', () => {
  const { html } = mountUi({}, { status: 'loading', stats: null });
  assert.match(html(), /rag-state-loading/);
  assert.match(html(), /rag-skeleton/);
  assert.match(html(), /索引构建中/);
});

test('ready + 空查询：引导态给出示例查询按钮', () => {
  const { html, root } = mountUi();
  assert.match(html(), /从示例问题开始/);
  const examples = root.querySelectorAll('[data-rag-action="ask"]');
  assert.ok(examples.length >= 3, '应有多个示例查询按钮');
  assert.match(html(), /data-rag-q=/);
});

test('无结果态：提示 + suggest() 建议 + 清空按钮', () => {
  const { root, service, html } = mountUi({}, {
    search: () => [],
    suggest: () => ['EcuM 启动', 'StartOS'],
  });
  const input = root.querySelector('#rag-query');
  input.value = '不存在的词';
  root.dispatch('submit', { target: root });
  assert.equal(service.calls.search.length, 1);
  assert.match(html(), /没有找到匹配的知识片段/);
  assert.match(html(), /EcuM 启动/);
  assert.match(html(), /data-rag-action="clear"/);
});

test('error 状态：显示失败原因，点「重试」调用 service.load()', async () => {
  const service = makeService({ status: 'error', error: new Error('corpus.json 读取失败'), stats: null });
  const { root, html } = (() => {
    const { root } = createRoot();
    const ui = new RagWorkspaceUi({ service });
    ui.mount(root);
    return { root, html: () => outerHtml(root) };
  })();
  assert.match(html(), /索引加载失败/);
  assert.match(html(), /corpus\.json 读取失败/);
  const retry = root.querySelector('[data-rag-action="retry"]');
  assert.ok(retry, '失败态必须有重试按钮');
  root.dispatch('click', { target: retry });
  assert.equal(service.calls.load, 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.match(html(), /重试加载/);
});

test('所有语料文本 HTML 转义（含 <script> 的 chunk）', () => {
  const hostile = '<script>alert("xss")</script> EcuM 启动流程';
  const { root, ui, html } = mountUi({}, {
    // highlights 必须留空：高亮会把文本切片并插入 <mark>，那样「&lt;script&gt;」就不再连续，
    // 这条用例要验证的是转义本身，不是高亮。
    search: () => [makeHit({ text: hostile, heading: '<img src=x onerror=1>', docTitle: 'A & B "quoted"', highlights: [] })],
    answer: query => makeAnswer(query),
  });
  ui.query = '启动';
  ui.runSearch();
  const output = html();
  assert.match(output, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  assert.ok(!output.includes('<script>'), '不得输出未转义的 <script>');
  assert.ok(!output.includes('<img'), '不得输出未转义的 <img>');
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match(output, /A &amp; B &quot;quoted&quot;/);
});

test('highlights 区间渲染为 <mark data-rag-hl>', () => {
  const text = 'EcuM 完成 StartupTwo 后调用 StartOS。';
  const startupAt = text.indexOf('StartupTwo');
  const { ui, html } = mountUi({}, {
    search: () => [makeHit({ text, highlights: [[0, 4], [startupAt, startupAt + 'StartupTwo'.length]] })],
  });
  ui.query = 'EcuM';
  ui.runSearch();
  const output = html();
  // 属性值可能序列化为 `data-rag-hl` 或 `data-rag-hl=""`，二者等价，这里都接受。
  assert.match(output, /<mark data-rag-hl(?:="")?>EcuM<\/mark>/);
  assert.match(output, /<mark data-rag-hl(?:="")?>StartupTwo<\/mark>/);
  assert.equal((output.match(/<mark /g) || []).length, 2);
});

test('分类 chip 过滤：切换后 service.search 带上 category', () => {
  const { root, service, html } = mountUi();
  const input = root.querySelector('#rag-query');
  input.value = 'StartOS';
  root.dispatch('submit', { target: root });
  assert.deepEqual(service.calls.search[0].options.category, null);

  const chip = root.querySelector('[data-rag-category="uds"]');
  assert.ok(chip, '应渲染分类 chip');
  root.dispatch('click', { target: chip });
  const last = service.calls.search.at(-1);
  assert.equal(last.options.category, 'uds');
  assert.match(html(), /data-rag-category="uds"[^>]*aria-pressed="true"/);
  assert.match(html(), /诊断与刷写/);
});

test('followUp 点击 = 以该文本发起新检索', () => {
  const { root, service, ui } = mountUi();
  ui.query = '启动顺序';
  ui.runSearch();
  const followUp = root.querySelector('[data-rag-q="EcuM 与 BswM 的调用顺序"]');
  assert.ok(followUp, '答案面板应渲染追问按钮');
  root.dispatch('click', { target: followUp });
  assert.equal(service.calls.search.at(-1).query, 'EcuM 与 BswM 的调用顺序');
  assert.equal(ui.query, 'EcuM 与 BswM 的调用顺序');
  assert.equal(root.querySelector('#rag-query').value, 'EcuM 与 BswM 的调用顺序');
});

test('复用 updateHtml：重绘保持输入框节点身份（不是 innerHTML 重建）', () => {
  const { root, ui } = mountUi();
  const inputBefore = root.querySelector('#rag-query');
  inputBefore.focus();
  inputBefore.value = 'EcuM';
  ui.runSearch();
  ui.render();
  const inputAfter = root.querySelector('#rag-query');
  assert.equal(inputAfter, inputBefore, '输入框应是同一个节点实例');
  assert.equal(inputAfter.focused, true, '焦点状态不应丢失');
  assert.equal(inputAfter.value, 'EcuM', '用户输入不应被重绘覆盖');
  assert.equal(root.querySelectorAll('#rag-query').length, 1);
});

test('点击结果卡片：选中 chunk 并渲染 service.related()', () => {
  const { root, service, ui, html } = mountUi();
  ui.query = '启动顺序';
  ui.runSearch();
  const card = root.querySelectorAll('[data-rag-action="select"]')[0];
  assert.ok(card, '应有结果卡片');
  root.dispatch('click', { target: card });
  assert.equal(service.calls.related.length, 1);
  assert.equal(service.calls.related[0].chunkId, 'startup-ecum-flexible#1');
  assert.match(html(), /相关条目/);
  assert.match(html(), /BswM 与 EcuM 的交接/);
  assert.match(html(), /data-selected="true"/);
});

test('答案面板：coverage 徽标、上标引用、引用列表与边界提醒', () => {
  const { ui, html } = mountUi();
  ui.query = '启动顺序';
  ui.runSearch();
  const output = html();
  assert.match(output, /data-coverage="high"/);
  assert.match(output, /覆盖充分/);
  assert.match(output, /<sup class="rag-cite"[^>]*>\[1\]<\/sup>/);
  assert.match(output, /<sup class="rag-cite"[^>]*>\[2\]<\/sup>/);
  assert.match(output, /knowledge\/06-startup-ecum\.md/);
  assert.match(output, /边界提醒/);
  assert.match(output, /教学仿真不等同量产 EcuM 配置/);
  assert.match(output, /继续追问/);
  assert.match(output, /相关术语/);
});

test('coverage 四色：low/none 都能渲染对应 data-coverage', () => {
  for (const coverage of ['high', 'medium', 'low', 'none']) {
    const { ui, html } = mountUi({}, {
      search: () => [makeHit()],
      answer: query => ({ ...makeAnswer(query), coverage }),
    });
    ui.query = '启动';
    ui.runSearch();
    assert.match(html(), new RegExp(`data-coverage="${coverage}"`));
  }
});

test('「前往对应实验」：startup 映射到 startup，methodology 不显示按钮', () => {
  const { root, navigations, ui } = mountUi();
  ui.query = '启动';
  ui.runSearch();
  const nav = root.querySelector('[data-rag-lab="startup"]');
  assert.ok(nav, 'startup 分类应有跳转按钮');
  root.dispatch('click', { target: nav });
  assert.deepEqual(navigations, ['startup']);

  ui.hits = [makeHit({ chunkId: 'm#1', category: 'methodology' })];
  ui.render();
  assert.equal(root.querySelectorAll('[data-rag-lab]').length, 0, 'methodology 无对应实验，不应渲染按钮');
});

test('/ 快捷键按钮聚焦搜索框，Enter 提交触达 service.search', () => {
  const { root, service, ui } = mountUi();
  const kbd = root.querySelector('[data-rag-action="focus-search"]');
  assert.ok(kbd);
  root.dispatch('click', { target: kbd });
  assert.equal(root.querySelector('#rag-query').focused, true);

  ui.query = 'NvM';
  root.dispatch('submit', { target: root });
  assert.equal(service.calls.search.at(-1).query, 'NvM');
});

test('输入防抖：input 事件延迟后只检索一次', async () => {
  const { root, service, ui } = mountUi();
  ui.debounceMs = 5;
  const input = root.querySelector('#rag-query');
  input.value = 'EcuM';
  root.dispatch('input', { target: input });
  const baseline = service.calls.search.length;
  assert.equal(service.calls.search.length, baseline, '防抖期间不应立即检索');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(service.calls.search.length, baseline + 1);
  assert.equal(service.calls.search.at(-1).query, 'EcuM');
});

test('status 条与 aria-live 播报结果数', () => {
  const { ui, html } = mountUi();
  ui.query = '启动';
  ui.runSearch();
  const output = html();
  assert.match(output, /找到 1 条结果/);
  assert.match(output, /aria-live="polite"/);
  assert.match(output, /3 段/);
  assert.match(output, /12 ms/);
});

test('源码契约：不使用 innerHTML 赋值，只 import dom-update', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/rag-ui.mjs', import.meta.url)), 'utf8');
  assert.ok(!/\binnerHTML\s*=/.test(source), '不得直接写 innerHTML');
  assert.ok(!/\.innerHTML\b/.test(source), '不得读写 innerHTML');
  const imports = [...source.matchAll(/^import\s+.*?from\s+'([^']+)';/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['./dom-update.mjs']);
  assert.ok(!/fetch\(|XMLHttpRequest|https?:\/\//.test(source), '不得发起外部请求');
});

test('CSS 契约：只出现 .rag- 前缀类，含两个断点', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/rag.css', import.meta.url)), 'utf8');
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]);
  const offenders = [...new Set(classes)].filter(name => !name.startsWith('rag-'));
  assert.deepEqual(offenders, [], `发现非 .rag- 前缀选择器：${offenders.join(', ')}`);
  assert.match(css, /@media\(max-width:1100px\)/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /var\(--green,#0f766e\)/);
  assert.match(css, /#fff3c4/);
});
