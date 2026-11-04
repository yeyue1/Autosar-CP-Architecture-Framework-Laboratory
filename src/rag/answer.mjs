// 抽取式答案合成：只从命中片段里挑句子，绝不生成原文没有的事实。

import { normalize, tokenize } from './tokenize.mjs';
import { termOf } from './synonyms.mjs';

const BOUNDARY_NOTE = '本知识库为教学仿真内容，边界声明：不生成 ARXML、不执行真实烧录，仅用于理解概念与流程。';

// 按 。！？；\n 与英文 ". " 切句，保留标点，丢弃长度 < 12 的碎片。
function splitSentences(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  let buffer = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    buffer += ch;
    const isCnEnd = ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '\n';
    const isEnEnd = ch === '.' && /\s/.test(text[i + 1] || '');
    if (isCnEnd || isEnEnd) {
      const sentence = buffer.trim();
      buffer = '';
      if (sentence.length >= 12) out.push(sentence);
    }
  }
  const tail = buffer.trim();
  if (tail.length >= 12) out.push(tail);
  return out;
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function similarity(a, b) {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (!sa.size || !sb.size) return a === b ? 1 : 0;
  let intersect = 0;
  for (const token of sa) if (sb.has(token)) intersect += 1;
  const union = sa.size + sb.size - intersect;
  return union ? intersect / union : 0;
}

function relatedTermsFrom(hits) {
  const seen = new Set();
  const terms = [];
  for (const hit of hits) {
    for (const token of Array.isArray(hit.matched) ? hit.matched : []) {
      const label = termOf(token) || token;
      if (label && label.length > 1 && !seen.has(label)) {
        seen.add(label);
        terms.push(label);
      }
      if (terms.length >= 6) return terms;
    }
  }
  return terms;
}

function buildFollowUps(query) {
  const topic = query.trim() || '这个主题';
  return [
    `「${topic}」在 AUTOSAR 中的具体流程是怎样的？`,
    `如何排查与「${topic}」相关的常见故障？`,
    `围绕「${topic}」有哪些容易混淆的概念？`,
  ];
}

/**
 * @param {string} query
 * @param {Array} hits createKnowledgeIndex().search() 的返回值
 * @param {{ maxSentences?: number }} [opts]
 */
export function composeAnswer(query, hits, opts = {}) {
  const safeQuery = typeof query === 'string' ? query : '';
  const safeHits = Array.isArray(hits) ? hits.filter(hit => hit && typeof hit === 'object') : [];
  const maxSentences = Number.isFinite(opts.maxSentences)
    ? Math.max(0, Math.floor(opts.maxSentences))
    : 6;

  const queryNorm = normalize(safeQuery);
  const queryTokens = new Set(tokenize(queryNorm));

  if (!safeHits.length || !queryTokens.size || maxSentences === 0) {
    return {
      query: safeQuery,
      coverage: 'none',
      sentences: [],
      citations: [],
      relatedTerms: [],
      followUps: buildFollowUps(safeQuery),
    };
  }

  const candidates = [];
  safeHits.forEach((hit, hitIndex) => {
    const sentences = splitSentences(hit.text);
    sentences.forEach((text, sentenceIndex) => {
      const tokens = tokenSet(text);
      let overlap = 0;
      for (const token of queryTokens) if (tokens.has(token)) overlap += 1;
      if (overlap === 0) return;
      const coverage = overlap / queryTokens.size;
      const score = (Number(hit.score) || 0) * coverage;
      if (score <= 0) return;
      candidates.push({
        text,
        chunkId: hit.chunkId,
        docTitle: hit.docTitle,
        heading: hit.heading,
        score,
        hitIndex,
        sentenceIndex,
      });
    });
  });

  candidates.sort((a, b) =>
    (b.score - a.score)
    || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)
    || (a.sentenceIndex - b.sentenceIndex));

  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.some(existing => similarity(existing.text, candidate.text) > 0.8)) continue;
    chosen.push(candidate);
    if (chosen.length >= maxSentences) break;
  }

  const sentences = chosen.map(({ text, chunkId, docTitle, heading, score }) =>
    ({ text, chunkId, docTitle, heading, score }));

  const sourceByChunk = new Map();
  const anchorByChunk = new Map();
  for (const hit of safeHits) {
    if (!sourceByChunk.has(hit.chunkId)) sourceByChunk.set(hit.chunkId, hit.sourcePath);
    // 引用要能跳回原文的对应小节，因此把 anchor 一并带出去。
    if (!anchorByChunk.has(hit.chunkId)) anchorByChunk.set(hit.chunkId, hit.anchor || '');
  }
  const citationIndex = new Map();
  const citations = [];
  for (const sentence of sentences) {
    if (citationIndex.has(sentence.chunkId)) continue;
    citationIndex.set(sentence.chunkId, citations.length + 1);
    citations.push({
      index: citations.length + 1,
      chunkId: sentence.chunkId,
      docTitle: sentence.docTitle,
      heading: sentence.heading,
      sourcePath: sourceByChunk.get(sentence.chunkId) || '',
      anchor: anchorByChunk.get(sentence.chunkId) || '',
    });
  }

  const topScore = Number(safeHits[0].score) || 0;
  const coverage = topScore < 1 ? 'low' : topScore < 3 ? 'medium' : 'high';

  const needsBoundary = safeHits.some(hit =>
    hit.category === 'boundary'
    || /非量产|边界|不生成|不执行烧录/.test(`${hit.text || ''}${hit.docTitle || ''}`));

  const answer = {
    query: safeQuery,
    coverage,
    sentences,
    citations,
    relatedTerms: relatedTermsFrom(safeHits),
    followUps: buildFollowUps(safeQuery),
  };
  if (needsBoundary) answer.boundary = BOUNDARY_NOTE;
  return answer;
}
