// 集成层回归测试：覆盖「检索引擎 ← 检索 UI ← 文章阅读器」这三者拼接处的行为。
//
// 为什么单独一个文件：单元测试各自锁住了自己那一层（rag-ui / rag-reader / rag-markdown），
// 但真实缺陷往往长在接缝上 —— 锚点字段有没有被引擎透传、点卡片时传出去的参数对不对、
// 语料里的 anchor 能不能被渲染出的 HTML 真正命中。这些只在拼起来时才暴露。
//
// 约束：零依赖、不 spawn 子进程（本沙箱的 pipe stdio 会 EPERM），全部在进程内跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RagWorkspaceUi } from '../src/rag-ui.mjs';
import { parseArticle, renderArticle, findSection } from '../src/rag/article.mjs';
import { slugify } from '../src/rag/markdown.mjs';
import { createRoot, outerHtml } from './helpers/fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CITATION_SOURCE = 'knowledge/03-startup-ecum.md';

function makeHit(overrides = {}) {
  return {
    chunkId: 'startup-ecum-flexible#1',
    docId: 'startup-ecum-flexible',
    docTitle: 'EcuM Flexible 启动顺序',
    heading: 'StartOS 是控制权边界',
    anchor: 'startos-是控制权边界',
    text: 'StartOS 是启动流程中真正的控制权边界。',
    category: 'startup',
    tags: ['EcuM'],
    sourcePath: CITATION_SOURCE,
    score: 2.5,
    matched: ['startos'],
    highlights: [],
    ...overrides,
  };
}

function makeAnswer(query, overrides = {}) {
  return {
    query,
    coverage: 'high',
    sentences: [
      { text: 'StartOS 是启动流程中真正的控制权边界。', chunkId: 'startup-ecum-flexible#1', docTitle: 'EcuM Flexible 启动顺序', heading: 'StartOS 是控制权边界', score: 3.1 },
    ],
    citations: [
      {
        index: 1,
        chunkId: 'startup-ecum-flexible#1',
        docTitle: 'EcuM Flexible 启动顺序',
        heading: 'StartOS 是控制权边界',
        sourcePath: CITATION_SOURCE,
        anchor: 'startos-是控制权边界',
      },
    ],
    relatedTerms: [],
    followUps: [],
    boundary: '',
    ...overrides,
  };
}

function makeService(overrides = {}) {
  const calls = { search: [], answer: [] };
  return {
    calls,
    error: null,
    status: 'ready',
    stats() {
      return {
        status: 'ready',
        size: 1,
        documents: 1,
        categories: [{ id: 'startup', label: '启动与 EcuM', order: 1, count: 1 }],
        loadMs: 3,
      };
    },
    load() { return Promise.resolve(); },
    search(query, options = {}) {
      calls.search.push({ query, options });
      return overrides.search ? overrides.search(query, options) : [makeHit()];
    },
    answer(query) {
      calls.answer.push(query);
      return overrides.answer ? overrides.answer(query) : makeAnswer(query);
    },
    suggest() { return []; },
    related() { return []; },
  };
}

/** 记录 reader.open 的调用；可注入拒绝行为。 */
function makeReader({ reject = false, error = new Error('读取失败') } = {}) {
  const calls = [];
  return {
    calls,
    open(payload) {
      calls.push(payload);
      return reject ? Promise.reject(error) : Promise.resolve();
    },
  };
}

/**
 * 挂载 UI 并跑一次检索，让结果卡片与答案面板都渲染出来。
 * 返回的 root 上已经有一次点击能用的完整 DOM。
 */
async function mountAndSearch({ reader = null, service = null, query = 'StartOS 边界' } = {}) {
  const document = createRoot().document;
  const root = document.createElement('div');
  root.setAttribute('id', 'knowledge-content');
  const notes = [];
  const ui = new RagWorkspaceUi({
    service: service ?? makeService(),
    notify: (message, isError) => notes.push({ message, isError }),
    reader,
  });
  ui.mount(root);
  ui.render();
  // 走真实交互路径：填输入框 → 提交表单。
  // 注意：事件委托挂在 root 上，而 DOM 桩不做冒泡，所以必须在 root 上派发。
  const input = root.querySelector('#rag-query');
  if (input) input.value = query;
  root.dispatch('submit', { preventDefault() {}, target: root.querySelector('#rag-search-form') });
  // 让 runSearch 内部的微任务跑完。
  await new Promise(resolve => setTimeout(resolve, 0));
  return { document, root, ui, notes, html: () => outerHtml(root) };
}

