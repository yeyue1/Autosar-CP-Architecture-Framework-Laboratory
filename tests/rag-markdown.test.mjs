// A2 · Markdown 渲染器与文章解析模型的测试（契约 §3/§4/§5）。
//
// 本沙箱禁止 spawn + 管道 stdio（EPERM），`node --test` 会为每个测试文件起子进程
// 因而失败。这里用 `node:test` 但是**直接执行本文件**，全部测试在进程内跑完：
//   node tests\rag-markdown.test.mjs
// 同一条命令也被 scripts/run-tests.mjs（isolation: "none"）复用。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  extractHeadings,
  renderMarkdown,
  slugify,
  stripHtmlComments,
  stripInlineMarkers,
} from '../src/rag/markdown.mjs';
import {
  findSection,
  parseArticle,
  renderArticle,
  renderSection,
  toPlainText,
} from '../src/rag/article.mjs';

// ---------------------------------------------------------------------------
// slugify（契约 §3，与 A1 生成 corpus 锚点必须完全一致）
// ---------------------------------------------------------------------------

test('slugify 把英文标题转成小写连字符形式', () => {
  assert.equal(slugify('StartOS Is The Boundary'), 'startos-is-the-boundary');
  assert.equal(slugify('EcuM_Init()'), 'ecum-init');
  assert.equal(slugify('  InitZero  '), 'initzero');
});

test('slugify 保留中文并只把非字母数字折叠成连字符', () => {
  assert.equal(slugify('纯中文标题'), '纯中文标题');
  assert.equal(slugify('启动流程与 EcuM'), '启动流程与-ecum');
  assert.equal(slugify('EcuM_Init 是上电后的第一个 BSW 入口'), 'ecum-init-是上电后的第一个-bsw-入口');
});

test('slugify 对中英混合与全角字符先做 NFKC 归一', () => {
  assert.equal(slugify('ＡＢＣ 启动'), 'abc-启动');
  assert.equal(slugify('ＤＣＭ 会话'), 'dcm-会话');
  assert.equal(slugify('BswM/模式仲裁'), 'bswm-模式仲裁');
});

test('slugify 全是符号或空值时兜底为 section', () => {
  assert.equal(slugify('!!!???'), 'section');
  assert.equal(slugify('——***——'), 'section');
  assert.equal(slugify(''), 'section');
  assert.equal(slugify('   '), 'section');
  // 契约 §3 的实现是 String(heading)，因此 null/undefined 走字符串化后不再是空串；
  // 这里锁定该行为，保证 A1 照抄契约时不产生差异（调用方不会传 null）。
  assert.equal(slugify(null), 'null');
  assert.equal(slugify(undefined), 'undefined');
});

test('slugify 结果不含首尾连字符', () => {
  const anchor = slugify('  ...BswM_Init...  ');
  assert.equal(anchor, 'bswm-init');
  assert.ok(!anchor.startsWith('-') && !anchor.endsWith('-'));
});

// ---------------------------------------------------------------------------
// renderMarkdown：块级语法
// ---------------------------------------------------------------------------

test('renderMarkdown 渲染 # 到 #### 各级标题并生成 id', () => {
  const html = renderMarkdown('# 一级\n\n## 二级\n\n### 三级\n\n#### 四级');
  assert.equal(html, [
    '<h1 id="一级">一级</h1>',
    '<h2 id="二级">二级</h2>',
    '<h3 id="三级">三级</h3>',
    '<h4 id="四级">四级</h4>',
  ].join('\n'));
});

test('renderMarkdown 渲染段落并在空行处切分', () => {
  assert.equal(renderMarkdown('第一段。\n\n第二段。'), '<p>第一段。</p>\n<p>第二段。</p>');
  // 段落内的软换行并入同一个 <p>
  assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行\n第二行</p>');
});

test('renderMarkdown 渲染加粗与斜体', () => {
  assert.equal(renderMarkdown('**加粗**'), '<p><strong>加粗</strong></p>');
  assert.equal(renderMarkdown('*斜体*'), '<p><em>斜体</em></p>');
  assert.equal(renderMarkdown('前 **粗** 后'), '<p>前 <strong>粗</strong> 后</p>');
  assert.equal(renderMarkdown('**粗** 与 *斜*'), '<p><strong>粗</strong> 与 <em>斜</em></p>');
});

