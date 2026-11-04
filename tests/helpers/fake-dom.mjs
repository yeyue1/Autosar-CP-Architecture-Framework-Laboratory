// 零依赖的最小 DOM 桩，供进程内测试使用（本沙箱 spawn 管道 stdio 会 EPERM，
// 因此不能起真实浏览器或 node --test 的子进程模型）。
//
// 目标不是「完整实现 DOM」，而是刚好够让真实的 src/dom-update.mjs（updateHtml）
// 在其上完成「解析 HTML → 按节点类型与身份属性 patch」的全流程，
// 这样测试验证的是组件确实复用了 updateHtml，而不是绕开它。
//
// 需要真实浏览器级别的验证请用 scripts/browser-verify.mjs。

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : raw;
  });
}

export class FakeText {
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

/** 极简 classList：读写的是 class 属性，因此与 updateHtml 的属性 patch 保持一致。 */
class FakeClassList {
  constructor(element) { this.element = element; }
  get tokens() {
    const raw = this.element.getAttribute('class') || '';
    return raw.split(/\s+/).filter(Boolean);
  }
  write(tokens) {
    if (tokens.length) this.element.setAttribute('class', tokens.join(' '));
    else this.element.removeAttribute('class');
  }
  contains(name) { return this.tokens.includes(String(name)); }
  add(...names) {
    const tokens = this.tokens;
    for (const name of names) if (!tokens.includes(String(name))) tokens.push(String(name));
    this.write(tokens);
  }
  remove(...names) {
    const drop = names.map(String);
    this.write(this.tokens.filter(token => !drop.includes(token)));
  }
  toggle(name, force) {
    const key = String(name);
    const has = this.contains(key);
    const next = force === undefined ? !has : Boolean(force);
    if (next && !has) this.add(key);
    if (!next && has) this.remove(key);
    return next;
  }
  get value() { return this.tokens.join(' '); }
  toString() { return this.value; }
}

export class FakeElement {
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
    // 阅读器需要：滚动位置、相对偏移、滚动行为记录。
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.offsetTop = 0;
    this.offsetHeight = 0;
    this.scrollIntoViewCalls = [];
    this.classList = new FakeClassList(this);
  }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get textContent() { return this.childNodes.map(node => node.textContent ?? '').join(''); }
  set textContent(value) {
    this.childNodes = [];
    const text = String(value ?? '');
    if (text) this.appendChild(new FakeText(text));
  }
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
    copy.scrollTop = this.scrollTop;
    copy.offsetTop = this.offsetTop;
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
  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  blur() {
    this.focused = false;
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }
  scrollIntoView(options) {
    this.scrollIntoViewCalls.push(options ?? null);
    if (this.parentNode && 'scrollTop' in this.parentNode) {
      this.parentNode.scrollTop = Math.max(0, this.offsetTop);
    }
  }
}

class FakeTemplate {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.content = { childNodes: [] };
  }
  set innerHTML(html) { this.content = { childNodes: parseHtml(html, this.ownerDocument) }; }
  get innerHTML() { return this.content.childNodes.map(serializeNode).join(''); }
}

export class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.listeners = new Map();
  }
  createElement(name) {
    return String(name).toLowerCase() === 'template' ? new FakeTemplate(this) : new FakeElement(name, this);
  }
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
  /** 派发文档级事件（例如 keydown），target 默认指向 activeElement。 */
  dispatch(type, event = {}) {
    const payload = {
      type,
      target: this.activeElement,
      preventDefault() {},
      ...event,
    };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(payload);
    return payload;
  }
}

export function detachNode(node) {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index >= 0) parent.childNodes.splice(index, 1);
  node.parentNode = null;
}

export function parseHtml(html, ownerDocument) {
  const roots = [];
  const stack = [{ childNodes: roots }];
  // 按文档顺序给每个元素一个递增的 offsetTop，让滚动定位逻辑有可验证的几何量。
  // 真实浏览器里这个值由排版算出；桩里只需要单调且确定。
  let order = 0;
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
    order += 1;
    element.offsetTop = order * 40;
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

export function matchesSelector(node, selector) {
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

export function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  const attributes = node.attributes.map(item => ` ${item.name}="${escapeText(item.value)}"`).join('');
  const tag = node.nodeName.toLowerCase();
  return `<${tag}${attributes}>${node.childNodes.map(serializeNode).join('')}</${tag}>`;
}

/** 把桩树序列化成 HTML 字符串，便于断言。 */
export const outerHtml = root => root.childNodes.map(serializeNode).join('');

/** 造一个已挂载到 FakeDocument 的根节点。 */
export function createRoot(id = 'knowledge-content') {
  const document = new FakeDocument();
  const root = document.createElement('div');
  if (id) root.setAttribute('id', id);
  return { document, root };
}
