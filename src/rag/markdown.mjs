// 零第三方依赖的 Markdown → 安全 HTML 渲染器（阅读器契约 §3/§4）。
//
// 安全策略（本项目的第一优先级）：
//   1. 所有外来文本先经 escapeHtml 转义再拼进标签；整个过程没有"先拼 HTML、再用正则修补"
//      的环节，因此不可能被"已转义文本被二次解析"绕过。
//   2. 链接 href 先做协议白名单（相对路径 / #片段 / http / https / mailto），
//      javascript:、data:、vbscript: 等一律退化成纯文本，连 <a> 都不产生。
//   3. 围栏代码块与行内代码的内容同样整体转义。
//   4. 不使用 eval / new Function / innerHTML，也不引用 document、window、fetch，
//      因此可被浏览器直接 `import`，也可在 Node 里进程内测试。
//
// 结构：先扫描成 block token（同时完成标题锚点去重），再把 token 渲染成 HTML。
// `extractHeadings` 复用同一个 tokenizer，所以它给出的 anchor 必然等于渲染出的 id。

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 转义 HTML 文本与属性值里的 5 个危险字符。 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPE_MAP[char]);
}

/** 统一换行与 BOM，保证同样的输入在任何平台产出同样的 HTML。 */
export function normalizeSource(source) {
  return String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// ---- 行级语法 ------------------------------------------------------------

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const THEMATIC_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** 识别标题行；返回 `{ level, text }`（text 已去掉结尾的 `#` 闭合序列）。 */
export function matchHeading(line) {
  const match = HEADING_RE.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].replace(/[ \t]+#+$/, '') };
}

/** 解析围栏代码块的开始行；不是围栏则返回 null。 */
export function readFenceOpen(line) {
  const match = FENCE_OPEN_RE.exec(line);
  if (!match) return null;
  const marker = match[1];
  const info = match[2] ?? '';
  // ```lang` 这种信息串里带反引号的，按正文处理，避免误判。
  if (marker[0] === '`' && info.includes('`')) return null;
  return { char: marker[0], size: marker.length, info: info.trim() };
}

/** 该行是否闭合给定的围栏（闭合围栏必须同字符且不短于开启围栏）。 */
export function isFenceClose(line, fence) {
  const match = FENCE_CLOSE_RE.exec(line);
  if (!match) return false;
  return match[1][0] === fence.char && match[1].length >= fence.size;
}

const startsBlock = line => FENCE_OPEN_RE.test(line) || HEADING_RE.test(line)
  || THEMATIC_RE.test(line) || UL_RE.test(line) || OL_RE.test(line) || QUOTE_RE.test(line);

// ---- HTML 注释剔除 -------------------------------------------------------

/**
 * 剔除 `<!-- ... -->`（支持跨行），但**保留围栏代码块内部**的注释文本——
 * 代码块里出现的注释是示例内容，不应被渲染器改写。
 */
export function stripHtmlComments(source) {
  const lines = normalizeSource(source).split('\n');
  const out = [];
  let fence = null;
  let inComment = false;

  for (const line of lines) {
    if (fence) {
      out.push(line);
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const opened = readFenceOpen(line);
    if (opened && !inComment) {
      fence = opened;
      out.push(line);
      continue;
    }

    let rest = line;
    let kept = '';
    while (rest) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) {
          rest = '';
        } else {
          rest = rest.slice(end + 3);
          inComment = false;
        }
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) {
          kept += rest;
          rest = '';
        } else {
          kept += rest.slice(0, start);
          rest = rest.slice(start + 4);
          inComment = true;
        }
      }
    }
    out.push(kept);
  }
  return out.join('\n');
}

// ---- 行内标记（纯文本化） -----------------------------------------------

/**
 * 去掉行内 Markdown 标记，留下人能读的纯文本。
 *
 * 与 `renderInline` 共用同一个行内解析器（`parseInline`），只是最后走"取纯文本"的
 * 那条渲染路径。这一点很重要：过去这里用「星号 + 中间任意字符 + 星号」的成对正则，
 * 会把 `P2* 与 P3* 的区别` 里的两个星号当成斜体一起剥掉——`P2*` 是 UDS 的有效
 * 参数名，剥掉就是事实性错误。现在强调的判定与 HTML 路径完全一致，不会再分叉。
 */
