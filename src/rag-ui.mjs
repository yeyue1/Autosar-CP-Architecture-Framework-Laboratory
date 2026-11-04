// 知识库检索工作区 UI（契约第 4 节）。
// 本模块只依赖 src/dom-update.mjs；检索引擎通过构造函数注入（service），
// 因此可以在没有真实引擎的情况下用桩测试，也不会与 src/rag/** 耦合。
import { updateHtml } from './dom-update.mjs';

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPE[char]);

// corpus 分类 → 学习工作区（契约第 4 节要求组件内置映射，无对应实验时为 null）。
const LAB_BY_CATEGORY = {
  startup: 'startup', uds: 'uds', communication: 'communication', storage: 'storage',
  os: 'scheduler', xcp: 'calibration', system: 'system', methodology: null, boundary: null,
};
const LAB_LABEL = {
  startup: '启动流程', uds: 'UDS 诊断', system: '系统架构', communication: '通信与网络管理',
  storage: '存储实验室', scheduler: 'OS 与多核调度', calibration: 'XCP 在线标定',
};
const COVERAGE = {
  high: { label: '覆盖充分', hint: '命中片段足以支撑这个回答' },
  medium: { label: '覆盖一般', hint: '回答基于部分相关片段' },
  low: { label: '覆盖有限', hint: '只找到弱相关片段，请谨慎采信' },
  none: { label: '无法回答', hint: '知识库中没有足够依据' },
};
const STATUS_LABEL = { idle: '等待加载', loading: '索引构建中', ready: '索引就绪', error: '加载失败' };
const EXAMPLES = [
  'EcuM 启动顺序与 StartOS 边界',
  'NvM 掉电恢复与 Fee 写入顺序',
  'CAN 网络管理与 ComM 状态',
  'UDS 安全访问 Seed / Key',
  'XCP DAQ 采样与标定',
];
const MAX_HIGHLIGHTS = 8;

