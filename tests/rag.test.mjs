import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { normalize, tokenize } from '../src/rag/tokenize.mjs';
import { SYNONYM_GROUPS, expandToken, termOf } from '../src/rag/synonyms.mjs';
import { createKnowledgeIndex } from '../src/rag/index.mjs';
import { composeAnswer } from '../src/rag/answer.mjs';
import { createRagService } from '../src/rag/loader.mjs';

// --- fixture corpus：8 个文档、16 个 chunk，中英混合 ---
const corpus = {
  version: 1,
  title: '测试知识库',
  categories: [
    { id: 'startup', label: '启动与 EcuM', order: 1 },
    { id: 'uds', label: '诊断与刷写', order: 2 },
    { id: 'communication', label: '通信与网络管理', order: 3 },
    { id: 'storage', label: '存储 NvM/Fee', order: 4 },
    { id: 'os', label: 'OS 与多核调度', order: 5 },
    { id: 'xcp', label: 'XCP 标定', order: 6 },
    { id: 'boundary', label: '边界与常见误解', order: 9 },
  ],
  documents: [
    {
      id: 'startup-ecum',
      title: 'EcuM 与启动顺序',
      category: 'startup',
      tags: ['EcuM', 'StartOS', '启动'],
      source: { kind: 'original', path: 'knowledge/06-startup-ecum.md' },
      chunks: [
        {
          id: 'startup-ecum#1',
          heading: 'StartOS 是控制权边界',
          level: 2,
          text: 'EcuM_Init 完成基础初始化后，把控制权交给 StartOS。StartOS 之后进入中断上下文，EcuM_StartupTwo 才继续执行。上电复位后要先检查唤醒源，再决定启动路径。',
          keywords: ['EcuM_Init', 'StartOS', '上电'],
        },
        {
          id: 'startup-ecum#2',
          heading: '启动流程的阶段划分',
          level: 2,
          text: '启动流程通常分为上电、初始化、启动三个阶段。每个阶段都有明确的职责边界，便于调试启动时序并定位问题。',
          keywords: ['启动流程', '上电', '初始化'],
        },
      ],
    },
    {
      id: 'startup-bswm',
      title: 'BswM 模式管理',
      category: 'startup',
      tags: ['BswM', 'EcuM', '模式'],
      source: { kind: 'original', path: 'knowledge/07-startup-bswm.md' },
      chunks: [
        {
          id: 'startup-bswm#1',
          heading: 'BswM 模式仲裁',
          level: 2,
          text: 'BswM 根据规则仲裁模式请求，把 EcuM 的模式变化分发到各模块。模式管理保证系统状态一致，避免模块各自为政。',
          keywords: ['BswM', 'EcuM', '模式管理'],
        },
        {
          id: 'startup-bswm#2',
          heading: '模式切换的时序',
          level: 2,
          text: '模式切换需要遵循请求、仲裁、执行三个步骤，避免在中断上下文里做耗时操作，否则会破坏时序。',
          keywords: ['模式切换', '中断'],
        },
      ],
    },
    {
      id: 'uds-flash',
      title: 'UDS 刷写流程',
      category: 'uds',
      tags: ['UDS', '刷写', '编程'],
      source: { kind: 'original', path: 'knowledge/08-uds-flash.md' },
      chunks: [
        {
          id: 'uds-flash#1',
          heading: '刷写流程与安全访问',
          level: 2,
          text: '刷写流程先进入扩展会话，完成安全访问后再执行编程。RequestDownload 请求下载数据到指定扇区，随后逐块传输固件。',
          keywords: ['刷写流程', '编程', '扇区'],
        },
        {
          id: 'uds-flash#2',
          heading: '分区与扇区管理',
          level: 2,
          text: '刷写前要擦除目标分区和扇区，校验通过后才允许写入新的固件映像。分区划分影响回滚策略和升级安全。',
          keywords: ['分区', '扇区', '刷写'],
        },
      ],
    },
    {
      id: 'comm-nm',
      title: '网络管理 NM',
      category: 'communication',
      tags: ['NM', '通信', '唤醒'],
      source: { kind: 'original', path: 'knowledge/09-comm-nm.md' },
      chunks: [
        {
          id: 'comm-nm#1',
          heading: '网络管理 NM',
          level: 2,
          text: '网络管理 NM 负责协调总线的休眠与唤醒。所有节点进入休眠后网络才真正休眠，任一节点请求唤醒就恢复通信。',
          keywords: ['网络管理', '休眠', '唤醒'],
        },
        {
          id: 'comm-nm#2',
          heading: '报文与通信调度',
          level: 2,
          text: '周期报文由 Com 模块打包成 PDU，经 PduR 路由到 CanIf 发送。消息调度影响总线负载和实时性。',
          keywords: ['报文', 'PDU', '路由'],
        },
      ],
    },
    {
      id: 'storage-nvm',
      title: 'NvM 存储',
      category: 'storage',
      tags: ['NvM', 'Fee', 'Fls'],
      source: { kind: 'original', path: 'knowledge/10-storage-nvm.md' },
      chunks: [
        {
          id: 'storage-nvm#1',
          heading: 'NvM 非易失存储',
          level: 2,
          text: 'NvM 负责把标定参数和故障码保存到非易失存储。掉电前必须完成写入，才能保证数据一致和可靠。',
          keywords: ['NvM', '非易失', '故障码'],
        },
        {
          id: 'storage-nvm#2',
          heading: 'Fee 与 Fls 的分层',
          level: 2,
          text: 'Fee 在 Flash 上模拟 EEPROM 行为，Fls 提供底层扇区读写。分层设计让上层不关心物理介质细节。',
          keywords: ['Fee', 'Fls', '扇区'],
        },
      ],
    },
    {
      id: 'os-scheduler',
      title: 'OS 调度',
      category: 'os',
      tags: ['OS', '调度', '多核'],
      source: { kind: 'original', path: 'knowledge/11-os-scheduler.md' },
      chunks: [
        {
          id: 'os-scheduler#1',
          heading: 'OS 调度与优先级',
          level: 2,
          text: 'OS 按优先级调度周期任务，中断服务例程结束后回到最高优先级就绪任务。调度策略决定系统的实时性。',
          keywords: ['OS', '调度', '周期任务'],
        },
        {
          id: 'os-scheduler#2',
          heading: '自旋锁与核间通信',
          level: 2,
          text: '多核场景下用自旋锁保护共享数据，核间通信用 IOC 传递消息，避免竞态导致的数据损坏。',
          keywords: ['自旋锁', 'IOC', '核间'],
        },
      ],
    },
    {
      id: 'xcp-cal',
      title: 'XCP 标定',
      category: 'xcp',
      tags: ['XCP', '标定', 'DAQ'],
      source: { kind: 'original', path: 'knowledge/12-xcp-cal.md' },
      chunks: [
        {
          id: 'xcp-cal#1',
          heading: 'XCP 标定与测量',
          level: 2,
          text: 'XCP 通过 DAQ 采集运行数据用于标定。标定参数可以在线修改，观察修改对控制效果的影响。',
          keywords: ['XCP', '标定', 'DAQ'],
        },
        {
          id: 'xcp-cal#2',
          heading: '标定数据的持久化',
          level: 2,
          text: '标定完成后的参数需要写入 NvM 保存，上电时重新加载，保证每次启动的标定值一致。',
          keywords: ['标定', 'NvM', '保存'],
        },
      ],
    },
    {
      id: 'boundary-myth',
      title: '教学仿真的边界',
      category: 'boundary',
      tags: ['边界', '误解', '仿真'],
      source: { kind: 'original', path: 'knowledge/13-boundary-myth.md' },
      chunks: [
        {
          id: 'boundary-myth#1',
          heading: '教学仿真的边界',
          level: 2,
          text: '本知识库只做教学仿真，不生成 ARXML 也不执行真实烧录。内容用于理解概念，不代表量产工具。',
          keywords: ['边界', 'ARXML', '仿真'],
        },
        {
          id: 'boundary-myth#2',
          heading: '常见误解',
          level: 2,
          text: '常见误解是认为引擎能自动生成配置或直接刷写硬件，实际上这里只演示检索与概念讲解。',
          keywords: ['误解', '刷写', '配置'],
        },
      ],
    },
  ],
};