export function stripInlineMarkers(text) {
  return plainNodes(parseInline(String(text ?? '')));
}

// ---- 标题锚点（契约 §3） -------------------------------------------------

/** 由标题生成稳定锚点。规则逐字符照抄契约 §3，A1 生成 corpus 时用同一实现。 */
export function slugify(heading) {
  return String(heading)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    || 'section';
}

/** 同一文档内的重复标题依次加 -2、-3 …… */
function createAnchorAllocator() {
  const counts = new Map();
  return base => {
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };
}

/** 标题去掉标记后的展示文本（锚点与目录都用它）。 */
function headingText(raw) {
  return stripInlineMarkers(raw).replace(/\s+/g, ' ').trim();
}

// ---- 行内渲染 -----------------------------------------------------------

const MAX_INLINE_DEPTH = 4;

/** 链接地址白名单：相对路径、片段、http(s)、mailto；其余一律视为不安全。 */
function isSafeUrl(raw) {
  const value = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!value) return false;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!scheme) return true;
  return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase());
}

/** 去空白、去 `title`，得到可安全放进 href 的地址。 */
function cleanUrl(raw) {
  const value = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(value);
  return titled ? titled[1] : value;
}

/** 读 `[文字](链接)`；不完整时返回 null，交给调用方按普通文本处理。 */
function readInlineLink(input, start) {
  let depth = 0;
  let close = -1;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close <= start + 1 || input[close + 1] !== '(') return null;

  let paren = 1;
  let i = close + 2;
  for (; i < input.length; i += 1) {
    const char = input[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '(') paren += 1;
    else if (char === ')') {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  if (i >= input.length) return null;
  return { text: input.slice(start + 1, close), target: input.slice(close + 2, i), end: i + 1 };
}

const isSpace = char => char === undefined || /\s/.test(char);
const isAsciiAlnum = char => char !== undefined && /[A-Za-z0-9]/.test(char);
const isPunctuation = char => char !== undefined && /[\p{P}\p{S}]/u.test(char);

/** 读行内代码 `` `x` ``；未闭合返回 null。 */
function readCodeSpan(input, start) {
  const end = input.indexOf('`', start + 1);
  if (end === -1) return null;
  return { value: input.slice(start + 1, end), end: end + 1 };
}

/**
 * 从 from 起找配对关闭的 `*` 串，找不到返回 null。
 * @param {number} size 需要的星号个数（1 = 斜体，2 = 加粗）
 * @param {boolean} strictTail 闭合标记之后不允许紧跟 ASCII 字母数字
 *   （保护 `P2*` / `P3*` 这类参数名，见 parseInline 里的说明）
 */
function findDelimiterClose(input, from, size, strictTail) {
  let i = from;
  while (i < input.length) {
    const char = input[i];
    if (char === '`') {
      const span = readCodeSpan(input, i);
      i = span ? span.end : i + 1;
      continue;
    }
    if (char === '*') {
      let run = 1;
      while (input[i + run] === '*') run += 1;
      const prev = input[i - 1];
      const next = input[i + run];
      // 规则 2：闭合标记的前一个字符不能是空白，也不能是行首。
      const canClose = run >= size && !isSpace(prev)
        && (!strictTail || next === undefined || isSpace(next) || isPunctuation(next));
      if (canClose) return { start: i };
      i += run;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * 把行内文本解析成节点数组。`renderInline` 与 `stripInlineMarkers` 共用这一份
 * 解析结果，只是渲染成 HTML 还是取纯文本不同——两条路径因此不会对同一段文本
 * 给出不一致的判断。
 *
 * 强调的开启/闭合按 CommonMark 的 flanking 规则近似，只保留与中文技术文本相容的
 * 部分：
 *   - 规则 1：`*` 后面是空白或行尾 → 不是开启标记；
 *   - 规则 2：`*` 前面是空白或行首 → 不是闭合标记。
 * 于是 `P2* 与 P3*` 里的星号是参数名的一部分，不会被当成斜体吃掉。
 * 额外一层保护：开启的 `*` 紧跟在 ASCII 字母/数字之后时（`P2*`、`S3*` 这种写法），
 * 要求闭合的 `*` 之后不能紧跟单词字符，避免 `P2*与 P3*` 这种没有空格的写法被误判。
 */
function parseInline(input, depth = 0) {
  const nodes = [];
  let text = '';
  const flush = () => {
    if (!text) return;
    nodes.push({ type: 'text', value: text });
    text = '';
  };

  let i = 0;
  while (i < input.length) {
    const char = input[i];

    if (char === '`') {
      const span = readCodeSpan(input, i);
      if (span) {
        flush();
        nodes.push({ type: 'code', value: span.value });
        i = span.end;
        continue;
      }
      text += char;
      i += 1;
      continue;
    }

    // 图片不渲染成 <img>：本项目离线、无外部资源，保留替代文字即可，也少一个注入面。
    if (char === '!' && input[i + 1] === '[' && depth < MAX_INLINE_DEPTH) {
      const parsed = readInlineLink(input, i + 1);
      if (parsed) {
        flush();
        nodes.push({ type: 'image', children: parseInline(parsed.text, depth + 1) });
        i = parsed.end;
        continue;
      }
      text += char;
      i += 1;
      continue;
    }

    if (char === '[' && depth < MAX_INLINE_DEPTH) {
      const parsed = readInlineLink(input, i);
      if (parsed) {
        flush();
        const url = cleanUrl(parsed.target);
        nodes.push({
          type: 'link',
          href: isSafeUrl(url) ? url : '', // 不安全协议：没有 href，只剩文字
          children: parseInline(parsed.text, depth + 1),
        });
        i = parsed.end;
        continue;
      }
      text += char;
      i += 1;
      continue;
    }

    if (char === '*' && depth < MAX_INLINE_DEPTH) {
      let run = 1;
      while (input[i + run] === '*') run += 1;
      const size = run >= 2 ? 2 : 1;
      // 规则 1：开启标记后面不能是空白或行尾。
      if (!isSpace(input[i + size])) {
        const close = findDelimiterClose(input, i + size, size, isAsciiAlnum(input[i - 1]));
        if (close) {
          flush();
          nodes.push({
            type: size === 2 ? 'strong' : 'em',
            children: parseInline(input.slice(i + size, close.start), depth + 1),
          });
          i = close.start + size;
          continue;
        }
      }
      text += input.slice(i, i + run);
      i += run;
      continue;
    }

    text += char;
    i += 1;
  }

  flush();
  return nodes;
}

/** 把行内节点渲染成安全 HTML。 */
function renderNodes(nodes) {
  let html = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        html += escapeHtml(node.value);
        break;
      case 'code':
        html += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case 'strong':
        html += `<strong>${renderNodes(node.children)}</strong>`;
        break;
      case 'em':
        html += `<em>${renderNodes(node.children)}</em>`;
        break;
      case 'link':
        html += node.href
          ? `<a href="${escapeHtml(node.href)}" rel="noreferrer">${renderNodes(node.children)}</a>`
          : renderNodes(node.children);
        break;
      case 'image':
        html += renderNodes(node.children);
        break;
      default:
        break;
    }
  }
  return html;
}

/** 把行内节点还原成纯文本：标记去掉，文字与代码内容原样保留。 */
function plainNodes(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'code') out += node.value;
    else if (node.children) out += plainNodes(node.children);
  }
  return out;
}