test('renderMarkdown 渲染行内代码且不下划线误判为斜体', () => {
  assert.equal(renderMarkdown('`EcuM_Init`'), '<p><code>EcuM_Init</code></p>');
  // 中文技术文本里大量出现下划线标识符，不能被当成斜体
  assert.equal(renderMarkdown('EcuM_Init 与 SchM_Start'), '<p>EcuM_Init 与 SchM_Start</p>');
});

test('renderMarkdown 只在成对且紧贴文字时识别斜体', () => {
  assert.equal(renderMarkdown('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
  assert.equal(renderMarkdown('未闭合 *斜体'), '<p>未闭合 *斜体</p>');
});

test('renderMarkdown 渲染带语言的围栏代码块', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.equal(html, '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>');
});

test('renderMarkdown 渲染无语言围栏代码块', () => {
  const html = renderMarkdown('```\nplain text\n```');
  assert.equal(html, '<pre><code>plain text</code></pre>');
});

test('renderMarkdown 不解析代码块内部的 Markdown 语法', () => {
  const html = renderMarkdown('```md\n# 不是标题\n\n- 不是列表\n**不是加粗**\n```');
  assert.ok(html.includes('# 不是标题'));
  assert.ok(html.includes('- 不是列表'));
  assert.ok(html.includes('**不是加粗**'));
  assert.ok(!html.includes('<h1'));
  assert.ok(!html.includes('<ul'));
  assert.ok(!html.includes('<strong'));
});

test('renderMarkdown 渲染无序列表（- 与 * 两种标记）', () => {
  assert.equal(renderMarkdown('- InitZero\n- InitOne'), '<ul>\n<li>InitZero</li>\n<li>InitOne</li>\n</ul>');
  assert.equal(renderMarkdown('* 甲\n* 乙'), '<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>');
});

test('renderMarkdown 渲染有序列表', () => {
  assert.equal(renderMarkdown('1. 第一步\n2. 第二步'), '<ol>\n<li>第一步</li>\n<li>第二步</li>\n</ol>');
  assert.equal(renderMarkdown('1) 甲\n2) 乙'), '<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>');
});

test('renderMarkdown 允许列表项之间有空行', () => {
  assert.equal(renderMarkdown('- 甲\n\n- 乙'), '<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>');
});

test('renderMarkdown 渲染引用块', () => {
  assert.equal(renderMarkdown('> 引用一句'), '<blockquote>\n<p>引用一句</p>\n</blockquote>');
  assert.equal(renderMarkdown('> 一\n>\n> 二'), '<blockquote>\n<p>一</p>\n<p>二</p>\n</blockquote>');
});

test('renderMarkdown 渲染分隔线', () => {
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown('***'), '<hr>');
  assert.equal(renderMarkdown('甲\n\n---\n\n乙'), '<p>甲</p>\n<hr>\n<p>乙</p>');
});

test('renderMarkdown 渲染链接（相对路径与 https）', () => {
  assert.equal(
    renderMarkdown('[原始文档](knowledge/01-startup.md)'),
    '<p><a href="knowledge/01-startup.md" rel="noreferrer">原始文档</a></p>',
  );
  assert.equal(
    renderMarkdown('[示例](https://example.com/a?b=1)'),
    '<p><a href="https://example.com/a?b=1" rel="noreferrer">示例</a></p>',
  );
  // 链接文字里可以带行内标记
  assert.equal(
    renderMarkdown('[**重点**](https://example.com)'),
    '<p><a href="https://example.com" rel="noreferrer"><strong>重点</strong></a></p>',
  );
});

test('renderMarkdown 剔除 HTML 注释（独占行、行内、跨行、代码块保留）', () => {
  assert.equal(renderMarkdown('<!-- doc: x -->\n\n正文'), '<p>正文</p>');
  assert.equal(renderMarkdown('前文 <!-- 注释 --> 后文'), '<p>前文  后文</p>');
  assert.equal(renderMarkdown('甲\n\n<!--\n多行\n注释\n-->\n\n乙'), '<p>甲</p>\n<p>乙</p>');
  // 代码块里的注释是示例内容，不能被剔除
  const code = renderMarkdown('```html\n<!-- 保留我 -->\n```');
  assert.ok(code.includes('&lt;!-- 保留我 --&gt;'));
});

