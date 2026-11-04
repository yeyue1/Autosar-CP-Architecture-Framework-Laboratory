// 文章解析与渲染（阅读器契约 §2/§3/§5）。
//
// 输入是 `knowledge/*.md` 的新格式：
//   # 文档标题
//   <!-- doc: id -->
//   <!-- tags: a, b -->
//   <!-- summary: ... -->
//   <!-- refs: ... -->
//   导语段落
//   ## 小节标题
//   <!-- keywords: ... -->
//   正文段落
//
// 输出是可直接渲染的文章模型；`section.plain` 必须与 corpus.json 里同一 chunk 的
// `text` 完全一致，因此 `toPlainText` 是 A1（构建语料）与 A2（渲染）共享的唯一实现。
//
// 约定（与契约一致的取舍，已在测试中固化）：
//   - 小节锚点按契约 §3「同一文档内、按小节顺序」去重，因此 A1 也应按这个范围去重。
//   - 标题/导语里的行内标记在模型里只保留纯文本（目录与 corpus heading 用纯文本更稳）。
//   - 渲染时小节的 `<h2>` 包在 `<section class="rag-section" id="<anchor>">` 里，
//     阅读器定位与高亮都以这个小节容器为单位。

import {
  escapeHtml,
  isFenceClose,
  matchHeading,
  normalizeSource,
  readFenceOpen,
  renderMarkdown,
  slugify,
  stripHtmlComments,
  stripInlineMarkers,
} from './markdown.mjs';

const DOCUMENT_KEYS = /^(doc|id|title|tags|summary|refs|keywords)\s*:\s*([\s\S]*)$/i;

/** 标题展示文本：去行内标记、压缩空白。 */
const plainHeading = raw => stripInlineMarkers(raw).replace(/\s+/g, ' ').trim();

/** 逗号/顿号/分号分隔的列表字段。 */
function splitList(value) {
  return String(value ?? '')
    .split(/[,，、;；]/)
    .map(item => item.trim())
    .filter(Boolean);
}

/** 单行字段：压缩空白。 */
const collapse = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** 去掉首尾空行，保留内部空行（段落分隔靠它）。 */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !String(lines[start]).trim()) start += 1;
  while (end > start && !String(lines[end - 1]).trim()) end -= 1;
  return lines.slice(start, end);
}

/** 同一文档内小节锚点的去重计数器（契约 §3：第 2 个 -2，第 3 个 -3 ……）。 */
function createAnchorAllocator() {
  const counts = new Map();
  return base => {
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };
}

/**
 * 读取一条独占一行的 HTML 注释（支持跨行）。
 * @returns {{ body: string, next: number } | null} 不是注释行时返回 null
 */
function readComment(lines, start) {
  if (!lines[start].trim().startsWith('<!--')) return null;
  const pieces = [];
  let index = start;
  let rest = lines[start].slice(lines[start].indexOf('<!--') + 4);
  for (;;) {
    const end = rest.indexOf('-->');
    if (end !== -1) {
      pieces.push(rest.slice(0, end));
      return { body: pieces.join('\n'), next: index + 1 };
    }
    pieces.push(rest);
    index += 1;
    if (index >= lines.length) return { body: pieces.join('\n'), next: index };
    rest = lines[index];
  }
}

const isThematicLine = line => /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line);

/**
 * 生成纯文本版本（契约 §5）：A1 用它产出 corpus 的 chunk.text，A2 用它做对齐校验。
 * 规则：去 HTML 注释、去行内标记（`、**、*，链接只留文字）、标题去 `#`、
 * 列表/引用去标记、段落之间用单个换行连接、压缩连续空白并 trim。
 * 标题行与列表项在 Markdown 里是块级单位，各自成段（列表不会被粘成一行）。
 * @param {string} markdown
 * @returns {string}
 */
export function toPlainText(markdown) {
  const lines = stripHtmlComments(markdown).split('\n');
  const blocks = [];
  let buffer = [];
  let fence = null;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join('\n').replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = String(rawLine).replace(/\s+$/, '');

    if (fence) {
      if (isFenceClose(line, fence)) { fence = null; continue; }
      buffer.push(line);
      continue;
    }

    const opened = readFenceOpen(line);
    if (opened) { fence = opened; continue; }

    if (!line.trim()) { flush(); continue; }
    if (isThematicLine(line)) continue;

    // 标题行与列表项在 Markdown 里是块级单位，各自成段；其余行按空行分组成段落。
    const isBlockLine = /^ {0,3}#{1,6}[ \t]+/.test(line)
      || /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line);

    let text = line;
    text = text.replace(/^ {0,3}#{1,6}[ \t]+/, '');        // 标题去掉 #
    text = text.replace(/^ {0,3}>[ \t]?/, '');             // 引用去掉 >
    text = text.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/, ''); // 列表去掉标记
    text = stripInlineMarkers(text);
    if (!text.trim()) continue;

    if (isBlockLine) {
      flush();
      buffer.push(text);
      flush();
      continue;
    }
    buffer.push(text);
  }

  flush();
  return blocks.join('\n');
}

/**
 * 把一篇 .md 原文解析成可直接渲染的文章模型（契约 §5）。
 * @param {string} source Markdown 原文
 * @param {{ path?: string, title?: string }} [meta]
 * @returns {{ path: string, documents: Array<object> }}
 */