/**
 * 渲染行内标记为安全 HTML。绝不输出未经转义的原始文本。
 */
export function renderInline(text) {
  return renderNodes(parseInline(String(text ?? '')));
}

// ---- Block tokenizer ----------------------------------------------------

/** 把源码切成 block token，并在切分过程中完成标题锚点分配。 */
function tokenize(source) {
  const lines = stripHtmlComments(source).split('\n');
  const tokens = [];
  const allocateAnchor = createAnchorAllocator();

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index += 1; continue; }

    const fence = readFenceOpen(line);
    if (fence) {
      const lang = fence.info.split(/\s+/)[0] ?? '';
      const body = [];
      index += 1;
      while (index < lines.length && !isFenceClose(lines[index], fence)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过闭合围栏（未闭合时正好越界，正文按代码处理，不抛错）
      tokens.push({ type: 'code', lang, content: body.join('\n') });
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      const text = headingText(heading.text);
      tokens.push({ type: 'heading', level: heading.level, text, anchor: allocateAnchor(slugify(text)) });
      index += 1;
      continue;
    }

    if (THEMATIC_RE.test(line)) {
      tokens.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (index < lines.length && QUOTE_RE.test(lines[index])) {
        quoted.push(QUOTE_RE.exec(lines[index])[1]);
        index += 1;
      }
      tokens.push({ type: 'quote', lines: quoted });
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = !UL_RE.test(line);
      const pattern = ordered ? OL_RE : UL_RE;
      const items = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (!item) break;
        let text = ordered ? item[2] : item[1];
        index += 1;
        // 缩进续行并入当前列表项（松散列表的常见写法）。
        while (index < lines.length && /^[ \t]{2,}/.test(lines[index]) && !startsBlock(lines[index].trim())) {
          text += ` ${lines[index].trim()}`;
          index += 1;
        }
        items.push(text);
        // 项之间允许空行，但只有下一行仍是同类列表项时才继续。
        let lookahead = index;
        while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
        if (lookahead > index && lookahead < lines.length && pattern.test(lines[lookahead])) {
          index = lookahead;
          continue;
        }
        if (lookahead > index) break;
      }
      tokens.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (!paragraph.length) { index += 1; continue; } // 兜底：不认识的块首行按原文吃掉，避免死循环
    tokens.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return tokens;
}