const query = (root, selector) => root.querySelector(selector);
const queryAll = (root, selector) => root.querySelectorAll(selector);

// ---------------------------------------------------------------------------
// 1~2. 「查看原文」的两种形态
// ---------------------------------------------------------------------------

test('注入 reader 后，卡片「查看原文」是按钮且带上 path/anchor/chunk', async () => {
  const reader = makeReader();
  const { root } = await mountAndSearch({ reader });
  const buttons = queryAll(root, '[data-rag-action="open-source"]');
  assert.ok(buttons.length >= 1, '应渲染出「查看原文」按钮');

  const cardButton = buttons.find(node => node.classList.contains('rag-source-inline'));
  assert.ok(cardButton, '卡片上的「查看原文」应带 rag-source-inline 类');
  assert.equal(cardButton.getAttribute('data-rag-path'), CITATION_SOURCE);
  assert.equal(cardButton.getAttribute('data-rag-anchor'), 'startos-是控制权边界');
  assert.equal(cardButton.getAttribute('data-rag-chunk'), 'startup-ecum-flexible#1');
  assert.equal(cardButton.getAttribute('target'), null, '按钮不应有 target 属性');
  assert.equal(cardButton.getAttribute('href'), null, '按钮不应有 href 属性');
});

test('未注入 reader 时退回成新标签打开 .md 的链接', async () => {
  const { root, html } = await mountAndSearch({ reader: null });
  // DOM 桩的 querySelectorAll 不支持 	ag.class 复合选择器，所以先按类名取再筛标签名。
  const links = queryAll(root, '.rag-source').filter(node => node.nodeName === 'A');
  assert.equal(links.length >= 1, true, '应有 a.rag-source 兜底链接');
  const link = links[0];
  assert.equal(link.getAttribute('href'), CITATION_SOURCE);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noreferrer');
  assert.equal(
    queryAll(root, '[data-rag-action="open-source"]').length,
    0,
    '没有 reader 时不应产生 open-source 控件',
  );
  assert.match(html(), /查看原文/);
});

// ---------------------------------------------------------------------------
// 3~5. 点击 → reader.open 的参数与失败兜底
// ---------------------------------------------------------------------------

test('点击卡片「查看原文」：reader.open 收到正确参数且阻止默认行为', async () => {
  const reader = makeReader();
  const { root } = await mountAndSearch({ reader, query: 'EcuM 启动顺序' });
  const button = queryAll(root, '[data-rag-action="open-source"]')
    .find(node => node.classList.contains('rag-source-inline'));
  assert.ok(button);

  let prevented = 0;
  root.dispatch('click', { target: button, preventDefault() { prevented += 1; } });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(prevented, 1, '应调用 preventDefault');
  assert.equal(reader.calls.length, 1, 'reader.open 应被调用一次');
  assert.deepEqual(reader.calls[0], {
    path: CITATION_SOURCE,
    anchor: 'startos-是控制权边界',
    chunkId: 'startup-ecum-flexible#1',
    query: 'EcuM 启动顺序',
  });
});