const index = createKnowledgeIndex(corpus);

// --- tokenize.mjs ---
test('normalize：全角转半角、小写、压缩空白', () => {
  assert.equal(normalize('  ＡＢＣ　启动  流程 \n'), 'abc 启动 流程');
  assert.equal(normalize('EcuM   Startup'), 'ecum startup');
});

test('normalize：非字符串输入返回空串', () => {
  for (const value of [null, undefined, 42, {}, []]) assert.equal(normalize(value), '');
});

test('tokenize：中文单字 + 相邻二元组', () => {
  assert.deepEqual(tokenize('启动流程'), ['启', '动', '流', '程', '启动', '动流', '流程']);
});

test('tokenize：英文整词与驼峰/下划线拆分（契约示例）', () => {
  assert.deepEqual(tokenize('EcuM_StartupTwo'), ['ecum_startuptwo', 'ecum', 'startup', 'two']);
});

test('tokenize：纯数字保留、标点丢弃、非字符串返回空数组', () => {
  assert.deepEqual(tokenize('2024'), ['2024']);
  assert.deepEqual(tokenize('，。！'), []);
  assert.deepEqual(tokenize(null), []);
});

// --- synonyms.mjs ---
test('SYNONYM_GROUPS：至少 40 组且每组至少两个 token', () => {
  assert.ok(SYNONYM_GROUPS.length >= 40, `仅有 ${SYNONYM_GROUPS.length} 组`);
  for (const group of SYNONYM_GROUPS) {
    assert.ok(Array.isArray(group) && group.length >= 2);
    for (const token of group) assert.equal(typeof token, 'string');
  }
});

