// 应用内原文阅读器：把「查看原文」从跳转裸 Markdown 变成排版良好、可定位、
// 可回溯检索上下文的阅读面板。
//
// 设计约束（本项目一贯要求）：
// - 零第三方依赖，纯浏览器 ES module；
// - 不用 innerHTML 整段重建，统一走 dom-update 的 updateHtml；
// - 所有注入文本先转义；正文 HTML 只来自 article.mjs 的渲染结果（其内部已转义）；
// - 加载失败不抛未捕获异常，必须给用户可重试的出口。

import { updateHtml } from './dom-update.mjs';
import { findSection, parseArticle, renderArticle } from './rag/article.mjs';

/** 目标小节高亮保留时长（毫秒）；淡出由 CSS 过渡完成。 */
const TARGET_HOLD_MS = 2400;
/** 目录跟随滚动的判定偏移，略大于正文上内边距，避免"当前小节"滞后。 */
const TOC_OFFSET = 28;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** HTML 转义。宁可多转义，也不要出现属性注入。 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只允许同源相对路径与 http(s)；挡住 javascript:/data: 之类。 */
function safeHref(path) {
  const value = String(path ?? '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return /^https?:/i.test(value) ? value : '';
  return value;
}

/** 拼接 basePath 与资源路径，避免出现 `//` 或丢掉分隔符。 */
function joinPath(base, path) {
  const raw = String(path ?? '');
  if (!base) return raw;
  const left = String(base).replace(/\/+$/, '');
  const right = raw.replace(/^\/+/, '');
  return right ? `${left}/${right}` : left;
}

/** 从 chunkId 兜底推断锚点：`docId#n` → 该文档第 n 个小节。 */
function sectionFromChunkId(article, chunkId) {
  const raw = String(chunkId ?? '');
  const at = raw.lastIndexOf('#');
  if (at <= 0) return null;
  const docId = raw.slice(0, at);
  const ordinal = Number(raw.slice(at + 1));
  if (!Number.isInteger(ordinal) || ordinal < 1) return null;
  const document = (article?.documents ?? []).find(item => item?.id === docId);
  const section = document?.sections?.[ordinal - 1];
  return section ? { document, section } : null;
}

/**
 * 把某个节点滚到滚动容器的顶部附近。
 * 优先用 getBoundingClientRect 做相对位移：offsetTop 依赖 offsetParent，容易在
 * 嵌套布局里算错，而 scrollIntoView 会把外层的窗口也一起滚，导致面板背后的页面跳动。
 * behavior 显式传给 scrollTo，避免依赖 CSS 的 scroll-behavior（那会让首次定位
 * 变成一段动画，用户第一眼看到的是文章开头而不是被引用的那一段）。
 */
function scrollNodeInto(container, node, { offset = 10, smooth = false } = {}) {
  if (!container || !node) return;
  let target = null;
  const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
  const box = typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : null;
  if (rect && box && Number.isFinite(rect.top) && Number.isFinite(box.top)) {
    target = Math.max(0, Number(container.scrollTop || 0) + (rect.top - box.top) - offset);
  } else if (typeof node.offsetTop === 'number') {
    target = Math.max(0, node.offsetTop - offset);
  }

  if (target === null) {
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' });
    return;
  }

  if (smooth && typeof container.scrollTo === 'function') {
    container.scrollTo({ top: target, behavior: 'smooth' });
    return;
  }
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: target, behavior: 'instant' });
    // scrollTo 在部分环境下是异步生效的，兜底再直接赋一次值。
    if (Number(container.scrollTop || 0) !== target) container.scrollTop = target;
    return;
  }
  container.scrollTop = target;
}

/** 给节点打上定位高亮；优先用 class，退化为属性。 */
function markTarget(node, on, useClass) {
  if (!node) return;
  if (useClass) {
    if (on) node.classList?.add('is-target');
    else node.classList?.remove('is-target');
    return;
  }
  if (on) node.setAttribute?.('data-rag-target', 'true');
  else node.removeAttribute?.('data-rag-target');
}