export function parseArticle(source, meta = {}) {
  const documents = [];
  const lines = normalizeSource(source).split('\n');

  let draft = null;
  let section = null;
  let fence = null;
  let leading = [];

  const pushLine = line => {
    if (section) section.bodyLines.push(line);
    else if (draft) draft.introLines.push(line);
    else leading.push(line);
  };

  const openDocument = rawTitle => {
    draft = {
      id: '',
      title: plainHeading(rawTitle),
      tags: [],
      summary: '',
      refs: [],
      introLines: leading, // 首个 # 之前的内容并入第一篇文档的导语，避免丢字
      sections: [],
      allocate: createAnchorAllocator(),
    };
    leading = [];
    section = null;
    documents.push(draft);
  };

  const openSection = rawHeading => {
    const heading = plainHeading(rawHeading);
    section = {
      anchor: draft.allocate(slugify(heading)),
      heading,
      level: 2,
      keywords: [],
      bodyLines: [],
    };
    draft.sections.push(section);
  };

  const applyMetadata = body => {
    const match = DOCUMENT_KEYS.exec(body.trim());
    if (!match) return; // 普通注释，直接剔除
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'keywords') {
      if (section) section.keywords = splitList(value);
      return;
    }
    if (!draft) return;
    if (key === 'doc' || key === 'id') draft.id = collapse(value);
    else if (key === 'tags') draft.tags = splitList(value);
    else if (key === 'refs') draft.refs = splitList(value);
    else if (key === 'summary') draft.summary = collapse(value);
    else if (key === 'title' && !draft.title) draft.title = collapse(value);
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码块内部原样保留，不解析标题/注释，也不让内容跳出行结构。
    if (fence) {
      pushLine(line);
      if (isFenceClose(line, fence)) fence = null;
      index += 1;
      continue;
    }

    const comment = readComment(lines, index);
    if (comment) {
      applyMetadata(comment.body);
      index = comment.next;
      continue;
    }

    const opened = readFenceOpen(line);
    if (opened) {
      fence = opened;
      pushLine(line);
      index += 1;
      continue;
    }

    const heading = matchHeading(line);
    if (heading && heading.level === 1) {
      openDocument(heading.text);
      index += 1;
      continue;
    }
    if (heading && heading.level === 2 && draft) {
      openSection(heading.text);
      index += 1;
      continue;
    }

    // 其余内容（含 ### 及更深的标题）留在当前容器里，交给 renderMarkdown 处理。
    pushLine(line);
    index += 1;
  }

  // 全文没有 `#` 时，退化为一篇（可能只有导语的）文档，而不是抛错或丢内容。
  if (!documents.length) {
    const body = trimBlankLines(leading);
    if (body.length) {
      documents.push({
        id: '',
        title: collapse(meta?.title),
        tags: [],
        summary: '',
        refs: [],
        introLines: body,
        sections: [],
        allocate: createAnchorAllocator(),
      });
    }
  }

  const built = documents.map((item, order) => {
    const intro = trimBlankLines(item.introLines).join('\n');
    const sections = item.sections.map(entry => {
      const markdown = trimBlankLines(entry.bodyLines).join('\n');
      return {
        anchor: entry.anchor,
        heading: entry.heading,
        level: 2,
        keywords: entry.keywords,
        markdown,
        plain: toPlainText(markdown),
      };
    });
    const id = collapse(item.id) || (item.title ? slugify(item.title) : `doc-${order + 1}`);
    return {
      id,
      title: item.title,
      tags: item.tags,
      summary: item.summary,
      refs: item.refs,
      intro,
      anchors: sections.map(entry => entry.anchor),
      sections,
    };
  });

  return {
    path: typeof meta?.path === 'string' ? meta.path : '',
    documents: built,
  };
}

/**
 * 找到包含某锚点的小节。
 * @returns {{ document: object, section: object } | null}
 */
export function findSection(article, anchor) {
  const wanted = String(anchor ?? '');
  if (!wanted) return null;
  for (const doc of article?.documents ?? []) {
    for (const section of doc.sections ?? []) {
      if (section.anchor === wanted) return { document: doc, section };
    }
  }
  return null;
}

/**
 * 只渲染一个小节的正文 HTML（不含 `##` 标题行）。
 * @param {object} section
 * @param {{ anchorPrefix?: string }} [options]
 * @returns {string}
 */
export function renderSection(section, options = {}) {
  if (!section || typeof section.markdown !== 'string') return '';
  return renderMarkdown(section.markdown, options);
}

/**
 * 渲染整篇文章的 HTML：每篇文档的 `#` 标题、导语、以及全部小节。
 * 小节容器带 `id="<anchorPrefix><anchor>"`，与 corpus 里 chunk 的 anchor 一致，
 * 阅读器据此滚动和高亮。
 * @param {object} article
 * @param {{ anchorPrefix?: string }} [options]
 * @returns {string}
 */
export function renderArticle(article, options = {}) {
  const prefix = typeof options.anchorPrefix === 'string' ? options.anchorPrefix : '';
  const documents = article?.documents ?? [];
  if (!documents.length) return '';

  const parts = ['<article class="rag-article">'];
  const docAnchors = createAnchorAllocator();

  for (const doc of documents) {
    const docAnchor = docAnchors(slugify(doc.title || doc.id || 'document'));
    parts.push(`<section class="rag-doc" data-doc-id="${escapeHtml(doc.id)}">`);
    parts.push(`<h1 id="${escapeHtml(prefix + docAnchor)}">${escapeHtml(doc.title)}</h1>`);

    if (doc.intro.trim()) {
      parts.push(`<div class="rag-doc-intro">${renderMarkdown(doc.intro, { anchorPrefix: prefix })}</div>`);
    }

    for (const section of doc.sections) {
      const anchor = `${prefix}${section.anchor}`;
      parts.push(`<section class="rag-section" id="${escapeHtml(anchor)}" data-anchor="${escapeHtml(section.anchor)}">`);
      parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
      const body = renderSection(section, options);
      if (body) parts.push(body);
      parts.push('</section>');
    }

    parts.push('</section>');
  }

  parts.push('</article>');
  return parts.join('\n');
}
