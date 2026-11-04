// 零依赖分词器：中文 bigram + 拉丁词/驼峰/下划线拆分。
// 纯浏览器 ES module，不引用 document / window / fetch。

const FULLWIDTH = /[\uff01-\uff5e]/g;
const IDEOGRAPHIC_SPACE = /\u3000/g;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM = /[A-Za-z0-9_]/;

const halfWidth = ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0);

/** 归一化：全角转半角、小写、压缩空白。 */
export function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(FULLWIDTH, halfWidth)
    .replace(IDEOGRAPHIC_SPACE, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 驼峰拆分：在小写/数字 → 大写，或连续大写 → 大写+小写的边界切开。
function splitCamel(word) {
  const parts = [];
  let current = '';
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    const prev = word[i - 1];
    const next = word[i + 1] || '';
    const boundary = i > 0 && /[A-Z]/.test(ch)
      && (/[a-z0-9]/.test(prev) || (/[A-Z]/.test(prev) && /[a-z]/.test(next)));
    if (boundary && current) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  // 单字母碎片合并回前一段（EcuM → ecum，而不是 ecu + m）
  const merged = [];
  for (const part of parts) {
    if (part.length === 1 && merged.length) merged[merged.length - 1] += part;
    else merged.push(part);
  }
  return merged;
}

// 拉丁段：整词 + 下划线/驼峰子词，全部小写。
function tokenizeLatin(segment) {
  const out = [segment.toLowerCase()];
  for (const part of segment.split('_')) {
    if (!part) continue;
    for (const sub of splitCamel(part)) {
      const token = sub.toLowerCase();
      if (token && token !== segment.toLowerCase()) out.push(token);
    }
  }
  return out;
}

// 中文段：单字 + 相邻二元组。
function tokenizeCjk(segment) {
  const out = [];
  for (const ch of segment) out.push(ch);
  for (let i = 0; i < segment.length - 1; i += 1) out.push(segment.slice(i, i + 2));
  return out;
}

/**
 * 分词。
 *  - 拉丁字母/数字连续段 → 小写整词，并额外拆出下划线/驼峰子词
 *  - CJK 连续段 → 单字 + 相邻二元组
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string') return [];
  const source = String(text).replace(FULLWIDTH, halfWidth).replace(IDEOGRAPHIC_SPACE, ' ');
  const tokens = [];
  let buffer = '';
  let kind = null; // 'cjk' | 'latin'
  const flush = () => {
    if (!buffer) return;
    if (kind === 'cjk') tokens.push(...tokenizeCjk(buffer));
    else tokens.push(...tokenizeLatin(buffer));
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
  return tokens;
}