/** 只允许同源相对路径与 http(s) 绝对地址，避免 javascript:/data: 之类注入。 */
function safeHref(path) {
  const value = String(path ?? '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return /^https?:/i.test(value) ? value : '';
  return value;
}

/** Hit 契约里没有 level；引擎若提供 level / headingLevel 就用它决定标题层级前缀。 */
function levelOf(hit) {
  const raw = Number(hit?.level ?? hit?.headingLevel ?? hit?.chunk?.level);
  return Number.isFinite(raw) && raw >= 1 && raw <= 6 ? Math.round(raw) : null;
}

/** 按回传的 highlights 区间切片拼接；先转义再包 <mark>，禁止对已转义文本做正则替换。 */
function highlightText(text, ranges) {
  const source = String(text ?? '');
  const merged = [];
  for (const range of Array.isArray(ranges) ? ranges : []) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const start = Math.max(0, Math.min(source.length, Number(range[0]) || 0));
    const end = Math.max(0, Math.min(source.length, Number(range[1]) || 0));
    if (end <= start) continue;
    merged.push([start, end]);
  }
  merged.sort((a, b) => a[0] - b[0]);
  const spans = [];
  for (const span of merged) {
    const last = spans[spans.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else spans.push(span);
    if (spans.length >= MAX_HIGHLIGHTS) break;
  }
  let html = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    html += esc(source.slice(cursor, start));
    html += `<mark data-rag-hl>${esc(source.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + esc(source.slice(cursor));
}

export class RagWorkspaceUi {
  constructor({ service = null, notify = () => {}, onNavigateLab = null, reader = null } = {}) {
    this.service = service;
    this.notify = typeof notify === 'function' ? notify : () => {};
    this.onNavigateLab = typeof onNavigateLab === 'function' ? onNavigateLab : null;
    // 阅读器是可选的：没有注入时「查看原文」退回成直接打开 .md 的新标签链接，
    // 这样单独使用本组件（例如测试或精简嵌入）不会因为缺少阅读器而失去溯源能力。
    this.reader = reader && typeof reader.open === 'function' ? reader : null;

    this.root = null;
    this.mounted = false;
    this.disposed = false;

    this.query = '';
    this.category = null;
    this.selected = null;
    this.hits = [];
    this.answer = null;
    this.related = [];
    this.suggestions = [];
    this.liveText = '输入关键词后开始检索知识库';
    this.debounceMs = 180;
    this.timer = null;

    // 事件委托：一个 click + 一个 submit + 一个 input，dispose 时按同一引用移除。
    this.onClick = event => this.handleClick(event);
    this.onSubmit = event => this.handleSubmit(event);
    this.onInput = event => this.handleInput(event);
  }

  mount(root) {
    if (!root) return;
    this.disposed = false;
    this.root = root;
    if (!this.mounted) {
      root.addEventListener('click', this.onClick);
      root.addEventListener('submit', this.onSubmit);
      root.addEventListener('input', this.onInput);
      this.mounted = true;
    }
    this.ensureLoaded();
    this.render();
  }

  render() {
    if (!this.root || this.disposed) return;
    updateHtml(this.root, this.html(), { preserveFormValues: true });
    // preserveFormValues 会跳过 value 属性补丁，因此程序化改词时必须显式同步输入框；
    // 但绝不能无条件把 this.query 写回 DOM：那会把用户正在输入的内容覆盖掉。
    if (this.querySync) {
      const input = this.input();
      if (input && input.value !== this.query) input.value = this.query;
      this.querySync = false;
    }
  }

  /** 程序化改词（追问、分类、清空）：同步 state 与输入框，再检索。 */
  applyQuery(value) {
    this.query = String(value ?? '').trim();
    this.querySync = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.runSearch();
  }

  dispose() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.root && this.mounted) {
      this.root.removeEventListener('click', this.onClick);
      this.root.removeEventListener('submit', this.onSubmit);
      this.root.removeEventListener('input', this.onInput);
    }
    this.mounted = false;
    this.disposed = true;
    this.root = null;
  }

  // ---------- 状态读取 ----------

  input() {
    if (!this.root || typeof this.root.querySelector !== 'function') return null;
    return this.root.querySelector('#rag-query');
  }

  statusOf() {
    if (!this.service) return 'error';
    return this.service.status || 'idle';
  }

  statsOf() {
    try {
      return this.service && typeof this.service.stats === 'function' ? this.service.stats() : null;
    } catch {
      return null;
    }
  }

  categories() {
    const stats = this.statsOf();
    const list = Array.isArray(stats?.categories) ? stats.categories : [];
    return list.map(item => ({
      id: String(item?.id ?? ''),
      label: String(item?.label ?? item?.id ?? ''),
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : 99,
      count: Number.isFinite(Number(item?.count)) ? Number(item.count) : null,
    })).sort((a, b) => a.order - b.order);
  }

  categoryLabel(id) {
    const key = String(id ?? '');
    return this.categories().find(item => item.id === key)?.label || key || '未分类';
  }

  labFor(category) {
    const key = String(category ?? '');
    return Object.prototype.hasOwnProperty.call(LAB_BY_CATEGORY, key) ? LAB_BY_CATEGORY[key] : null;
  }

  // ---------- 加载与检索 ----------

  ensureLoaded() {
    const service = this.service;
    if (!service || typeof service.load !== 'function' || service.status !== 'idle') return;
    this.settle(Promise.resolve(service.load()));
  }

  settle(promise) {
    Promise.resolve(promise).then(
      () => { if (!this.disposed) this.render(); },
      () => { if (!this.disposed) this.render(); },
    );
  }

  reload() {
    const service = this.service;
    if (!service || typeof service.load !== 'function') return;
    const started = service.load();
    this.liveText = '正在重新加载知识索引…';
    this.render();
    Promise.resolve(started).then(
      () => {
        if (this.disposed) return;
        if (this.query.trim()) this.runSearch(); else this.render();
      },
      () => { if (!this.disposed) this.render(); },
    );
  }

  runSearch() {
    if (this.disposed) return;
    const query = this.query.trim();
    this.selected = null;
    this.related = [];
    this.suggestions = [];
    const service = this.service;

    if (!query) {
      this.hits = [];
      this.answer = null;
      this.liveText = '输入关键词后开始检索知识库';
      this.render();
      return;
    }
    if (!service || this.statusOf() !== 'ready') {
      this.hits = [];
      this.answer = null;
      this.liveText = '索引尚未就绪，暂时无法检索';
      this.render();
      return;
    }
    try {
      const hits = service.search(query, { limit: 8, category: this.category || null });
      this.hits = Array.isArray(hits) ? hits : [];
      this.answer = this.hits.length && typeof service.answer === 'function' ? service.answer(query) || null : null;
      if (!this.hits.length && typeof service.suggest === 'function') {
        const suggestions = service.suggest(query, { limit: 5 });
        this.suggestions = Array.isArray(suggestions) ? suggestions.filter(item => typeof item === 'string') : [];
      }
      this.liveText = `找到 ${this.hits.length} 条结果`;
    } catch (error) {
      this.hits = [];
      this.answer = null;
      this.liveText = '检索失败';
      this.notify(`检索失败：${error?.message ?? error}`, true);
    }
    this.render();
  }

  selectChunk(chunkId) {
    const id = String(chunkId ?? '');
    this.selected = id || null;
    this.related = [];
    if (id && this.service && typeof this.service.related === 'function') {
      try {
        const related = this.service.related(id, { limit: 5 });
        this.related = Array.isArray(related) ? related : [];
      } catch (error) {
        this.related = [];
        this.notify(`相关条目加载失败：${error?.message ?? error}`, true);
      }
    }
    this.render();
  }

  // ---------- 事件 ----------

  handleClick(event) {
    if (this.disposed) return;
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return;
    const node = target.closest('[data-rag-action]');
    if (!node) return;
    const action = node.getAttribute('data-rag-action');
    const value = name => node.getAttribute(name) || '';

    switch (action) {
      case 'clear':
        this.query = '';
        this.querySync = true;
        this.hits = [];
        this.answer = null;
        this.related = [];
        this.suggestions = [];
        this.selected = null;
        this.liveText = '已清空检索条件';
        this.render();
        this.focusQuery();
        return;
      case 'focus-search':
        this.focusQuery();
        return;
      case 'category':
        this.category = value('data-rag-category') || null;
        this.runSearch();
        return;
      case 'ask': {
        const query = value('data-rag-q') || node.textContent || '';
        this.applyQuery(query);
        this.focusQuery();
        return;
      }
      case 'select':
        this.selectChunk(value('data-rag-chunk'));
        return;
      case 'open-source': {
        if (!this.reader) return;
        const path = value('data-rag-path');
        if (!path) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        // 打开失败由阅读器自己呈现（它内部有错误态与重试），这里只兜住不产生未捕获拒绝。
        Promise.resolve(this.reader.open({
          path,
          anchor: value('data-rag-anchor'),
          chunkId: value('data-rag-chunk'),
          query: this.query,
        })).catch(() => {
          this.notify('原文读取失败，可在阅读器面板内重试');
        });
        return;
      }
      case 'navigate': {
        const lab = value('data-rag-lab');
        if (lab && this.onNavigateLab) this.onNavigateLab(lab);
        else if (!this.onNavigateLab) this.notify('当前页面未提供工作区跳转能力');
        return;
      }
      case 'retry':
        this.reload();
        return;
      default:
        return;
    }
  }

  handleSubmit(event) {
    if (this.disposed) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    // 真实交互里输入框是唯一事实来源；若输入框不可用（或为空但 state 有词），回退到 this.query。
    const input = this.input();
    const typed = input && typeof input.value === 'string' ? input.value : null;
    if (typed !== null && typed !== '') this.query = typed;
    this.querySync = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.runSearch();
  }

  handleInput(event) {
    if (this.disposed) return;
    const target = event?.target;
    if (!target || target.getAttribute?.('id') !== 'rag-query') return;
    this.query = String(target.value ?? '');
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.disposed) this.runSearch();
    }, this.debounceMs);
  }

  focusQuery() {
    const input = this.input();
    if (input && typeof input.focus === 'function') input.focus();
  }

  // ---------- 渲染 ----------

  html() {
    return `<section class="rag-workspace" aria-label="知识库检索工作区">`
      + this.hero()
      + this.searchBar()
      + this.chipBar()
      + this.statusBar()
      + `<div class="rag-body" aria-busy="${this.statusOf() === 'loading' ? 'true' : 'false'}">`
      + this.resultsPanel()
      + this.answerPanel()
      + '</div></section>';
  }

  hero() {
    const stats = this.statsOf();
    const size = Number.isFinite(Number(stats?.size)) ? Number(stats.size) : null;
    const documents = Number.isFinite(Number(stats?.documents)) ? Number(stats.documents) : null;
    const scope = size ? `当前索引覆盖 ${size} 个知识片段、${documents ?? '—'} 篇原创文档。` : '索引就绪后即可检索 9 个 AUTOSAR CP 主题。';
    return `<header class="rag-hero"><span class="rag-eyebrow">KNOWLEDGE RETRIEVAL · BM25 变体 / 抽取式答案</span>`
      + '<h2>把散落在规范里的概念，一次问清楚。</h2>'
      + `<p>${esc(scope)}答案只由命中的片段拼成句子，不生成原文没有的事实；每条结论都带回原文链接。</p></header>`;
  }

  searchBar() {
    const ready = this.statusOf() === 'ready';
    return `<form class="rag-search" id="rag-search-form" role="search" aria-label="知识库检索">`
      + '<div class="rag-search-field"><span class="rag-search-icon" aria-hidden="true">⌕</span>'
      + `<input id="rag-query" class="rag-input" name="rag-query" type="search" autocomplete="off" spellcheck="false" placeholder="例如：EcuM 启动顺序、NvM 掉电恢复、XCP DAQ" aria-label="检索关键词" value="${esc(this.query)}" />`
      + (this.query ? '<button type="button" class="rag-clear" data-rag-action="clear" aria-label="清空检索条件">✕</button>' : '')
      + '</div>'
      + `<button type="submit" class="rag-submit"${ready ? '' : ' disabled'} aria-label="提交检索">检索</button>`
      + '<button type="button" class="rag-kbd" data-rag-action="focus-search" aria-label="聚焦搜索框（快捷键 /）" title="聚焦搜索框（/）"><kbd>/</kbd></button>'
      + '<span class="rag-search-hint" aria-hidden="true">Enter 检索 · <kbd>/</kbd> 聚焦</span>'
      + '</form>';
  }

  chipBar() {
    const categories = this.categories();
    if (!categories.length) {
      return '<div class="rag-chips" role="group" aria-label="分类过滤"><span class="rag-chips-empty">索引就绪后可按分类过滤</span></div>';
    }
    const stats = this.statsOf();
    const chip = (id, label, count) => `<button type="button" class="rag-chip" data-rag-action="category" data-rag-category="${esc(id)}" aria-pressed="${(this.category || '') === id ? 'true' : 'false'}">${esc(label)}`
      + (count === null ? '' : `<span class="rag-chip-count">${esc(count)}</span>`)
      + '</button>';
    const total = Number.isFinite(Number(stats?.size)) ? Number(stats.size) : null;
    return '<div class="rag-chips" role="group" aria-label="按分类过滤检索结果">'
      + chip('', '全部分类', total)
      + categories.map(item => chip(item.id, item.label, item.count)).join('')
      + '</div>';
  }

  statusBar() {
    const stats = this.statsOf();
    const status = this.statusOf();
    const size = Number.isFinite(Number(stats?.size)) ? Number(stats.size) : null;
    const documents = Number.isFinite(Number(stats?.documents)) ? Number(stats.documents) : null;
    const loadMs = Number.isFinite(Number(stats?.loadMs)) ? Math.round(Number(stats.loadMs)) : null;
    const item = (label, value) => `<div class="rag-status-item"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
    return '<dl class="rag-status" aria-label="索引状态">'
      + item('知识片段', size === null ? '—' : `${size} 段`)
      + item('文档', documents === null ? '—' : `${documents} 篇`)
      + item('索引耗时', loadMs === null ? '—' : `${loadMs} ms`)
      + `<div class="rag-status-item"><dt>加载状态</dt><dd><span class="rag-status-dot" data-status="${esc(status)}" aria-hidden="true"></span>${esc(STATUS_LABEL[status] || status)}</dd></div>`
      + `<div class="rag-status-item"><dt>分类过滤</dt><dd>${esc(this.category ? this.categoryLabel(this.category) : '全部分类')}</dd></div>`
      + '</dl>';
  }

  resultsPanel() {
    return '<section class="rag-results" aria-label="检索结果">'
      + `<p class="rag-live" id="rag-live" role="status" aria-live="polite">${esc(this.liveText)}</p>`
      + this.resultsBody()
      + '</section>';
  }

  resultsBody() {
    const status = this.statusOf();
    if (status === 'error') return this.errorState();
    if (status === 'idle' || status === 'loading') return this.loadingState();
    if (!this.query.trim()) return this.guideState();
    if (!this.hits.length) return this.emptyState();
    return this.resultsHead() + this.hits.map(hit => this.card(hit)).join('');
  }

  resultsHead() {
    const category = this.category ? this.categoryLabel(this.category) : '全部分类';
    return `<div class="rag-results-head"><strong>${this.hits.length} 条命中</strong>`
      + `<span>BM25 相关度排序 · ${esc(category)}</span></div>`;
  }

  card(hit) {
    const chunkId = String(hit?.chunkId ?? '');
    const selected = this.selected === chunkId;
    const level = levelOf(hit);
    const score = Number(hit?.score);
    const matched = (Array.isArray(hit?.matched) ? hit.matched : []).slice(0, 12);
    const lab = this.labFor(hit?.category);
    const href = safeHref(hit?.sourcePath);
    const category = String(hit?.category ?? '');
    const levelPrefix = level ? `<span class="rag-level" aria-label="标题层级 ${level}">H${level}</span>` : '';
    return `<article class="rag-card" data-selected="${selected ? 'true' : 'false'}" data-category="${esc(category)}">`
      + `<button type="button" class="rag-card-hit" data-rag-action="select" data-rag-chunk="${esc(chunkId)}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="查看相关条目：${esc(hit?.heading ?? hit?.docTitle ?? chunkId)}">`
      + '<span class="rag-card-top">'
      + `<span class="rag-badge" data-category="${esc(category)}">${esc(this.categoryLabel(category))}</span>`
      + `<span class="rag-score" title="BM25 相关度">${Number.isFinite(score) ? esc(score.toFixed(2)) : '—'}</span>`
      + '</span>'
      + `<span class="rag-card-doc">${esc(hit?.docTitle ?? '')}</span>`
      + `<span class="rag-card-heading"${level ? ` data-level="${level}"` : ''}>${levelPrefix}${esc(hit?.heading ?? '')}</span>`
      + `<span class="rag-card-text">${highlightText(hit?.text, hit?.highlights)}</span>`
      + '</button>'
      + '<div class="rag-card-foot">'
      + `<span class="rag-matched">${matched.length ? matched.map(word => `<span class="rag-matched-chip">${esc(word)}</span>`).join('') : '<span class="rag-matched-none">未命中显式关键词</span>'}</span>`
      + '<span class="rag-card-actions">'
      + (href ? this.sourceControl(hit, href) : '')
      + (lab ? `<button type="button" class="rag-nav" data-rag-action="navigate" data-rag-lab="${esc(lab)}">前往${esc(LAB_LABEL[lab] || '对应')}实验 →</button>` : '')
      + '</span></div></article>';
  }

  /** 「查看原文」：有阅读器就在面板内打开并定位到该小节，否则退回新标签打开 .md。 */
  sourceControl(hit, href) {
    if (!this.reader) {
      return `<a class="rag-source" href="${esc(href)}" target="_blank" rel="noreferrer">查看原文 ↗</a>`;
    }
    const anchor = String(hit?.anchor ?? '');
    return `<button type="button" class="rag-source rag-source-inline" data-rag-action="open-source"`
      + ` data-rag-path="${esc(href)}"`
      + ` data-rag-anchor="${esc(anchor)}"`
      + ` data-rag-chunk="${esc(hit?.chunkId ?? '')}"`
      + ` title="在面板内打开原文并定位到「${esc(hit?.heading ?? '')}」">查看原文 <span aria-hidden="true">→</span></button>`;
  }

  loadingState() {
    return '<div class="rag-state rag-state-loading"><strong>正在构建知识索引…</strong>'
      + '<div class="rag-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'
      + '<p>首次进入会读取 knowledge/corpus.json 并建立 BM25 索引，通常只花几十毫秒。</p></div>';
  }

  errorState() {
    const reason = this.service?.error?.message || this.service?.error || '未注入检索服务（service）';
    return '<div class="rag-state rag-state-error" role="alert"><strong>索引加载失败</strong>'
      + `<p>${esc(reason)}</p>`
      + '<p class="rag-state-hint">确认 knowledge/corpus.json 存在且可访问，然后重试；失败不会影响其它工作区。</p>'
      + '<button type="button" class="rag-action-button rag-action-primary" data-rag-action="retry">重试加载</button></div>';
  }

  guideState() {
    return '<div class="rag-state rag-state-guide"><strong>从示例问题开始</strong>'
      + '<p>输入 AUTOSAR 术语检索原创教学语料，或直接点一个示例。</p>'
      + `<div class="rag-examples">${EXAMPLES.map(query => `<button type="button" class="rag-example" data-rag-action="ask" data-rag-q="${esc(query)}">${esc(query)}</button>`).join('')}</div>`
      + '<p class="rag-state-hint">点击结果卡片可查看同主题的相关条目；答案面板会给出带引用的抽取式摘要。</p></div>';
  }

  emptyState() {
    const hints = this.suggestions.length
      ? `<div class="rag-examples">${this.suggestions.map(query => `<button type="button" class="rag-example" data-rag-action="ask" data-rag-q="${esc(query)}">${esc(query)}</button>`).join('')}</div>`
      : '';
    return '<div class="rag-state rag-state-empty"><strong>没有找到匹配的知识片段</strong>'
      + '<p>试试更短的术语、换用中文/英文对照词，或取消分类过滤。</p>'
      + hints
      + '<button type="button" class="rag-action-button" data-rag-action="clear">清空检索条件</button></div>';
  }

  answerPanel() {
    return '<aside class="rag-answer" aria-label="答案摘要与引用">'
      + (this.answer ? this.answerBody(this.answer) : this.answerPlaceholder())
      + this.relatedPanel()
      + '</aside>';
  }

  answerPlaceholder() {
    return '<div class="rag-answer-empty"><strong>答案摘要</strong>'
      + '<p>检索后这里给出抽取式摘要：每个句子只来自命中的片段，句尾编号对应底部引用列表。</p>'
      + '<p class="rag-state-hint">校验方式：每条结果都能点开「查看原文」，在面板内直接读到被引用的小节。</p></div>';
  }

  answerBody(answer) {
    const coverage = Object.prototype.hasOwnProperty.call(COVERAGE, answer?.coverage) ? answer.coverage : 'none';
    const citations = (Array.isArray(answer?.citations) ? answer.citations : []).filter(item => item && item.chunkId != null);
    const byChunk = new Map();
    for (const item of citations) {
      const key = String(item.chunkId);
      if (!byChunk.has(key)) byChunk.set(key, item);
    }
    const sentences = Array.isArray(answer?.sentences) ? answer.sentences : [];
    const terms = Array.isArray(answer?.relatedTerms) ? answer.relatedTerms.filter(Boolean) : [];
    const followUps = Array.isArray(answer?.followUps) ? answer.followUps.filter(Boolean) : [];

    const sentencesHtml = sentences.map((sentence, index) => {
      const citation = byChunk.get(String(sentence?.chunkId));
      const sup = citation ? `<sup class="rag-cite" aria-label="引用 ${esc(citation.index ?? index + 1)}">[${esc(citation.index ?? index + 1)}]</sup>` : '';
      return `<li><p>${esc(sentence?.text ?? '')}${sup}</p></li>`;
    }).join('');

    const citationsHtml = citations.map((item, index) => {
      const number = `<span class="rag-cite-num">[${esc(item.index ?? index + 1)}]</span>`;
      const body = `<strong>${esc(item.docTitle ?? '')}</strong>`
        + `<span class="rag-cite-heading">· ${esc(item.heading ?? '')}</span>`
        + `<code class="rag-cite-path">${esc(item.sourcePath ?? '')}</code>`;
      const href = safeHref(item.sourcePath);
      // 引用是"可追溯"的核心承诺，因此有阅读器时整条都可点，直达对应小节。
      if (this.reader && href) {
        return '<li>'
          + `<button type="button" class="rag-cite-link" data-rag-action="open-source"`
          + ` data-rag-path="${esc(href)}"`
          + ` data-rag-anchor="${esc(item.anchor ?? '')}"`
          + ` data-rag-chunk="${esc(item.chunkId ?? '')}"`
          + ` aria-label="打开原文并定位到「${esc(item.heading ?? '')}」">${number}${body}</button></li>`;
      }
      return `<li>${number}${body}</li>`;
    }).join('');

    const termsHtml = terms.map(term => `<button type="button" class="rag-term" data-rag-action="ask" data-rag-q="${esc(term)}">${esc(term)}</button>`).join('');
    const followHtml = followUps.map(term => `<button type="button" class="rag-followup" data-rag-action="ask" data-rag-q="${esc(term)}">${esc(term)}</button>`).join('');

    return '<div class="rag-answer-head">'
      + `<span class="rag-coverage" data-coverage="${esc(coverage)}" title="${esc(COVERAGE[coverage].hint)}">${esc(COVERAGE[coverage].label)}</span>`
      + `<span class="rag-answer-meta">${sentences.length} 句 · ${citations.length} 条引用</span></div>`
      + `<h3 class="rag-answer-title">${esc(answer?.query || this.query)}</h3>`
      + (sentencesHtml ? `<ol class="rag-sentences">${sentencesHtml}</ol>` : '<p class="rag-answer-note">这个查询没有可抽取的句子，请直接查看左侧结果。</p>')
      + (citationsHtml ? `<div class="rag-block"><span class="rag-block-title">引用来源</span><ol class="rag-citations">${citationsHtml}</ol></div>` : '')
      + (termsHtml ? `<div class="rag-block"><span class="rag-block-title">相关术语</span><div class="rag-term-list">${termsHtml}</div></div>` : '')
      + (followHtml ? `<div class="rag-block"><span class="rag-block-title">继续追问</span><div class="rag-followup-list">${followHtml}</div></div>` : '')
      + (answer?.boundary ? `<div class="rag-boundary" role="note"><strong>⚠ 边界提醒</strong><p>${esc(answer.boundary)}</p></div>` : '');
  }

  relatedPanel() {
    if (!this.selected) return '';
    const hit = this.hits.find(item => String(item?.chunkId) === this.selected) || null;
    const list = Array.isArray(this.related) ? this.related : [];
    const items = list.map(item => '<li>'
      + `<button type="button" class="rag-related-item" data-rag-action="select" data-rag-chunk="${esc(item?.chunkId ?? '')}">`
      + `<strong>${esc(item?.heading ?? item?.docTitle ?? '')}</strong>`
      + `<span>${esc(item?.docTitle ?? '')}${Number.isFinite(Number(item?.score)) ? ` · ${esc(Number(item.score).toFixed(2))}` : ''}</span>`
      + '</button></li>').join('');
    return '<div class="rag-related" aria-label="相关条目"><div class="rag-related-head">'
      + '<span class="rag-block-title">相关条目</span>'
      + `<span class="rag-related-current">${esc(hit?.heading ?? hit?.docTitle ?? this.selected)}</span>`
      + '</div>'
      + (items ? `<ul class="rag-related-list">${items}</ul>` : '<p class="rag-answer-note">同主题下暂无其它相近条目。</p>')
      + '</div>';
  }
}
