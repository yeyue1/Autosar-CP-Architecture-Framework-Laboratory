// BM25 检索索引：字段加权 + 同义词扩展 + 原文高亮偏移。
// 纯浏览器 ES module，不引用 document / window / fetch。

import { normalize, tokenize } from './tokenize.mjs';
import { expandToken, termOf } from './synonyms.mjs';

const DEFAULTS = {
  k1: 1.4,
  b: 0.72,
  boostHeading: 3,
  boostKeywords: 2.5,
  boostTags: 2,
  boostTitle: 2.5,
};

const EXPANSION_WEIGHT = 0.55;
const MAX_HIGHLIGHTS = 8;
const MAX_MATCHED = 12;
const MAX_QUERY_LENGTH = 1000;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM = /[A-Za-z0-9_]/;

const asArray = value => (Array.isArray(value) ? value : []);
const asText = value => (typeof value === 'string' ? value : '');

// 收集查询里用于高亮的「搜索面」：英文整词/子词（≥2）与中文整段/二元组。
function highlightNeedles(query) {
  const source = normalize(query);
  const needles = new Set();
  let buffer = '';
  let kind = null;
  const flush = () => {
    if (!buffer) return;
    if (kind === 'cjk') {
      if (buffer.length >= 2) {
        needles.add(buffer);
        for (let i = 0; i < buffer.length - 1; i += 1) needles.add(buffer.slice(i, i + 2));
      }
    } else {
      for (const token of tokenize(buffer)) {
        if (token.length >= 2) needles.add(token);
      }
    }
    buffer = '';
    kind = null;
  };
  for (const ch of source) {
    if (CJK.test(ch)) {
      if (kind !== 'cjk') flush();
      kind = 'cjk';
      buffer += ch;
    } else if (ALNUM.test(ch)) {
      if (kind !== 'latin') flush();
      kind = 'latin';
      buffer += ch;
    } else {
      flush();
    }
  }
  flush();
  return [...needles];
}

function buildHighlights(text, needles) {
  if (!needles.length || typeof text !== 'string' || !text) return [];
  const haystack = text.toLowerCase();
  const spans = [];
  for (const needle of needles) {
    const target = needle.toLowerCase();
    if (!target) continue;
    let from = 0;
    while (from <= haystack.length - target.length) {
      const at = haystack.indexOf(target, from);
      if (at < 0) break;
      spans.push([at, at + target.length]);
      from = at + 1;
    }
  }
  spans.sort((a, b) => (a[0] - b[0]) || (b[1] - b[0]) - (a[1] - a[0]));
  const picked = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    if (end > text.length) continue;
    picked.push([start, end]);
    cursor = end;
    if (picked.length >= MAX_HIGHLIGHTS) break;
  }
  return picked;
}

function createEmptyIndex() {
  return {
    size: 0,
    documents: 0,
    categories: [],
    search: () => [],
    suggest: () => [],
    get: () => null,
    related: () => [],
  };
}

/**
 * @param {object} corpus 语料库对象（见契约第 2 节）
 * @param {object} options { k1, b, boostHeading, boostKeywords, boostTags, boostTitle }
 */