export class ArticleReader {
  /**
   * @param {object} [options]
   * @param {typeof fetch|null} [options.fetchImpl] 便于测试注入
   * @param {string} [options.basePath] 资源前缀
   * @param {Function|null} [options.onClose] 面板关闭回调
   * @param {object|null} [options.deps] 注入 { parseArticle, renderArticle, findSection }
   */
  constructor({ fetchImpl = null, basePath = '', onClose = null, deps = null } = {}) {
    this.fetchImpl = fetchImpl;
    this.basePath = String(basePath ?? '');
    this.onClose = typeof onClose === 'function' ? onClose : null;
    this.deps = {
      parseArticle: deps?.parseArticle ?? parseArticle,
      renderArticle: deps?.renderArticle ?? renderArticle,
      findSection: deps?.findSection ?? findSection,
    };

    this.root = null;
    this.shell = null;
    this.mounted = false;
    this.disposed = false;

    this.state = 'idle'; // idle | loading | ready | error
    this.open_ = false;
    this.path = '';
    this.anchor = '';
    this.query = '';
    this.article = null;
    this.target = null;
    this.errorMessage = '';
    this.activeAnchor = '';
    this.tocVisible = true;

    this.holdTimer = null;
    this.fadeTimer = null;
    this.token = 0; // 防止旧请求覆盖新请求
    this.returnFocus = null;

    this.onClick = event => this.handleClick(event);
    this.onKeyDown = event => this.handleKeyDown(event);
    this.onContentScroll = () => this.syncToc();
  }

  get isOpen() {
    return this.open_;
  }

  // ---------- 生命周期 ----------

  mount(root) {
    if (!root) return;
    this.disposed = false;
    this.root = root;

    if (!this.shell || this.shell.parentNode !== root) {
      const doc = root.ownerDocument ?? root;
      const shell = doc.createElement('div');
      shell.setAttribute('data-rag-reader', '');
      root.appendChild(shell);
      this.shell = shell;
      shell.addEventListener('click', this.onClick);
    }
    this.mounted = true;
    this.render();
  }

  dispose() {
    this.disposed = true;
    this.clearTimers();
    this.detachGlobal();
    if (this.shell) {
      this.shell.removeEventListener('click', this.onClick);
      if (this.shell.remove) this.shell.remove();
      else if (this.shell.parentNode) this.shell.parentNode.removeChild(this.shell);
    }
    this.shell = null;
    this.root = null;
    this.mounted = false;
    this.open_ = false;
    this.article = null;
    this.state = 'idle';
  }

  // ---------- 打开 / 关闭 ----------