test('expandToken：中英术语互扩（标定 ↔ calibration）', () => {
  assert.ok(expandToken('标定').includes('calibration'));
  assert.ok(expandToken('calibration').includes('标定'));
  assert.ok(!expandToken('标定').includes('标定'));
});

test('expandToken：未知 token 返回空数组，termOf 反查术语名', () => {
  assert.deepEqual(expandToken('不存在的词'), []);
  assert.deepEqual(expandToken(null), []);
  assert.equal(termOf('标定'), 'XCP / 标定测量');
  assert.equal(termOf('不存在的词'), null);
});

// --- index.mjs ---
test('索引统计：size / documents / categories 正确', () => {
  assert.equal(index.size, 16);
  assert.equal(index.documents, 8);
  const startup = index.categories.find(category => category.id === 'startup');
  assert.ok(startup);
  assert.equal(startup.count, 2);
  assert.equal(index.categories[0].id, 'startup');
});

test('BM25 排序：分数单调不增且命中结果分数为正', () => {
  const hits = index.search('刷写');
  assert.ok(hits.length > 0);
  for (const hit of hits) assert.ok(hit.score > 0);
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score);
  assert.equal(hits[0].docId, 'uds-flash');
});

test('中文查询「启动流程」命中语义相关 chunk', () => {
  const hits = index.search('启动流程');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].docId, 'startup-ecum');
  assert.ok(hits.some(hit => hit.chunkId === 'startup-ecum#2'));
});

test('中文查询「休眠唤醒」命中通信网络管理文档', () => {
  const hits = index.search('休眠唤醒');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].docId, 'comm-nm');
});

test('中文查询「标定」命中 XCP 标定文档', () => {
  const hits = index.search('标定');
  assert.equal(hits[0].docId, 'xcp-cal');
});

test('英文术语「EcuM」命中中文文档', () => {
  const hits = index.search('EcuM');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].category, 'startup');
  assert.ok(hits.some(hit => hit.docId === 'startup-ecum'));
  assert.ok(hits[0].matched.includes('ecum'));
});

test('分类过滤：category 只返回该分类 chunk', () => {
  const hits = index.search('启动', { category: 'startup' });
  assert.ok(hits.length > 0);
  for (const hit of hits) assert.equal(hit.category, 'startup');
  assert.deepEqual(index.search('启动', { category: 'nope' }), []);
});

test('limit 边界：limit=1 只返回一条，limit=0 返回空', () => {
  assert.equal(index.search('刷写', { limit: 1 }).length, 1);
  assert.deepEqual(index.search('刷写', { limit: 0 }), []);
  assert.ok(index.search('刷写', { limit: 999 }).length <= 50);
});

test('健壮性：空查询 / 纯标点 / emoji / 超长串 / 非字符串 → []', () => {
  for (const query of ['', '   ', '，。！？', '😀😀😀', 'a'.repeat(5000), '启'.repeat(3000)]) {
    assert.deepEqual(index.search(query), [], `query=${query.slice(0, 10)}`);
  }
  for (const value of [null, undefined, 123, {}, []]) assert.deepEqual(index.search(value), []);
});