test('renderMarkdown 支持 anchorPrefix 给标题 id 加前缀', () => {
  assert.equal(renderMarkdown('## 小节', { anchorPrefix: 'doc-' }), '<h2 id="doc-小节">小节</h2>');
  assert.equal(renderMarkdown('# 标题', { anchorPrefix: '' }), '<h1 id="标题">标题</h1>');
});

test('renderMarkdown 对不支持的语法按纯文本段落输出而不报错', () => {
  assert.equal(renderMarkdown('| 列一 | 列二 |'), '<p>| 列一 | 列二 |</p>');
  assert.equal(renderMarkdown('~~删除线~~'), '<p>~~删除线~~</p>');
});

test('renderMarkdown 在空输入与纯注释输入下返回空字符串', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('   \n\n  \n'), '');
  assert.equal(renderMarkdown('<!-- 只有注释 -->'), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('renderMarkdown 保持中文原样（不产生乱码或多余转义）', () => {
  const html = renderMarkdown('## 中文小节\n\n复位向量完成后，控制权交给 `EcuM_Init()`。');
  assert.ok(html.includes('中文小节'));
  assert.ok(html.includes('复位向量完成后'));
  assert.ok(html.includes('<code>EcuM_Init()</code>'));
  assert.ok(!html.includes('\\u'));
});

// ---------------------------------------------------------------------------
// XSS：所有外来文本必须先转义
// ---------------------------------------------------------------------------

test('XSS：段落里的 <script> 必须被转义', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.ok(!html.includes('<script'));
});

test('XSS：<img onerror> 必须被转义', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(html, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.ok(!html.includes('<img'));
});

test('XSS：属性注入 "><svg onload=1> 必须被转义', () => {
  const html = renderMarkdown('"><svg onload=1>');
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('">'));
  assert.equal(html, '<p>&quot;&gt;&lt;svg onload=1&gt;</p>');
});

test('XSS：javascript: 链接必须失效，且不产生任何 <a>', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.equal(html, '<p>点我</p>');
  assert.ok(!html.includes('<a'));
  assert.ok(!/javascript:/i.test(html));
});

test('XSS：大小写变形与 data: 协议同样失效', () => {
  for (const source of [
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox(1))',
    '[x](java\tscript:alert(1))',
  ]) {
    const html = renderMarkdown(source);
    assert.ok(!html.includes('<a'), `应拒绝 ${source}`);
    assert.ok(!/(?:javascript|data|vbscript):/i.test(html), `应拒绝 ${source}`);
  }
});

test('XSS：标题与列表里的原始标签被转义，锚点保持安全字符集', () => {
  const heading = renderMarkdown('## <script>alert(1)</script>');
  assert.ok(!heading.includes('<script'));
  assert.ok(heading.includes('&lt;script&gt;'));
  assert.equal(heading, '<h2 id="script-alert-1-script">&lt;script&gt;alert(1)&lt;/script&gt;</h2>');

  const list = renderMarkdown('- <img src=x onerror=alert(1)>');
  assert.ok(!list.includes('<img'));
  assert.ok(list.includes('&lt;img'));
});

test('XSS：代码块内容也必须转义', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
  assert.equal(html, '<pre><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
  assert.ok(!html.includes('<script'));
});

test('XSS：链接文字里的引号被转义，不会逃出属性', () => {
  const html = renderMarkdown('[a" onmouseover="alert(1)](https://example.com)');
  assert.ok(!html.includes('onmouseover="alert'));
  assert.ok(html.includes('&quot;'));
});

test('行内代码里的标记符号原样保留（C 的双指针与调用写法不被误剥）', () => {
  assert.equal(stripInlineMarkers('`**p`'), '**p');
  assert.equal(stripInlineMarkers('用 `a[0](x)` 表示调用'), '用 a[0](x) 表示调用');
  assert.equal(renderMarkdown('`**p`'), '<p><code>**p</code></p>');
  assert.equal(toPlainText('参数写作 `**p` 与 `a[0](x)`。'), '参数写作 **p 与 a[0](x)。');
});