  async open({ path, anchor = '', chunkId = '', query = '' } = {}) {
    if (this.disposed) return;
    const target = String(path ?? '').trim();
    if (!target) return;

    const previousOpen = this.open_;
    this.path = target;
    this.anchor = String(anchor ?? '').trim();
    this.chunkId = String(chunkId ?? '').trim();
    this.query = String(query ?? '').trim();
    this.article = null;
    this.target = null;
    this.errorMessage = '';
    this.activeAnchor = '';
    this.state = 'loading';
    this.open_ = true;

    if (!previousOpen) {
      this.returnFocus = this.currentFocus();
      this.attachGlobal();
    }
    this.render();
    this.focusPanel();

    const token = ++this.token;
    try {
      const source = await this.loadSource(target);
      if (token !== this.token || this.disposed) return;

      const article = this.deps.parseArticle(source, { path: target });
      const located = this.locate(article);
      this.article = article;
      this.target = located;
      this.activeAnchor = located?.section?.anchor ?? '';
      this.state = 'ready';
      this.render();
      this.focusPanel();
      this.revealTarget();
    } catch (error) {
      if (token !== this.token || this.disposed) return;
      this.state = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error ?? '未知错误');
      this.render();
      this.focusPanel();
    }
  }

  close() {
    if (this.disposed || !this.open_) return;
    this.open_ = false;
    this.token += 1; // 让在途请求失效
    this.clearTimers();
    this.detachGlobal();
    this.state = 'idle';
    this.article = null;
    this.target = null;
    this.errorMessage = '';
    this.render();

    const back = this.returnFocus;
    this.returnFocus = null;
    if (back && typeof back.focus === 'function') back.focus();
    if (this.onClose) this.onClose();
  }

  // ---------- 数据 ----------

  async loadSource(path) {
    const impl = this.fetchImpl ?? (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
    if (typeof impl !== 'function') throw new Error('当前环境没有可用的 fetch，无法读取原文。');

    const url = joinPath(this.basePath, path);
    const response = await impl(url, { headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.5' } });
    if (response && response.ok === false) {
      const status = Number(response.status) || 0;
      throw new Error(`读取 ${path} 失败${status ? `（HTTP ${status}）` : ''}。`);
    }
    const text = await response.text();
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${path} 内容为空。`);
    return text;
  }

  /** 优先用显式锚点；其次按 chunkId 兜底；都没有就取第一个文档的第一节。 */
  locate(article) {
    if (this.anchor) {
      const found = this.deps.findSection(article, this.anchor);
      if (found) return found;
    }
    if (this.chunkId) {
      const found = sectionFromChunkId(article, this.chunkId);
      if (found) return found;
    }
    const document = article?.documents?.[0];
    const section = document?.sections?.[0];
    return section ? { document, section } : null;
  }

  // ---------- 渲染 ----------

  html() {
    if (!this.shell) return '';
    const open = this.open_ ? 'true' : 'false';
    const rawHref = safeHref(this.path);
    return `<div class="rag-reader-shell" data-open="${open}" role="dialog" aria-modal="true" `
      + `aria-labelledby="rag-reader-title" aria-hidden="${this.open_ ? 'false' : 'true'}">`
      + '<div class="rag-reader-backdrop" data-rag-reader-action="close" aria-hidden="true"></div>'
      + '<aside class="rag-reader-panel" tabindex="-1">'
      + this.headerHtml(rawHref)
      + this.bodyHtml()
      + '</aside></div>';
  }

  headerHtml(rawHref) {
    const document = this.target?.document ?? this.article?.documents?.[0] ?? null;
    const title = document?.title || this.path || '原文';
    const crumb = this.query
      ? `<p class="rag-reader-crumb"><span>来自检索</span><q>${esc(this.query)}</q></p>`
      : '';
    return '<header class="rag-reader-bar">'
      + '<div class="rag-reader-bar-main">'
      + '<span class="rag-reader-kicker">知识库原文</span>'
      + `<h2 class="rag-reader-title" id="rag-reader-title">${esc(title)}</h2>`
      + crumb
      + '</div>'
      + '<div class="rag-reader-bar-actions">'
      + (rawHref ? `<a class="rag-reader-raw" href="${esc(rawHref)}" target="_blank" rel="noreferrer" title="在浏览器新标签中查看未渲染的 .md 文件" aria-label="在新标签打开原始 Markdown"><span class="rag-reader-raw-label">原始 Markdown ↗</span></a>` : '')
      + '<button type="button" class="rag-reader-close" data-rag-reader-action="close" aria-label="关闭阅读器">'
      + '<span aria-hidden="true">×</span></button>'
      + '</div></header>';
  }

  bodyHtml() {
    if (this.state === 'loading') return this.loadingHtml();
    if (this.state === 'error') return this.errorHtml();
    if (this.state === 'ready') {
      const toc = this.tocHtml();
      return '<div class="rag-reader-body" data-toc="' + (toc ? 'true' : 'false') + '">'
        + toc
        + `<div class="rag-reader-content" tabindex="0" data-rag-reader-content>${this.articleHtml()}</div>`
        + '</div>';
    }
    return '<div class="rag-reader-body"><div class="rag-reader-content"></div></div>';
  }

  loadingHtml() {
    return '<div class="rag-reader-body"><div class="rag-reader-loading" role="status">'
      + '<span class="rag-reader-spinner" aria-hidden="true"></span>'
      + '<strong>正在读取原文…</strong>'
      + `<p>${esc(this.path)}</p>`
      + '<div class="rag-reader-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div>'
      + '</div></div>';
  }

  errorHtml() {
    return '<div class="rag-reader-body"><div class="rag-reader-error" role="alert">'
      + '<strong>原文加载失败</strong>'
      + `<p>${esc(this.errorMessage || '未知错误')}</p>`
      + `<p class="rag-reader-error-path">${esc(this.path)}</p>`
      + '<p class="rag-reader-error-hint">本阅读器只读取随仓库分发的 <code>knowledge/*.md</code>；'
      + '若文件确实存在，请确认本地服务已把 <code>/knowledge/</code> 路径放行。</p>'
      + '<div class="rag-reader-error-actions">'
      + '<button type="button" class="rag-reader-retry" data-rag-reader-action="retry">重试</button>'
      + '<button type="button" class="rag-reader-dismiss" data-rag-reader-action="close">关闭</button>'
      + '</div></div></div>';
  }

  tocHtml() {
    const documents = Array.isArray(this.article?.documents) ? this.article.documents : [];
    if (!documents.length) return '';
    const currentDocId = this.target?.document?.id;
    const blocks = documents.map(document => {
      const items = (document.sections ?? []).map(section => {
        const active = section.anchor === this.activeAnchor;
        return `<li><button type="button" class="rag-reader-toc-link${active ? ' is-active' : ''}" `
          + `data-rag-reader-anchor="${esc(section.anchor)}" `
          + `data-rag-reader-goto="${esc(section.anchor)}" `
          + `aria-current="${active ? 'true' : 'false'}">${esc(section.heading)}</button></li>`;
      }).join('');
      const heading = documents.length > 1
        ? `<span class="rag-reader-toc-doc${document.id === currentDocId ? ' is-current' : ''}">${esc(document.title)}</span>`
        : '';
      return `<div class="rag-reader-toc-group">${heading}<ul class="rag-reader-toc-list">${items}</ul></div>`;
    }).join('');
    return '<nav class="rag-reader-toc" aria-label="文章目录"><span class="rag-reader-toc-title">目录</span>'
      + blocks + '</nav>';
  }

  articleHtml() {
    const documents = Array.isArray(this.article?.documents) ? this.article.documents : [];
    if (!documents.length) {
      return '<p class="rag-reader-empty">这篇原文里没有可显示的小节。</p>';
    }
    const targetAnchor = this.target?.section?.anchor ?? '';
    // renderArticle 内部已完成转义，这里只负责给它挂上"本文定位"的语义标记。
    const rendered = this.deps.renderArticle(this.article, { anchorPrefix: '' });
    return `<div class="rag-reader-article" data-target="${esc(targetAnchor)}">${rendered}</div>`;
  }

  render() {
    if (!this.shell || this.disposed) return;
    updateHtml(this.shell, this.html(), { preserveFormValues: true });
    this.bindContentScroll();
  }

  // ---------- 定位与高亮 ----------

  bindContentScroll() {
    const content = this.contentNode();
    if (!content) return;
    if (this.scrollBound === content) return;
    if (this.scrollBound && this.scrollBound.removeEventListener) {
      this.scrollBound.removeEventListener('scroll', this.onContentScroll);
    }
    if (content.addEventListener) content.addEventListener('scroll', this.onContentScroll);
    this.scrollBound = content;
  }

  contentNode() {
    return this.shell?.querySelector?.('[data-rag-reader-content]') ?? null;
  }

  sectionNode(anchor) {
    const content = this.contentNode();
    if (!content || !anchor) return null;
    const escaped = String(anchor).replace(/["\\]/g, '\\$&');
    const direct = content.querySelector?.(`[id="${escaped}"]`);
    if (direct) return direct;
    // 有些桩实现不支持属性选择器，退化成遍历。
    const nodes = content.querySelectorAll?.('[id]') ?? [];
    for (const node of nodes) {
      if (node.getAttribute && node.getAttribute('id') === anchor) return node;
    }
    return null;
  }

  /** 滚动到目标小节并加高亮；首次定位用瞬时滚动（见 revealTarget 注释）。 */
  revealTarget() {
    const anchor = this.target?.section?.anchor;
    if (!anchor) return;
    const node = this.sectionNode(anchor);
    const content = this.contentNode();
    if (node) {
      // 初次定位瞬时到位：用户的意图是「带我到被引用的那一段」，
      // 平滑动画在低性能设备或截图时反而显得没生效。平滑留给目录点击。
      scrollNodeInto(content, node);
      markTarget(node, true, true);
    }
    this.scheduleTargetFade(anchor);
  }

  scheduleTargetFade(anchor) {
    this.clearTimers();
    this.fadeTimer = setTimeout(() => {
      markTarget(this.sectionNode(anchor), false, true);
    }, TARGET_HOLD_MS);
  }

  /** 目录跟随滚动：把第一个越过判定线的标题设为当前项。 */
  syncToc() {
    if (this.state !== 'ready' || !this.article) return;
    const content = this.contentNode();
    if (!content) return;
    const top = Number(content.scrollTop) || 0;
    const nodes = content.querySelectorAll?.('[id]') ?? [];
    let active = '';
    for (const node of nodes) {
      const level = String(node.nodeName ?? '').toUpperCase();
      if (level !== 'H2') continue;
      const offset = Number(node.offsetTop);
      if (!Number.isFinite(offset)) continue;
      if (offset - top <= TOC_OFFSET) active = node.getAttribute?.('id') ?? active;
    }
    if (active && active !== this.activeAnchor) {
      this.activeAnchor = active;
      this.updateTocState();
    }
  }

  /** 只补丁目录的 active 状态，避免整块重绘导致滚动位置跳动。 */
  updateTocState() {
    const links = this.shell?.querySelectorAll?.('.rag-reader-toc-link') ?? [];
    for (const link of links) {
      const anchor = link.getAttribute?.('data-rag-reader-anchor') ?? '';
      const active = anchor === this.activeAnchor;
      if (link.classList && typeof link.classList.toggle === 'function') {
        link.classList.toggle('is-active', active);
      }
      if (link.setAttribute) link.setAttribute('aria-current', active ? 'true' : 'false');
    }
  }

  /** 点击目录：就地滚动，不重新拉取文件。 */
  gotoAnchor(anchor) {
    const value = String(anchor ?? '');
    if (!value) return;
    this.activeAnchor = value;
    this.updateTocState();
    const node = this.sectionNode(value);
    if (!node) return;
    scrollNodeInto(this.contentNode(), node, { smooth: true });
    markTarget(node, true, true);
    this.scheduleTargetFade(value);
  }

  // ---------- 事件 ----------

  handleClick(event) {
    if (this.disposed) return;
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return;
    const node = target.closest('[data-rag-reader-action]');
    if (!node) {
      const link = target.closest?.('[data-rag-reader-goto]');
      if (link) {
        if (event?.preventDefault) event.preventDefault();
        this.gotoAnchor(link.getAttribute('data-rag-reader-goto'));
      }
      return;
    }
    const action = node.getAttribute('data-rag-reader-action');
    if (action === 'close') {
      if (event?.preventDefault) event.preventDefault();
      this.close();
      return;
    }
    if (action === 'retry') {
      if (event?.preventDefault) event.preventDefault();
      this.open({ path: this.path, anchor: this.anchor, chunkId: this.chunkId, query: this.query });
    }
  }

  handleKeyDown(event) {
    if (this.disposed || !this.open_) return;
    const key = event?.key;
    if (key === 'Escape') {
      if (event.preventDefault) event.preventDefault();
      this.close();
      return;
    }
    if (key !== 'Tab') return;

    const panel = this.shell?.querySelector?.('.rag-reader-panel');
    if (!panel) return;
    const items = [...(panel.querySelectorAll?.(FOCUSABLE) ?? [])]
      .filter(node => node !== panel && node.getAttribute?.('aria-hidden') !== 'true');
    if (!items.length) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = this.currentFocus();
    if (!event.shiftKey && active === last) {
      if (event.preventDefault) event.preventDefault();
      first.focus?.();
    } else if (event.shiftKey && active === first) {
      if (event.preventDefault) event.preventDefault();
      last.focus?.();
    }
  }

  attachGlobal() {
    const doc = this.root?.ownerDocument;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    if (this.globalBound) return;
    doc.addEventListener('keydown', this.onKeyDown);
    this.globalBound = doc;
  }

  detachGlobal() {
    if (!this.globalBound) return;
    this.globalBound.removeEventListener?.('keydown', this.onKeyDown);
    this.globalBound = null;
  }

  // ---------- 工具 ----------

  currentFocus() {
    const doc = this.root?.ownerDocument;
    return doc?.activeElement ?? null;
  }

  focusPanel() {
    const panel = this.shell?.querySelector?.('.rag-reader-panel');
    if (!panel) return;
    // preventScroll：聚焦面板不应把已经定位好的正文滚回顶部。
    panel.focus?.({ preventScroll: true });
  }

  clearTimers() {
    if (this.holdTimer !== null) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    if (this.fadeTimer !== null) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
  }
}