test('highlights：区间在界内、有序、不重叠、长度 > 0、≤ 8 段', () => {
  // 注意：只有正文真的包含查询词时才强制要求高亮。
  // 一个 chunk 可能因为同义扩展或其它 token 被召回，却并不含查询里的那个词；
  // 这时没有任何高亮是正确行为，不能拿无关词（如固定的「启动」）去要求高亮。
  for (const query of ['刷写', '启动流程', 'EcuM', '标定 参数']) {
    const primary = query.split(/\s+/)[0];
    for (const hit of index.search(query)) {
      const spans = hit.highlights;
      assert.ok(spans.length <= 8);
      let cursor = -1;
      for (const span of spans) {
        assert.equal(span.length, 2);
        const [start, end] = span;
        assert.ok(start >= 0 && end <= hit.text.length);
        assert.ok(start < end);
        assert.ok(start >= cursor, '区间必须有序且不重叠');
        cursor = end;
      }
      const shouldHighlight = hit.text.toLowerCase().includes(primary.toLowerCase());
      if (shouldHighlight) {
        assert.ok(spans.length > 0, `${query} / ${hit.chunkId} 正文含「${primary}」，应有高亮`);
      }
    }
  }
});

test('确定性：同一查询两次结果完全一致', () => {
  const first = index.search('刷写 分区 标定');
  const second = index.search('刷写 分区 标定');
  assert.deepEqual(first.map(hit => hit.chunkId), second.map(hit => hit.chunkId));
});

test('suggest：前缀补全与同义建议', () => {
  assert.ok(index.suggest('ec').includes('ecum'));
  const list = index.suggest('刷写', { limit: 3 });
  assert.ok(Array.isArray(list) && list.length <= 3);
  assert.deepEqual(index.suggest(''), []);
  assert.deepEqual(index.suggest(null), []);
});

test('get：存在的 chunkId 返回记录，不存在返回 null', () => {
  const hit = index.get('startup-ecum#1');
  assert.ok(hit);
  assert.equal(hit.heading, 'StartOS 是控制权边界');
  assert.equal(hit.docTitle, 'EcuM 与启动顺序');
  assert.equal(hit.sourcePath, 'knowledge/06-startup-ecum.md');
  assert.equal(index.get('不存在#1'), null);
});

test('related：同文档 chunk 优先返回', () => {
  const related = index.related('startup-ecum#1');
  assert.ok(related.length > 0);
  assert.equal(related[0].chunkId, 'startup-ecum#2');
  assert.deepEqual(index.related('不存在#1'), []);
});

// --- answer.mjs ---
const fakeHits = (score, textRedundant = false) => ([
  {
    chunkId: 'chunk#1',
    docId: 'doc',
    docTitle: '文档',
    heading: '标题',
    text: textRedundant || '启动流程分为上电阶段与初始化阶段，每个阶段职责明确。',
    category: 'startup',
    tags: [],
    sourcePath: 'knowledge/x.md',
    score,
    matched: ['启动', '流程'],
    highlights: [],
  },
]);

test('composeAnswer：coverage 分级（none / low / medium / high）', () => {
  assert.equal(composeAnswer('启动', []).coverage, 'none');
  assert.equal(composeAnswer('启动', fakeHits(0.5)).coverage, 'low');
  assert.equal(composeAnswer('启动', fakeHits(2)).coverage, 'medium');
  assert.equal(composeAnswer('启动', fakeHits(5)).coverage, 'high');
});

test('composeAnswer：citations 与 sentences 的 chunkId 一一对应', () => {
  const hits = [
    { ...fakeHits(4)[0], chunkId: 'a#1', text: '启动流程包含上电阶段，必须先复位时钟。第二个句子用于补充说明启动细节。' },
    { ...fakeHits(3)[0], chunkId: 'b#1', docTitle: '另一文档', text: '启动流程的初始化阶段需要配置时钟，然后才能进入应用。' },
  ];
  const answer = composeAnswer('启动流程', hits, { maxSentences: 6 });
  assert.ok(answer.sentences.length > 0);
  const sentenceChunks = [...new Set(answer.sentences.map(sentence => sentence.chunkId))];
  assert.deepEqual(answer.citations.map(citation => citation.chunkId), sentenceChunks);
  answer.citations.forEach((citation, i) => assert.equal(citation.index, i + 1));
  assert.ok(answer.followUps.length >= 2 && answer.followUps.length <= 4);
});