test('星号：P2* 与 P3* 这类参数名里的星号必须原样保留', () => {
  const source = 'S3 管会话保持，P2* 管单次请求的响应时限，P2* 与 P3* 的区别在此。';
  // 纯文本路径（这是之前被吃掉的路径）
  assert.equal(
    stripInlineMarkers(source),
    'S3 管会话保持，P2* 管单次请求的响应时限，P2* 与 P3* 的区别在此。',
  );
  assert.equal(toPlainText(source), 'S3 管会话保持，P2* 管单次请求的响应时限，P2* 与 P3* 的区别在此。');
  // HTML 路径同样不得出现 <em>，星号原样保留
  const html = renderMarkdown(source);
  assert.equal(html, `<p>${source}</p>`);
  assert.ok(!html.includes('<em>'));
});

test('星号：单个 P2* 单独出现时保留', () => {
  assert.equal(stripInlineMarkers('P2*'), 'P2*');
  assert.equal(stripInlineMarkers('参数 P2* 管单次请求'), '参数 P2* 管单次请求');
  assert.equal(renderMarkdown('P2*'), '<p>P2*</p>');
  assert.equal(toPlainText('S3* 与 P2*'), 'S3* 与 P2*');
});

test('星号：P2*与 P3* 这种没有空格的写法也不误判为斜体', () => {
  // 星号紧贴中文时不能靠空白判断，边界保护要求闭合星号后不是单词字符
  assert.equal(stripInlineMarkers('P2*与 P3*的区别'), 'P2*与 P3*的区别');
  assert.equal(renderMarkdown('P2*与 P3*的区别'), '<p>P2*与 P3*的区别</p>');
});

test('星号：正常斜体与加粗继续工作', () => {
  assert.equal(renderMarkdown('*斜体*'), '<p><em>斜体</em></p>');
  assert.equal(stripInlineMarkers('*斜体*'), '斜体');
  assert.equal(renderMarkdown('**加粗**'), '<p><strong>加粗</strong></p>');
  assert.equal(stripInlineMarkers('**加粗**'), '加粗');
  assert.equal(renderMarkdown('前 **粗** 后'), '<p>前 <strong>粗</strong> 后</p>');
});