export function createKnowledgeIndex(corpus, options = {}) {
  if (!corpus || typeof corpus !== 'object') return createEmptyIndex();
  const config = { ...DEFAULTS, ...(options || {}) };

  // 展平 chunk，并保留文档级元信息。
  const records = [];
  const byId = new Map();
  for (const doc of asArray(corpus.documents)) {
    if (!doc || typeof doc !== 'object') continue;
    const title = asText(doc.title);
    const category = asText(doc.category) || 'general';
    const tags = asArray(doc.tags).map(asText).filter(Boolean);
    const sourcePath = asText(doc.source && doc.source.path);
    for (const chunk of asArray(doc.chunks)) {
      if (!chunk || typeof chunk !== 'object') continue;
      const chunkId = asText(chunk.id);
      if (!chunkId || byId.has(chunkId)) continue;
      const record = {
        chunkId,
        docId: asText(doc.id),
        docTitle: title,
        heading: asText(chunk.heading),
        // anchor 指向原文 .md 里该小节的标题锚点，供阅读器精确跳转；
        // 语料由 scripts/build-corpus.mjs 生成，缺字段时留空由调用方兜底。
        anchor: asText(chunk.anchor ?? chunk.anchorId),
        text: asText(chunk.text),
        category,
        tags,
        sourcePath,
        keywords: asArray(chunk.keywords).map(asText).filter(Boolean),
        weightedTf: new Map(),
        length: 0,
      };
      indexFields(record, config);
      records.push(record);
      byId.set(chunkId, record);
    }
  }
  if (!records.length) return createEmptyIndex();

  // 文档频次（DF）与平均加权长度。
  const df = new Map();
  let totalLength = 0;
  for (const record of records) {
    totalLength += record.length;
    for (const term of record.weightedTf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = records.length;
  const avgdl = totalLength / N || 1;

  // 词表（供 suggest）：term → 出现次数。
  const vocabulary = new Map();
  for (const [term, count] of df) {
    if (term.length >= 2) vocabulary.set(term, count);
  }

  // 分类统计。
  const categories = buildCategories(corpus, records);

  function idf(term, d) {
    return Math.log(1 + (N - d + 0.5) / (d + 0.5));
  }

  function makeHit(record, score, matched, highlights) {
    return {
      chunkId: record.chunkId,
      docId: record.docId,
      docTitle: record.docTitle,
      heading: record.heading,
      anchor: record.anchor,
      text: record.text,
      category: record.category,
      tags: record.tags.slice(),
      sourcePath: record.sourcePath,
      score,
      matched: matched.slice(),
      highlights: highlights.map(span => span.slice()),
    };
  }

  function search(query, opts = {}) {
    if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) return [];
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    // 查询词权重：原词 1，扩展词 0.55；原词优先。
    const weights = new Map();
    const ordered = [];
    for (const token of tokens) {
      if (!token) continue;
      if (!weights.has(token)) {
        weights.set(token, 1);
        ordered.push(token);
      }
    }
    for (const token of [...ordered]) {
      for (const expansion of expandToken(token)) {
        if (!weights.has(expansion)) {
          weights.set(expansion, EXPANSION_WEIGHT);
          ordered.push(expansion);
        }
      }
    }

    const limitInput = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 8;
    const limit = Math.max(0, Math.min(50, limitInput));
    if (limit === 0) return [];
    const category = typeof opts.category === 'string' && opts.category ? opts.category : null;
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0;
    const needles = highlightNeedles(query);

    const scored = [];
    for (const record of records) {
      if (category && record.category !== category) continue;
      let score = 0;
      const matched = [];
      for (const [term, weight] of weights) {
        const tf = record.weightedTf.get(term);
        if (!tf) continue;
        const d = df.get(term) || 0;
        const denom = tf + config.k1 * (1 - config.b + config.b * (record.length / avgdl));
        score += weight * idf(term, d) * (tf * (config.k1 + 1)) / denom;
        if (matched.length < MAX_MATCHED) matched.push(term);
      }
      if (score <= 0 || score < minScore) continue;
      scored.push({ record, score, matched });
    }

    scored.sort((a, b) => (b.score - a.score) || (a.record.chunkId < b.record.chunkId ? -1 : 1));
    return scored.slice(0, limit).map(({ record, score, matched }) =>
      makeHit(record, score, matched, buildHighlights(record.text, needles)));
  }

  function suggest(query, opts = {}) {
    if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) return [];
    const tokens = tokenize(query).filter(Boolean);
    if (!tokens.length) return [];
    const limitInput = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 5;
    const limit = Math.max(0, Math.min(20, limitInput));
    if (limit === 0) return [];
    const prefix = tokens[tokens.length - 1];
    const results = [];
    const seen = new Set();
    const push = value => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      results.push(value);
    };
    // 1) 词表前缀匹配。
    const prefixed = [...vocabulary.keys()]
      .filter(term => term !== prefix && term.startsWith(prefix))
      .sort((a, b) => (vocabulary.get(b) - vocabulary.get(a)) || (a.length - b.length) || a.localeCompare(b));
    for (const term of prefixed) {
      push(term);
      if (results.length >= limit) break;
    }
    // 2) 同义扩展补齐。
    for (const expansion of expandToken(prefix)) {
      push(expansion);
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  function get(chunkId) {
    const record = byId.get(chunkId);
    if (!record) return null;
    return makeHit(record, 0, [], []);
  }

  function related(chunkId, opts = {}) {
    const record = byId.get(chunkId);
    if (!record) return [];
    const limitInput = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 5;
    const limit = Math.max(0, Math.min(50, limitInput));
    if (limit === 0) return [];
    const tagSet = new Set(record.tags);
    const scored = [];
    for (const other of records) {
      if (other.chunkId === record.chunkId) continue;
      let score = 0;
      if (other.docId && other.docId === record.docId) score += 5;
      for (const tag of other.tags) if (tagSet.has(tag)) score += 1;
      if (other.category === record.category) score += 0.5;
      if (score <= 0) continue;
      scored.push({ other, score });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.other.chunkId < b.other.chunkId ? -1 : 1));
    return scored.slice(0, limit).map(({ other, score }) =>
      makeHit(other, score, [], []));
  }

  return {
    size: records.length,
    documents: asArray(corpus.documents).filter(doc => doc && typeof doc === 'object').length,
    categories,
    search,
    suggest,
    get,
    related,
  };
}

function indexFields(record, config) {
  const addField = (text, boost) => {
    const tokens = tokenize(text);
    if (!tokens.length) return;
    record.length += tokens.length * boost;
    for (const token of tokens) {
      record.weightedTf.set(token, (record.weightedTf.get(token) || 0) + boost);
    }
  };
  addField(record.heading, config.boostHeading);
  addField(record.keywords.join(' '), config.boostKeywords);
  addField(record.tags.join(' '), config.boostTags);
  addField(record.docTitle, config.boostTitle);
  addField(record.text, 1);
}

function buildCategories(corpus, records) {
  // count 按文档数统计（每个分类至少 2 个 document）。
  const counts = new Map();
  for (const doc of asArray(corpus.documents)) {
    if (!doc || typeof doc !== 'object') continue;
    const category = asText(doc.category) || 'general';
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const declared = asArray(corpus.categories)
    .filter(item => item && typeof item === 'object' && asText(item.id))
    .map(item => ({
      id: asText(item.id),
      label: asText(item.label) || asText(item.id),
      order: Number.isFinite(item.order) ? item.order : 0,
      count: counts.get(asText(item.id)) || 0,
    }));
  const known = new Set(declared.map(item => item.id));
  for (const [id, count] of counts) {
    if (!known.has(id)) declared.push({ id, label: id, order: 999, count });
  }
  return declared.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

export { termOf };
