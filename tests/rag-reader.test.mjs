// 应用内原文阅读器的进程内测试。
// 用 tests/helpers/fake-dom.mjs 的最小 DOM 桩，走真实的 updateHtml，验证组件确实
// 复用了 DOM 补丁流程；article 相关函数注入桩，避免与并行开发的 article.mjs 耦合。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ArticleReader } from '../src/rag-reader.mjs';
import { createRoot, outerHtml } from './helpers/fake-dom.mjs';

// ---------------------------------------------------------------------------
// article.mjs 的桩：形状必须与 .runtime/reader-contract.md §5 一致
// ---------------------------------------------------------------------------

const DOC = {
  id: 'startup-ecum-flexible',
  title: 'EcuM Flexible 启动顺序',
  tags: ['EcuM', 'StartOS'],
  summary: '摘要',
  refs: ['src-ecum'],
  intro: '这篇文档走一遍冷启动主线。',
  anchors: ['ecum-init', 'startos-边界'],
  sections: [
    {
      anchor: 'ecum-init',
      heading: 'EcuM_Init 是第一个 BSW 入口',
      level: 2,
      keywords: ['EcuM_Init'],
      markdown: '复位之后进入 EcuM_Init。',
      plain: '复位之后进入 EcuM_Init。',
    },
    {
      anchor: 'startos-边界',
      heading: 'StartOS 是控制权边界',
      level: 2,
      keywords: ['StartOS'],
      markdown: 'StartOS 之后调度器接管。',
      plain: 'StartOS 之后调度器接管。',
    },
  ],
};

const SECOND_DOC = {
  id: 'startup-bswm',
  title: 'BswM 模式仲裁',
  tags: ['BswM'],
  summary: '摘要二',
  refs: [],
  intro: 'BswM 负责规则求值。',
  anchors: ['规则求值'],
  sections: [
    {
      anchor: '规则求值',
      heading: '规则求值顺序',
      level: 2,
      keywords: ['BswM'],
      markdown: '规则按优先级求值。',
      plain: '规则按优先级求值。',
    },
  ],
};

function makeDeps(overrides = {}) {
  const article = { path: 'knowledge/01-startup.md', documents: [DOC] };
  return {
    parseArticle: () => article,
    // 桩渲染：把每个小节渲染成 <h2 id> + <p>，模拟真实 renderArticle 的结构。
    renderArticle: parsed => parsed.documents.map(document => '<h1>' + document.title + '</h1>'
      + '<p>' + document.intro + '</p>'
      + document.sections.map(section => `<h2 id="${section.anchor}">${section.heading}</h2>`
        + `<p>${section.markdown}</p>`).join('')).join(''),
    findSection: (parsed, anchor) => {
      for (const document of parsed?.documents ?? []) {
        const section = document.sections.find(item => item.anchor === anchor);
        if (section) return { document, section };
      }
      return null;
    },
    ...overrides,
  };
}

function okResponse(text) {
  return { ok: true, status: 200, text: async () => text };
}

// 事件监听挂在 mount 时创建的 [data-rag-reader] 容器上；真实浏览器里子节点的点击会冒泡，
// 但这个 DOM 桩不会自动冒泡，所以测试必须把事件派发到监听器所在的那个节点。
const shellOf = root => root.querySelector('[data-rag-reader]');

function makeReader({ deps = makeDeps(), fetchImpl = null, onClose = null } = {}) {
  const { document, root } = createRoot();
  const reader = new ArticleReader({ deps, fetchImpl, onClose });
  reader.mount(root);
  return { document, root, reader, html: () => outerHtml(root) };
}

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

test('mount：幂等挂载，重复调用只创建一个面板', () => {
  const { root, reader } = makeReader();
  reader.mount(root);
  reader.mount(root);
  assert.equal(root.querySelectorAll('[data-rag-reader]').length, 1);
});

test('mount：初始为关闭态', () => {
  const { root, reader } = makeReader();
  assert.equal(reader.isOpen, false);
  assert.equal(root.querySelector('.rag-reader-shell').getAttribute('data-open'), 'false');
});

test('mount：无 root 时不抛错', () => {
  const reader = new ArticleReader({ deps: makeDeps() });
  assert.doesNotThrow(() => reader.mount(null));
  assert.equal(reader.isOpen, false);
});

// ---------------------------------------------------------------------------
// 打开与渲染
// ---------------------------------------------------------------------------

test('open：渲染标题、目录与正文', async () => {
  const { reader, html } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'knowledge/01-startup.md', anchor: 'ecum-init' });
  const output = html();
  assert.equal(reader.isOpen, true);
  assert.match(output, /EcuM Flexible 启动顺序/);
  assert.match(output, /EcuM_Init 是第一个 BSW 入口/);
  assert.match(output, /StartOS 是控制权边界/);
  assert.match(output, /复位之后进入 EcuM_Init。/);
  assert.match(output, /rag-reader-toc/);
});