test('星号：两侧是空白时按字面量保留', () => {
  assert.equal(renderMarkdown('a * b'), '<p>a * b</p>');
  assert.equal(stripInlineMarkers('a * b'), 'a * b');
  assert.equal(renderMarkdown('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
  assert.equal(stripInlineMarkers('2 * 3 * 4'), '2 * 3 * 4');
});

test('星号：行首的 *强调* 仍然生效', () => {
  assert.equal(renderMarkdown('*强调*在行首'), '<p><em>强调</em>在行首</p>');
  assert.equal(stripInlineMarkers('*强调*在行首'), '强调在行首');
  assert.equal(renderMarkdown('**加粗**在行首'), '<p><strong>加粗</strong>在行首</p>');
});

test('星号：闭合星号后紧跟标点或结尾时正常生效', () => {
  assert.equal(renderMarkdown('**EcuM_Init()**之后才开始调度'), '<p><strong>EcuM_Init()</strong>之后才开始调度</p>');
  assert.equal(renderMarkdown('调用 **StartOS**。'), '<p>调用 <strong>StartOS</strong>。</p>');
  assert.equal(renderMarkdown('见 *说明*'), '<p>见 <em>说明</em></p>');
});

test('星号：行内代码里的星号完全不受影响', () => {
  assert.equal(stripInlineMarkers('`P2*` 与 `P3*`'), 'P2* 与 P3*');
  assert.equal(stripInlineMarkers('`**p` 是双指针'), '**p 是双指针');
  assert.equal(renderMarkdown('`**p`'), '<p><code>**p</code></p>');
});

test('escapeHtml 覆盖 & < > " 四个基础字符与单引号', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

// ---------------------------------------------------------------------------
// extractHeadings
// ---------------------------------------------------------------------------

test('extractHeadings 按出现顺序返回层级与文本', () => {
  const headings = extractHeadings('# 文档\n\n正文\n\n## 小节一\n\n### 三级\n\n## 小节二');
  assert.deepEqual(headings, [
    { level: 1, text: '文档', anchor: '文档' },
    { level: 2, text: '小节一', anchor: '小节一' },
    { level: 3, text: '三级', anchor: '三级' },
    { level: 2, text: '小节二', anchor: '小节二' },
  ]);
});

test('extractHeadings 对重复标题追加 -2、-3', () => {
  const headings = extractHeadings('# 甲\n\n## 甲\n\n## 甲\n\n## 乙');
  assert.deepEqual(headings.map(item => item.anchor), ['甲', '甲-2', '甲-3', '乙']);
});

test('extractHeadings 不受代码块与注释里的 # 影响', () => {
  const headings = extractHeadings('```\n# 代码里的井号\n```\n\n<!-- # 注释里的井号 -->\n\n## 真标题');
  assert.deepEqual(headings, [{ level: 2, text: '真标题', anchor: '真标题' }]);
});

test('extractHeadings 的 anchor 与 renderMarkdown 输出的 id 完全一致', () => {
  const source = [
    '# EcuM 启动',
    '',
    '## InitZero 与 InitOne',
    '',
    '正文。',
    '',
    '## InitZero 与 InitOne',
    '',
    '重复标题。',
    '',
    '## 全是符号 ###',
  ].join('\n');
  const ids = [...renderMarkdown(source, { anchorPrefix: 'p-' }).matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const anchors = extractHeadings(source).map(item => `p-${item.anchor}`);
  assert.deepEqual(ids, anchors);
});

// ---------------------------------------------------------------------------
// 文章解析
// ---------------------------------------------------------------------------

const ARTICLE_SOURCE = `# EcuM Flexible 启动顺序

<!-- doc: startup-ecum-flexible -->
<!-- tags: EcuM, StartOS, BswM -->
<!-- summary: 从复位到 StartOS 前后，EcuM 如何组织初始化块。 -->
<!-- refs: src-ecum, src-mode-guide -->

这篇文档说明从复位到 StartOS 前后的启动骨架。

## EcuM_Init 是上电后的第一个 BSW 入口

<!-- keywords: EcuM_Init, StartOS, InitBlock -->

复位向量完成最小 C 环境之后，控制权交给 **EcuM_Init()**，此时 \`OS\` 尚未启动。

## InitZero 不使用 Post-Build 配置

<!-- keywords: InitZero, InitOne, Post-Build -->

启动分为 InitZero 与 InitOne 两段。

# Fixed 与 Flexible 状态机差异

<!-- doc: startup-fixed-vs-flexible -->
<!-- tags: Fixed, Flexible -->

固定配置与灵活配置的状态机差异。

## Fixed 的确定性

<!-- keywords: Fixed, 启动表 -->

Fixed 用编译期确定的启动表。

## Flexible 的运行时选择

<!-- keywords: Flexible, Post-Build -->

Flexible 在运行时选择配置。
`;

test('parseArticle 解析文档元数据注释', () => {
  const article = parseArticle(ARTICLE_SOURCE, { path: 'knowledge/01-startup.md' });
  const [document] = article.documents;
  assert.equal(article.path, 'knowledge/01-startup.md');
  assert.equal(document.id, 'startup-ecum-flexible');
  assert.equal(document.title, 'EcuM Flexible 启动顺序');
  assert.deepEqual(document.tags, ['EcuM', 'StartOS', 'BswM']);
  assert.deepEqual(document.refs, ['src-ecum', 'src-mode-guide']);
  assert.equal(document.summary, '从复位到 StartOS 前后，EcuM 如何组织初始化块。');
});

test('parseArticle 把一篇文件拆成多个文档并保持顺序', () => {
  const article = parseArticle(ARTICLE_SOURCE);
  assert.deepEqual(article.documents.map(item => item.id), ['startup-ecum-flexible', 'startup-fixed-vs-flexible']);
  assert.deepEqual(article.documents.map(item => item.title), ['EcuM Flexible 启动顺序', 'Fixed 与 Flexible 状态机差异']);
});

test('parseArticle 的 intro 只包含一级标题与第一个小节之间的正文', () => {
  const [document] = parseArticle(ARTICLE_SOURCE).documents;
  assert.equal(document.intro, '这篇文档说明从复位到 StartOS 前后的启动骨架。');
  assert.ok(!document.intro.includes('<!--'));
  assert.ok(!document.intro.includes('EcuM_Init 是上电后的第一个'));
});

test('parseArticle 的小节顺序、标题、锚点与 keywords 正确', () => {
  const [document] = parseArticle(ARTICLE_SOURCE).documents;
  assert.deepEqual(document.anchors, ['ecum-init-是上电后的第一个-bsw-入口', 'initzero-不使用-post-build-配置']);
  assert.deepEqual(document.sections.map(item => item.level), [2, 2]);
  assert.deepEqual(document.sections[0].keywords, ['EcuM_Init', 'StartOS', 'InitBlock']);
  assert.equal(document.sections[1].heading, 'InitZero 不使用 Post-Build 配置');
});

test('parseArticle 的 section.markdown 不含标题行与注释', () => {
  const [document] = parseArticle(ARTICLE_SOURCE).documents;
  const section = document.sections[0];
  assert.ok(!section.markdown.includes('## '));
  assert.ok(!section.markdown.includes('<!--'));
  assert.ok(section.markdown.startsWith('复位向量完成最小 C 环境'));
});

test('parseArticle 的 section.plain 等于纯文本（与 corpus chunk.text 对齐）', () => {
  const [document] = parseArticle(ARTICLE_SOURCE).documents;
  const section = document.sections[0];
  assert.equal(section.plain, '复位向量完成最小 C 环境之后，控制权交给 EcuM_Init()，此时 OS 尚未启动。');
  assert.equal(section.plain, toPlainText(section.markdown));
  assert.ok(!section.plain.includes('**'));
  assert.ok(!section.plain.includes('`'));
});

test('parseArticle 对同一文档内的重复小节标题去重', () => {
  const source = '# 文档\n\n## 重复\n\n甲\n\n## 重复\n\n乙\n\n## 重复\n\n丙';
  const [document] = parseArticle(source).documents;
  assert.deepEqual(document.anchors, ['重复', '重复-2', '重复-3']);
});

test('parseArticle 不把代码块里的 ## 当成小节切分', () => {
  const source = '# 文档\n\n## 唯一小节\n\n```md\n## 这是代码\n```\n\n真正的正文。';
  const [document] = parseArticle(source).documents;
  assert.equal(document.sections.length, 1);
  assert.ok(document.sections[0].markdown.includes('## 这是代码'));
  assert.equal(document.sections[0].plain, '## 这是代码\n真正的正文。');
});

test('parseArticle 把 ### 及更深的标题留在小节正文里', () => {
  const source = '# 文档\n\n## 小节\n\n### 子标题\n\n正文。';
  const [document] = parseArticle(source).documents;
  assert.equal(document.sections.length, 1);
  assert.ok(document.sections[0].markdown.includes('### 子标题'));
});

test('parseArticle 在空输入、纯注释、只有标题时都不抛错', () => {
  assert.deepEqual(parseArticle('').documents, []);
  assert.deepEqual(parseArticle('<!-- doc: only-comment -->').documents, []);
  assert.deepEqual(parseArticle(undefined).documents, []);

  const titleOnly = parseArticle('# 只有标题\n');
  assert.equal(titleOnly.documents.length, 1);
  assert.equal(titleOnly.documents[0].title, '只有标题');
  assert.equal(titleOnly.documents[0].intro, '');
  assert.deepEqual(titleOnly.documents[0].sections, []);

  // 没有 # 一级标题时退化成一篇只有导语的文档，而不是丢内容
  const withoutDocTitle = parseArticle('## 孤立小节\n\n正文');
  assert.equal(withoutDocTitle.documents.length, 1);
  assert.deepEqual(withoutDocTitle.documents[0].sections, []);
});

test('parseArticle 在没有 doc 注释时用标题派生 id，并提供 meta.title 兜底', () => {
  const article = parseArticle('# 没有标识的文档\n\n正文');
  assert.equal(article.documents[0].id, '没有标识的文档');

  const fallback = parseArticle('只有正文，没有标题。', { path: 'x.md', title: '外部标题' });
  assert.equal(fallback.documents.length, 1);
  assert.equal(fallback.documents[0].title, '外部标题');
  assert.equal(fallback.documents[0].intro, '只有正文，没有标题。');
});

test('parseArticle 默认 path 为空字符串', () => {
  assert.equal(parseArticle(ARTICLE_SOURCE).path, '');
});

// ---------------------------------------------------------------------------
// findSection
// ---------------------------------------------------------------------------

test('findSection 命中时返回所在文档与小节', () => {
  const article = parseArticle(ARTICLE_SOURCE);
  const hit = findSection(article, 'initzero-不使用-post-build-配置');
  assert.ok(hit);
  assert.equal(hit.document.id, 'startup-ecum-flexible');
  assert.equal(hit.section.anchor, 'initzero-不使用-post-build-配置');
  assert.equal(hit.section.heading, 'InitZero 不使用 Post-Build 配置');
});

test('findSection 未命中时返回 null', () => {
  const article = parseArticle(ARTICLE_SOURCE);
  assert.equal(findSection(article, '不存在的锚点'), null);
  assert.equal(findSection(article, ''), null);
  assert.equal(findSection(null, '任意'), null);
});

// ---------------------------------------------------------------------------
// toPlainText
// ---------------------------------------------------------------------------

test('toPlainText 去掉行内标记并保留链接文字', () => {
  assert.equal(
    toPlainText('用 **加粗**、*斜体*、`代码` 与 [链接文字](https://example.com) 组成。'),
    '用 加粗、斜体、代码 与 链接文字 组成。',
  );
});

test('toPlainText 去掉 HTML 注释与标题井号', () => {
  assert.equal(toPlainText('<!-- keywords: a, b -->\n\n正文'), '正文');
  assert.equal(toPlainText('# 标题\n\n正文'), '标题\n正文');
  assert.equal(toPlainText('## 小节标题\n\n正文'), '小节标题\n正文');
});

test('toPlainText 段落之间用单个换行连接并压缩空白', () => {
  assert.equal(toPlainText('第一段。\n\n\n\n第二段。'), '第一段。\n第二段。');
  assert.equal(toPlainText('第一段第一行\n第一段第二行'), '第一段第一行 第一段第二行');
  assert.equal(toPlainText('  前后空白  '), '前后空白');
  assert.equal(toPlainText(''), '');
});

test('toPlainText 去掉列表与引用的标记', () => {
  assert.equal(toPlainText('- 甲\n- 乙'), '甲\n乙');
  assert.equal(toPlainText('1. 甲\n2. 乙'), '甲\n乙');
  assert.equal(toPlainText('> 引用'), '引用');
});

test('toPlainText 忽略分隔线且保留代码块内容', () => {
  assert.equal(toPlainText('正文\n\n---\n\n后续'), '正文\n后续');
  assert.equal(toPlainText('```js\nconst a = 1;\n```'), 'const a = 1;');
});

test('toPlainText 对已纯文本化的内容保持稳定（不会二次剥离字符）', () => {
  const plain = '复位向量完成后，控制权交给 EcuM_Init()，C 指针写作 *p。';
  assert.equal(toPlainText(plain), plain);
});

test('toPlainText 与现有 corpus 的 chunk.text 逐字一致（A1/A2 同步契约）', async t => {
  let corpus = null;
  try {
    const { readFile } = await import('node:fs/promises');
    corpus = JSON.parse(await readFile(new URL('../knowledge/corpus.json', import.meta.url), 'utf8'));
  } catch {
    corpus = null;
  }
  if (!corpus) {
    t.skip('knowledge/corpus.json 不存在，跳过语料对齐校验');
    return;
  }
  // 用「空白归一后逐字相等」做对齐：能抓住标记漂移（例如 A1 忘记剥 **），
  // 但不会因为列表/多行段落的换行形状不同而误报。
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  const drifted = [];
  for (const document of corpus.documents ?? []) {
    for (const chunk of document.chunks ?? []) {
      if (typeof chunk.text !== 'string') continue;
      if (normalize(toPlainText(chunk.text)) !== normalize(chunk.text)) drifted.push(chunk.id);
    }
  }
  assert.deepEqual(drifted, [], `这些 chunk 的 text 与 toPlainText 结果不一致：${drifted.join(', ')}`);
});

// ---------------------------------------------------------------------------
// renderArticle / renderSection
// ---------------------------------------------------------------------------

test('renderArticle 渲染标题、导语与小节容器（小节 id 等于 anchor）', () => {
  const article = parseArticle(ARTICLE_SOURCE);
  const html = renderArticle(article);
  assert.ok(html.startsWith('<article class="rag-article">'));
  assert.ok(html.endsWith('</article>'));
  // 文档级 H1 独占 doc- 命名空间：它不能和小节锚点抢同一个 id，
  // 否则标题与小节同名的文档会出现重复 id，阅读器 querySelector 就会命错节点。
  assert.ok(html.includes('<h1 id="doc-ecum-flexible-启动顺序" data-doc-anchor="doc-ecum-flexible-启动顺序">EcuM Flexible 启动顺序</h1>'));
  assert.ok(html.includes('<div class="rag-doc-intro">'));
  for (const document of article.documents) {
    for (const section of document.sections) {
      assert.ok(html.includes(`<section class="rag-section" id="${section.anchor}"`), `缺少小节容器 ${section.anchor}`);
      assert.ok(html.includes(`data-anchor="${section.anchor}"`));
    }
  }
  assert.ok(html.includes('<h2>EcuM_Init 是上电后的第一个 BSW 入口</h2>'));
  // 元数据注释不得出现在渲染结果里
  assert.ok(!html.includes('<!--'));
  assert.ok(!html.includes('keywords:'));
});

test('renderArticle 支持 anchorPrefix，且小节 id 前缀与文档标题命名空间一致', () => {
  const article = parseArticle(ARTICLE_SOURCE);
  const html = renderArticle(article, { anchorPrefix: 'doc-' });
  // 文档标题：前缀 + doc- + 标题 slug
  assert.ok(html.includes('<h1 id="doc-doc-ecum-flexible-启动顺序"'));
  // 小节：前缀 + 小节 anchor
  assert.ok(html.includes('id="doc-initzero-不使用-post-build-配置"'));
  // data-anchor 保留不带前缀的原始锚点，便于按 chunk.anchor 定位
  assert.ok(html.includes('data-anchor="initzero-不使用-post-build-配置"'));
});

test('renderSection 只渲染小节正文，不含标题行', () => {
  const article = parseArticle(ARTICLE_SOURCE);
  const html = renderSection(article.documents[0].sections[0]);
  assert.ok(!html.includes('<h2'));
  assert.ok(html.includes('<strong>EcuM_Init()</strong>'));
  assert.ok(!html.includes('<!--'));
  assert.equal(renderSection(null), '');
  assert.equal(renderArticle({ documents: [] }), '');
});

test('parseArticle 与 renderArticle 对真实新格式源文件端到端可用', () => {
  const source = `# 文档

<!-- doc: demo -->

导语一句。

## 第一节

<!-- keywords: a, b -->

正文一，含 \`代码\` 与 [链接](https://example.com)。

## 第二节

- 甲
- 乙

> 引用一句。
`;
  const article = parseArticle(source, { path: 'knowledge/demo.md' });
  const html = renderArticle(article);
  assert.ok(html.includes('<h2>第一节</h2>'));
  assert.ok(html.includes('<code>代码</code>'));
  assert.ok(html.includes('<a href="https://example.com" rel="noreferrer">链接</a>'));
  assert.ok(html.includes('<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>'));
  assert.ok(html.includes('<blockquote>'));
  assert.equal(article.documents[0].sections[1].plain, '甲\n乙\n引用一句。');
});

// ---------------------------------------------------------------------------
// 确定性
// ---------------------------------------------------------------------------

test('确定性：同输入连续两次渲染结果完全一致', () => {
  const source = ARTICLE_SOURCE + '\n```js\nconst a = 1;\n```\n';
  assert.equal(renderMarkdown(source), renderMarkdown(source));
  assert.equal(renderMarkdown(source, { anchorPrefix: 'x-' }), renderMarkdown(source, { anchorPrefix: 'x-' }));
  assert.deepEqual(extractHeadings(source), extractHeadings(source));
});

test('确定性：文章解析与整篇渲染可重复', () => {
  const first = parseArticle(ARTICLE_SOURCE, { path: 'a.md' });
  const second = parseArticle(ARTICLE_SOURCE, { path: 'a.md' });
  assert.deepEqual(first, second);
  assert.equal(renderArticle(first), renderArticle(second));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('确定性：CRLF 输入与 LF 输入产出相同结果', () => {
  const lf = ARTICLE_SOURCE;
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(renderMarkdown(crlf), renderMarkdown(lf));
  assert.deepEqual(parseArticle(crlf), parseArticle(lf));
});

test('模块辅助函数在小输入上也不抛错', () => {
  assert.equal(stripHtmlComments('<!-- a -->b'), 'b');
  assert.equal(stripInlineMarkers('**粗** *斜* `码` [文](u)'), '粗 斜 码 文');
  assert.deepEqual(extractHeadings(''), []);
  assert.equal(toPlainText(undefined), '');
});