// ---- Block 渲染 ---------------------------------------------------------

const headingTag = level => `h${Math.min(6, Math.max(1, level))}`;
const LANGUAGE_RE = /^[A-Za-z0-9_+#.-]{1,32}$/;

/** 引用块内部按空行分组，每组渲染成一个段落。 */
function renderQuote(lines) {
  const groups = [];
  let group = [];
  for (const line of lines) {
    if (line.trim()) group.push(line.trim());
    else if (group.length) { groups.push(group.join('\n')); group = []; }
  }
  if (group.length) groups.push(group.join('\n'));
  return groups.map(text => `<p>${renderInline(text)}</p>`).join('\n');
}

function renderToken(token, prefix) {
  switch (token.type) {
    case 'heading': {
      const tag = headingTag(token.level);
      return `<${tag} id="${escapeHtml(prefix + token.anchor)}">${escapeHtml(token.text)}</${tag}>`;
    }
    case 'paragraph':
      return `<p>${renderInline(token.text)}</p>`;
    case 'code': {
      const language = LANGUAGE_RE.test(token.lang) ? ` class="language-${escapeHtml(token.lang)}"` : '';
      return `<pre><code${language}>${escapeHtml(token.content)}</code></pre>`;
    }
    case 'list': {
      const tag = token.ordered ? 'ol' : 'ul';
      const items = token.items.map(item => `<li>${renderInline(item)}</li>`).join('\n');
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case 'quote':
      return `<blockquote>\n${renderQuote(token.lines)}\n</blockquote>`;
    case 'hr':
      return '<hr>';
    default:
      return '';
  }
}

/**
 * 把 Markdown 渲染成安全 HTML 字符串（契约 §4）。
 * @param {string} source Markdown 原文
 * @param {{ anchorPrefix?: string }} [options] 标题 id 前缀
 * @returns {string}
 */
export function renderMarkdown(source, options = {}) {
  const prefix = typeof options.anchorPrefix === 'string' ? options.anchorPrefix : '';
  const tokens = tokenize(source);
  if (!tokens.length) return '';
  return tokens.map(token => renderToken(token, prefix)).join('\n');
}

/**
 * 按出现顺序返回全部标题（`#` 与 `##` 都算），anchor 按契约 §3 含重复去重。
 * 与 renderMarkdown 共用 tokenizer，因此这里的 anchor 就是渲染出的 id。
 * @returns {Array<{ level: number, text: string, anchor: string }>}
 */
export function extractHeadings(source) {
  return tokenize(source)
    .filter(token => token.type === 'heading')
    .map(({ level, text, anchor }) => ({ level, text, anchor }));
}