test('点击答案引用条目：reader.open 定位到该引用的小节', async () => {
  const reader = makeReader();
  const { root } = await mountAndSearch({ reader });
  const citeLink = queryAll(root, '.rag-cite-link')[0];
  assert.ok(citeLink, '有 reader 时应渲染可点击的引用条目');
  assert.equal(citeLink.getAttribute('data-rag-action'), 'open-source');
  assert.equal(citeLink.getAttribute('data-rag-anchor'), 'startos-是控制权边界');

  root.dispatch('click', { target: citeLink, preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(reader.calls.length, 1);
  assert.equal(reader.calls[0].anchor, 'startos-是控制权边界');
  assert.equal(reader.calls[0].path, CITATION_SOURCE);
});

test('reader.open 拒绝时不产生未捕获异常，并给出提示', async () => {
  const reader = makeReader({ reject: true });
  const { root, notes } = await mountAndSearch({ reader });
  const button = queryAll(root, '[data-rag-action="open-source"]')
    .find(node => node.classList.contains('rag-source-inline'));

  // 放一个 process 级监听，确认没有 promise 逃逸出去。
  const escaped = [];
  const onUnhandled = reason => escaped.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    root.dispatch('click', { target: button, preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(escaped, [], '不应有未捕获的 Promise 拒绝');
  assert.equal(notes.length >= 1, true, '应通过 notify 告知用户');
  assert.match(notes[notes.length - 1].message, /原文|重试/);
});

// ---------------------------------------------------------------------------
// 6. 伪协议不产生可点击入口
// ---------------------------------------------------------------------------

test('javascript: 伪协议路径不会变成可点击入口', async () => {
  const reader = makeReader();
  const service = makeService({
    search: () => [makeHit({ sourcePath: 'javascript:alert(1)' })],
  });
  const { root } = await mountAndSearch({ reader, service });

  const openers = queryAll(root, '[data-rag-action="open-source"]');
  for (const node of openers) {
    const target = node.getAttribute('data-rag-path');
    assert.equal(
      String(target ?? '').startsWith('javascript:'),
      false,
      '伪协议不应进入 data-rag-path',
    );
  }
  // 兜底链接同理：没有可用的 href 就不该渲染 <a>。
  for (const link of queryAll(root, '.rag-source').filter(node => node.nodeName === 'A')) {
    assert.equal(String(link.getAttribute('href') ?? '').startsWith('javascript:'), false);
  }
});

test('没有 sourcePath 的命中不会渲染「查看原文」', async () => {
  const reader = makeReader();
  // 答案面板用空引用，隔离掉"引用条目也带 open-source"的干扰，只验证卡片。
  const service = makeService({
    search: () => [makeHit({ sourcePath: '' })],
    answer: query => makeAnswer(query, { citations: [], sentences: [] }),
  });
  const { root } = await mountAndSearch({ reader, service });
  assert.equal(queryAll(root, '[data-rag-action="open-source"]').length, 0);
  assert.equal(queryAll(root, '.rag-source').length, 0, '没有可用路径时连兜底链接也不该出现');
});

// ---------------------------------------------------------------------------
// 7~8. 端到端锚点一致性（最有价值的一条）
// ---------------------------------------------------------------------------

async function loadCorpus() {
  const raw = await readFile(path.join(repoRoot, 'knowledge', 'corpus.json'), 'utf8');
  return JSON.parse(raw);
}

test('同一个 .md 渲染出的所有 id 互不重复', async () => {
  // 阅读器用 querySelector('[id="<anchor>"]') 定位，只拿第一个匹配。
  // 一旦同一文件里出现两个相同 id，点「查看原文」就会跳到错的那个。
  // 真实案例：09-boundary.md 里有一篇文档标题与它自己的首个小节同名。
  const corpus = await loadCorpus();
  const sourcePaths = [...new Set(
    (corpus.documents ?? []).map(doc => doc?.source?.path).filter(Boolean),
  )];
  assert.ok(sourcePaths.length > 0, '语料应引用至少一个分册');

  const problems = [];
  let totalIds = 0;
  for (const sourcePath of sourcePaths) {
    const markdown = await readFile(path.join(repoRoot, sourcePath), 'utf8');
    const article = parseArticle(markdown, { path: sourcePath });
    const html = renderArticle(article);

    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
    totalIds += ids.length;
    const seen = new Map();
    for (const id of ids) {
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      if (count === 2) problems.push(`${sourcePath}: id="${id}" 出现多次`);
    }
  }

  assert.ok(totalIds > 100, `应检查到足够多的 id，实际 ${totalIds}`);
  assert.deepEqual(problems, [], `存在重复 id：\n${problems.join('\n')}`);
});

test('文档级 H1 的 id 使用 doc- 前缀，不占用小节锚点命名空间', async () => {
  const corpus = await loadCorpus();
  const doc = (corpus.documents ?? []).find(item => item?.source?.path);
  assert.ok(doc);

  const markdown = await readFile(path.join(repoRoot, doc.source.path), 'utf8');
  const article = parseArticle(markdown, { path: doc.source.path });
  const html = renderArticle(article);

  // 每个 rag-doc 都应该有一个 doc- 开头的 H1 id，且数量等于文档数。
  const docIds = [...html.matchAll(/<h1 id="(doc-[^"]+)"/g)].map(match => match[1]);
  assert.equal(docIds.length, article.documents.length, '每篇文档应有且仅有一个 H1 锚点');
  assert.equal(new Set(docIds).size, docIds.length, '文档级 id 之间不应重复');

  // 小节锚点里不应该混进 doc- 前缀（否则说明让位逻辑被写反了）。
  for (const item of article.documents) {
    for (const section of item.sections) {
      assert.equal(
        section.anchor.startsWith('doc-'),
        false,
        `小节锚点不该以 doc- 开头：${section.anchor}`,
      );
    }
  }
});

test('标题与小节同名的文档，该小节仍能被唯一定位', async () => {
  // 这条直接复现那个真实缺陷：文档标题 == 它自己的小节标题。
  const corpus = await loadCorpus();
  const markdown = await readFile(
    path.join(repoRoot, 'knowledge/09-boundary.md'), 'utf8');
  const article = parseArticle(markdown, { path: 'knowledge/09-boundary.md' });
  const html = renderArticle(article);

  // 找到标题与某个小节标题相同的文档。
  const clash = article.documents.find(item =>
    item.sections.some(section => slugify(section.heading) === slugify(item.title)));
  assert.ok(clash, '这份分册里应仍存在标题与小节同名的文档（回归前提）');

  const section = clash.sections.find(item => slugify(item.heading) === slugify(clash.title));
  const occurrences = [...html.matchAll(new RegExp(`id="${section.anchor}"`, 'g'))];
  assert.equal(occurrences.length, 1, `小节 id 应只出现一次：${section.anchor}`);

  // H1 拿到了独立的 doc- 前缀，因此 querySelector 命中的是小节而不是标题。
  assert.equal(html.includes(`id="doc-${section.anchor}"`), true,
    '文档标题应让位到 doc- 命名空间');

  // findSection 仍然只认小节，定位结果不变。
  const located = findSection(article, section.anchor);
  assert.equal(located?.section?.anchor, section.anchor);
  assert.equal(located?.document?.id, clash.id);

  const known = new Set((corpus.documents ?? []).flatMap(item => (item.chunks ?? []).map(c => c.anchor)));
  assert.equal(known.has(section.anchor), true, '该小节锚点应仍在语料里');
});

test('语料里每个 chunk.anchor 都能被 renderArticle 渲染出的 id 命中', async () => {
  const corpus = await loadCorpus();
  const documents = Array.isArray(corpus.documents) ? corpus.documents : [];
  assert.ok(documents.length > 0, '语料不应为空');

  const mismatches = [];
  let checked = 0;
  const cache = new Map();

  for (const doc of documents) {
    const sourcePath = doc?.source?.path;
    if (!sourcePath) continue;

    if (!cache.has(sourcePath)) {
      const markdown = await readFile(path.join(repoRoot, sourcePath), 'utf8');
      const article = parseArticle(markdown, { path: sourcePath });
      cache.set(sourcePath, { article, html: renderArticle(article) });
    }
    const { html } = cache.get(sourcePath);

    for (const chunk of doc.chunks ?? []) {
      const anchor = String(chunk.anchor ?? '');
      if (!anchor) {
        mismatches.push(`${chunk.id}: 缺少 anchor`);
        continue;
      }
      checked += 1;
      // 阅读器就是靠 querySelector('[id="<anchor>"]') 定位的，这里用同一判据。
      if (!html.includes(`id="${anchor}"`)) {
        mismatches.push(`${chunk.id}: 渲染结果里找不到 id="${anchor}"`);
      }
    }
  }

  assert.equal(mismatches.length, 0, `存在 ${mismatches.length} 个锚点不一致：\n${mismatches.slice(0, 10).join('\n')}`);
  assert.ok(checked > 100, `应检查到足够多的锚点，实际 ${checked}`);
});

test('chunk.anchor 与 slugify(chunk.heading) 的规则一致', async () => {
  const corpus = await loadCorpus();
  const mismatches = [];
  let checked = 0;

  for (const doc of corpus.documents ?? []) {
    // 同一文档内小节标题可能重名，slugify 去重会加 -2/-3，所以按出现顺序对账。
    const seen = new Map();
    for (const chunk of doc.chunks ?? []) {
      const heading = String(chunk.heading ?? '');
      if (!heading) continue;
      const base = slugify(heading);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const expected = count === 1 ? base : `${base}-${count}`;
      checked += 1;
      if (String(chunk.anchor ?? '') !== expected) {
        mismatches.push(`${chunk.id}: anchor=${chunk.anchor} 期望=${expected}`);
      }
    }
  }

  assert.ok(checked > 100, `应检查到足够多的小节，实际 ${checked}`);
  assert.equal(mismatches.length, 0, `与 slugify 规则不一致 ${mismatches.length} 处：\n${mismatches.slice(0, 10).join('\n')}`);
});

test('语料自带的 anchor 能通过 findSection 找回同一小节', async () => {
  const corpus = await loadCorpus();
  const doc = (corpus.documents ?? []).find(item => (item.chunks ?? []).length >= 2);
  assert.ok(doc, '应至少有一篇多小节文档');

  const sourcePath = doc.source.path;
  const markdown = await readFile(path.join(repoRoot, sourcePath), 'utf8');
  const article = parseArticle(markdown, { path: sourcePath });

  for (const chunk of doc.chunks.slice(0, 5)) {
    const located = findSection(article, chunk.anchor);
    assert.ok(located, `findSection 应能定位 ${chunk.anchor}`);
    // findSection 返回 { document, section } 包装对象（与阅读器 locate() 同构）。
    const section = located.section ?? located;
    assert.equal(
      slugify(section.heading),
      slugify(chunk.heading),
      `${chunk.anchor} 命中的小节标题应与 chunk.heading 一致`,
    );
  }
});

test('引擎命中的 anchor 与语料 chunk 的 anchor 完全一致（走真实检索）', async () => {
  // 这条把「引擎 → UI → 阅读器」串成一条链：引擎给出的每个命中，
  // 其 anchor 必须是该 chunk 在 corpus 里的 anchor，否则阅读器会跳错地方。
  const { createKnowledgeIndex } = await import('../src/rag/index.mjs');
  const { composeAnswer } = await import('../src/rag/answer.mjs');

  const corpus = await loadCorpus();
  const index = createKnowledgeIndex(corpus);
  const hits = index.search('StartOS 控制权边界', { limit: 5 });
  assert.ok(hits.length > 0, '真实检索应有命中');

  const anchorByChunk = new Map();
  for (const doc of corpus.documents ?? []) {
    for (const chunk of doc.chunks ?? []) anchorByChunk.set(chunk.id, chunk.anchor);
  }

  for (const hit of hits) {
    assert.equal(
      hit.anchor,
      anchorByChunk.get(hit.chunkId),
      `${hit.chunkId} 的 anchor 应与语料一致`,
    );
    assert.ok(String(hit.anchor ?? '').length > 0, `${hit.chunkId} 应带非空 anchor`);
  }

  const answer = composeAnswer('StartOS 控制权边界', hits);
  for (const citation of answer.citations ?? []) {
    assert.equal(
      citation.anchor,
      anchorByChunk.get(citation.chunkId),
      `引用 ${citation.chunkId} 应带与语料一致的 anchor`,
    );
  }
});

test('检索命中的 chunkId 在语料里真实存在', async () => {
  const { createKnowledgeIndex } = await import('../src/rag/index.mjs');
  const corpus = await loadCorpus();
  const index = createKnowledgeIndex(corpus);
  const hits = index.search('刷写 分区 掉电', { limit: 8 });
  assert.ok(hits.length > 0);

  const known = new Set();
  for (const doc of corpus.documents ?? []) {
    for (const chunk of doc.chunks ?? []) known.add(chunk.id);
  }
  for (const hit of hits) {
    assert.equal(known.has(hit.chunkId), true, `${hit.chunkId} 应在语料里`);
  }
});