test('composeAnswer：抽取式合成，句子均来自 hits 原文', () => {
  const hits = fakeHits(4);
  const answer = composeAnswer('启动', hits);
  for (const sentence of answer.sentences) {
    const origin = hits.find(hit => hit.chunkId === sentence.chunkId);
    assert.ok(origin.text.includes(sentence.text), '答案不得生成原文没有的句子');
  }
});

test('composeAnswer：边界提醒', () => {
  const hits = [{
    chunkId: 'boundary#1', docId: 'boundary', docTitle: '边界', heading: '边界',
    text: '本知识库只做教学仿真，不生成 ARXML 也不执行真实烧录。',
    category: 'boundary', tags: [], sourcePath: '', score: 4, matched: ['边界'], highlights: [],
  }];
  const answer = composeAnswer('边界', hits);
  assert.ok(typeof answer.boundary === 'string' && answer.boundary.length > 0);
});

// --- loader.mjs ---
test('loader：注入 fetchImpl 后 load 成功、search 可用、记录 loadMs', async () => {
  const service = createRagService({
    fetchImpl: async () => ({ ok: true, json: async () => corpus }),
  });
  assert.equal(service.status, 'idle');
  const p1 = service.load();
  const p2 = service.load();
  assert.equal(p1, p2, 'load 幂等返回同一 promise');
  await p1;
  assert.equal(service.status, 'ready');
  assert.ok(service.search('刷写').length > 0);
  assert.ok(service.answer('启动').coverage !== 'none');
  assert.ok(Array.isArray(service.suggest('ec')));
  const stats = service.stats();
  assert.equal(stats.status, 'ready');
  assert.equal(stats.size, 16);
  assert.ok(stats.loadMs >= 0);
});

test('loader：加载失败降级为 error，不抛错且 search 返回 []', async () => {
  const service = createRagService({
    fetchImpl: async () => { throw new Error('network'); },
  });
  await service.load();
  assert.equal(service.status, 'error');
  assert.ok(service.error instanceof Error);
  assert.deepEqual(service.search('刷写'), []);
  assert.equal(service.answer('刷写').coverage, 'none');
  assert.equal(service.stats(), null);
});

// --- 性能软断言（宽松阈值，避免 CI 抖动）---
test('性能：300 chunk 索引构建 < 150ms，单次查询 < 15ms', () => {
  const documents = [];
  for (let d = 0; d < 60; d += 1) {
    const chunks = [];
    for (let c = 0; c < 5; c += 1) {
      chunks.push({
        id: `bulk${d}#${c + 1}`,
        heading: `批量模块 ${d}`,
        level: 2,
        text: `这是第 ${d} 个文档的第 ${c} 个片段，介绍启动流程、诊断刷写、标定测量与休眠唤醒等概念，用于性能测试。`,
        keywords: ['启动', '诊断', '标定'],
      });
    }
    documents.push({ id: `bulk${d}`, title: `批量文档 ${d}`, category: 'methodology', tags: ['测试'], chunks });
  }
  const bulk = { version: 1, categories: [{ id: 'methodology', label: '方法论', order: 1 }], documents };
  const start = performance.now();
  const built = createKnowledgeIndex(bulk);
  const buildMs = performance.now() - start;
  assert.equal(built.size, 300);
  assert.ok(buildMs < 150, `构建耗时 ${buildMs.toFixed(1)}ms`);

  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) built.search('启动流程 刷写');
  const queryMs = (performance.now() - t0) / 20;
  assert.ok(queryMs < 15, `查询耗时 ${queryMs.toFixed(2)}ms`);
});

// --- 软测试：真实语料若存在则索引 ---
test('真实语料 knowledge/corpus.json 可被索引（不存在则跳过）', t => {
  const corpusPath = new URL('../knowledge/corpus.json', import.meta.url);
  if (!existsSync(corpusPath)) {
    t.skip('knowledge/corpus.json 尚未生成（由 corpus 角色并行产出）');
    return;
  }
  const real = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const realIndex = createKnowledgeIndex(real);
  assert.ok(realIndex.size > 0);
  assert.ok(realIndex.documents > 0);
  assert.ok(realIndex.categories.length > 0);
  const hits = realIndex.search('启动');
  assert.ok(Array.isArray(hits));
  for (const hit of hits) {
    for (const [start, end] of hit.highlights) {
      assert.ok(start >= 0 && end <= hit.text.length && start < end);
    }
  }
});