test('open：设置 data-open 为 true', async () => {
  const { root, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'knowledge/01-startup.md' });
  assert.equal(root.querySelector('.rag-reader-shell').getAttribute('data-open'), 'true');
});

test('open：传递 query 时显示「来自检索」面包屑', async () => {
  const { html, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'knowledge/01-startup.md', anchor: 'ecum-init', query: '启动流程' });
  assert.match(html(), /来自检索/);
  assert.match(html(), /启动流程/);
});

test('open：没有 query 时不显示面包屑', async () => {
  const { html, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'knowledge/01-startup.md', anchor: 'ecum-init' });
  assert.doesNotMatch(html(), /来自检索/);
});

test('open：空 path 直接返回，不进入打开态', async () => {
  const { reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: '  ' });
  assert.equal(reader.isOpen, false);
});

test('open：多文档时目录按文档分组', async () => {
  const article = { path: 'k.md', documents: [DOC, SECOND_DOC] };
  const deps = makeDeps({
    parseArticle: () => article,
    renderArticle: parsed => parsed.documents.map(document => '<h1>' + document.title + '</h1>'
      + document.sections.map(section => `<h2 id="${section.anchor}">${section.heading}</h2>`).join('')).join(''),
  });
  const { html, reader } = makeReader({ deps, fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', anchor: 'ecum-init' });
  const output = html();
  assert.match(output, /rag-reader-toc-doc/);
  assert.match(output, /BswM 模式仲裁/);
});

// ---------------------------------------------------------------------------
// 锚点定位与高亮
// ---------------------------------------------------------------------------

test('open：定位到 anchor 对应小节并加 is-target', async () => {
  const { reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', anchor: 'startos-边界' });
  const node = reader.sectionNode('startos-边界');
  assert.ok(node, '应能找到目标小节节点');
  assert.equal(node.classList.contains('is-target'), true);
  // 定位必须是"真的滚过去了"：滚动容器的 scrollTop 应停在该小节附近。
  const content = reader.contentNode();
  assert.ok(content.scrollTop > 0, '滚动容器应被滚到目标小节');
  assert.ok(Math.abs(content.scrollTop - (node.offsetTop - 10)) <= 1,
    `scrollTop 应约等于目标偏移，实际 ${content.scrollTop} / 目标 ${node.offsetTop}`);
});

test('open：锚点不存在时不抛错，回退到第一节', async () => {
  const { reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await assert.doesNotReject(reader.open({ path: 'k.md', anchor: '不存在' }));
  assert.equal(reader.target?.section?.anchor, 'ecum-init');
});

test('open：锚点缺失时用 chunkId 兜底定位', async () => {
  const { reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', chunkId: 'startup-ecum-flexible#2' });
  assert.equal(reader.target?.section?.anchor, 'startos-边界');
});

test('gotoAnchor：点击目录项切换高亮并滚动', async () => {
  const { root, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', anchor: 'ecum-init' });
  const link = root.querySelectorAll('[data-rag-reader-goto]')
    .find(node => node.getAttribute('data-rag-reader-goto') === 'startos-边界');
  assert.ok(link, '应渲染出目标目录项');
  shellOf(root).dispatch('click', { target: link });
  const node = reader.sectionNode('startos-边界');
  assert.equal(node.classList.contains('is-target'), true);
  const content = reader.contentNode();
  assert.ok(content.scrollTop > 0, '目录点击应把正文滚到该小节');
  assert.ok(Math.abs(content.scrollTop - (node.offsetTop - 10)) <= 1,
    `scrollTop 应为目标偏移，实际 ${content.scrollTop} / 目标 ${node.offsetTop}`);
});

test('gotoAnchor：空锚点直接返回', async () => {
  const { reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', anchor: 'ecum-init' });
  assert.doesNotThrow(() => reader.gotoAnchor(''));
});

// ---------------------------------------------------------------------------
// 关闭与焦点
// ---------------------------------------------------------------------------

test('Esc 关闭面板', async () => {
  const { document, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', anchor: 'ecum-init' });
  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(reader.isOpen, false);
});

test('关闭按钮关闭面板', async () => {
  const { root, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md', anchor: 'ecum-init' });
  const close = root.querySelector('[data-rag-reader-action="close"]');
  shellOf(root).dispatch('click', { target: close });
  assert.equal(reader.isOpen, false);
});

test('关闭后 onClose 被调用一次', async () => {
  let calls = 0;
  const { root, reader } = makeReader({
    fetchImpl: async () => okResponse('# doc'),
    onClose: () => { calls += 1; },
  });
  await reader.open({ path: 'k.md' });
  shellOf(root).dispatch('click', {
    target: root.querySelector('[data-rag-reader-action="close"]'),
  });
  assert.equal(calls, 1);
  reader.close();
  assert.equal(calls, 1, '已关闭时重复 close 不应再触发回调');
});

test('关闭后焦点还给触发元素', async () => {
  const { document, root, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  const trigger = document.createElement('button');
  root.appendChild(trigger);
  trigger.focus();
  await reader.open({ path: 'k.md' });
  assert.notEqual(document.activeElement, trigger, '打开时应把焦点移入面板');
  reader.close();
  assert.equal(document.activeElement, trigger, '关闭后应归还焦点');
});

test('Escape 以外的键不影响面板', async () => {
  const { document, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md' });
  document.dispatch('keydown', { key: 'a' });
  assert.equal(reader.isOpen, true);
});

// ---------------------------------------------------------------------------
// 加载失败与重试
// ---------------------------------------------------------------------------

test('加载失败：显示错误与重试按钮，不抛错', async () => {
  const failing = async () => { throw new Error('网络断了'); };
  const { html, reader } = makeReader({ fetchImpl: failing });
  await assert.doesNotReject(reader.open({ path: 'k.md' }));
  const output = html();
  assert.match(output, /原文加载失败/);
  assert.match(output, /网络断了/);
  assert.match(output, /data-rag-reader-action="retry"/);
});

test('加载失败：HTTP 非 2xx 也走错误态', async () => {
  const { html, reader } = makeReader({
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
  });
  await reader.open({ path: 'knowledge/nope.md' });
  assert.match(html(), /404/);
});

test('加载失败：空内容视为失败', async () => {
  const { html, reader } = makeReader({ fetchImpl: async () => okResponse('   \n  ') });
  await reader.open({ path: 'k.md' });
  assert.match(html(), /原文加载失败/);
});

test('重试成功后恢复正文', async () => {
  let attempt = 0;
  const flaky = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('第一次失败');
    return okResponse('# doc');
  };
  const { root, html, reader } = makeReader({ fetchImpl: flaky });
  await reader.open({ path: 'k.md', anchor: 'ecum-init' });
  assert.match(html(), /原文加载失败/);

  const retry = root.querySelector('[data-rag-reader-action="retry"]');
  shellOf(root).dispatch('click', { target: retry });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(attempt, 2);
  assert.match(html(), /复位之后进入 EcuM_Init。/);
});

test('解析抛错也进入错误态', async () => {
  const deps = makeDeps({
    parseArticle: () => { throw new Error('Markdown 结构异常'); },
  });
  const { html, reader } = makeReader({ deps, fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md' });
  assert.match(html(), /Markdown 结构异常/);
});

// ---------------------------------------------------------------------------
// 安全
// ---------------------------------------------------------------------------

test('路径与查询中的 HTML 被转义', async () => {
  const { html, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({
    path: 'knowledge/<script>alert(1)</script>.md',
    query: '"><img src=x onerror=alert(1)>',
  });
  const output = html();
  assert.doesNotMatch(output, /<script/);
  assert.doesNotMatch(output, /<img/);
  assert.match(output, /&lt;script&gt;/);
});

test('javascript: 协议不会进入 href', async () => {
  const { html, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'javascript:alert(1)' });
  assert.doesNotMatch(html(), /href="javascript:/);
});

test('提供「在新标签打开原始 Markdown」兜底链接', async () => {
  const { html, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'knowledge/01-startup.md' });
  const output = html();
  assert.match(output, /class="rag-reader-raw"/);
  assert.match(output, /href="knowledge\/01-startup.md"/);
  assert.match(output, /target="_blank"/);
  assert.match(output, /rel="noreferrer"/);
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test('dispose：解绑文档级监听并移除面板', async () => {
  const { document, root, reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  await reader.open({ path: 'k.md' });
  assert.equal(document.listenerCount('keydown'), 1);
  reader.dispose();
  assert.equal(document.listenerCount('keydown'), 0);
  assert.equal(root.querySelectorAll('[data-rag-reader]').length, 0);
  assert.equal(reader.isOpen, false);
});

test('dispose：之后再 open 不产生副作用', async () => {
  const { reader } = makeReader({ fetchImpl: async () => okResponse('# doc') });
  reader.dispose();
  await reader.open({ path: 'k.md' });
  assert.equal(reader.isOpen, false);
});

test('并发 open：后一次请求的结果生效', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) { await slow; return okResponse('# 旧'); }
    return okResponse('# 新');
  };
  const { reader } = makeReader({ fetchImpl });
  const first = reader.open({ path: 'a.md', anchor: 'ecum-init' });
  await reader.open({ path: 'b.md', anchor: 'startos-边界' });
  release();
  await first;
  assert.equal(reader.path, 'b.md');
  assert.equal(reader.isOpen, true);
});

test('关闭会让在途请求失效', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const { reader } = makeReader({ fetchImpl: async () => { await slow; return okResponse('# doc'); } });
  const pending = reader.open({ path: 'k.md' });
  reader.close();
  release();
  await pending;
  assert.equal(reader.isOpen, false);
  assert.equal(reader.state, 'idle');
});
