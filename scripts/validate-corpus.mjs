// 知识库语料库契约校验（零依赖、进程内、不 spawn）。
//
// 用法：
//   node scripts/validate-corpus.mjs
//
// 校验规则见 knowledge/README.md 与 .runtime/rag-contract.md 第 2 节：
//   - chunk.id 全局唯一，且以 `<docId>#` 开头
//   - chunk.text 为纯文本，长度 90–600 字符，不含 <script> 与 Markdown 语法
//   - chunk.keywords ≥3 个，且必须真实出现在 heading 或 text 中（忽略大小写与空白差异）
//   - 每个 document ≥2 个 chunk；每个 category ≥2 个 document
//   - 全库 ≥150 个 chunk，文件 ≤500KB
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 复用渲染器里的 slugify，保证校验用的锚点规则与真正渲染时完全一致。
import { slugify } from "../src/rag/markdown.mjs";

const MIN_TEXT = 90;
const MAX_TEXT = 600;
const MIN_CHUNKS = 150;
const MAX_BYTES = 500 * 1024;
const MIN_KEYWORDS = 3;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.join(root, "knowledge", "corpus.json");

// 关键词匹配要容忍大小写、空格、下划线与常见分隔符差异：
// 「NormalOperation」应能匹配 heading 里的「NormalOperation」或正文里的「normal operation」。
const normalize = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[\s_\-·・/]/g, "");

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

let raw;
try {
  raw = await readFile(corpusPath, "utf8");
} catch {
  console.error(`Corpus not found: ${path.relative(root, corpusPath)}`);
  process.exitCode = 1;
  process.exit();
}

if (raw.charCodeAt(0) === 0xfeff) {
  fail("corpus.json 以 UTF-8 BOM 开头，浏览器 JSON.parse 会失败");
}

let corpus;
try {
  corpus = JSON.parse(raw);
} catch (error) {
  console.error(`corpus.json 不是合法 JSON: ${error.message}`);
  process.exit(1);
}

for (const field of ["version", "title", "categories", "documents"]) {
  if (!(field in corpus)) fail(`缺少顶层字段 ${field}`);
}
if (!Array.isArray(corpus.categories)) fail("categories 不是数组");
if (!Array.isArray(corpus.documents)) fail("documents 不是数组");
if (!Array.isArray(corpus.sources)) warn("sources 缺失或不是数组");

const categoryIds = new Set();
const categoryOrder = new Map();
for (const item of corpus.categories ?? []) {
  if (!item?.id) {
    fail(`category 缺少 id: ${JSON.stringify(item)}`);
    continue;
  }
  if (categoryIds.has(item.id)) fail(`category id 重复: ${item.id}`);
  categoryIds.add(item.id);
  categoryOrder.set(item.id, item.order ?? 999);
  if (!item.label) warn(`category ${item.id} 缺少 label`);
}

const sourceIds = new Set((corpus.sources ?? []).map((item) => item?.id).filter(Boolean));
const docIds = new Set();
const chunkIds = new Set();
const perCategory = new Map();
let chunkCount = 0;
let minLen = Infinity;
let maxLen = 0;

for (const doc of corpus.documents ?? []) {
  if (!doc?.id) {
    fail(`document 缺少 id: ${JSON.stringify(doc).slice(0, 80)}`);
    continue;
  }
  if (docIds.has(doc.id)) fail(`document id 重复: ${doc.id}`);
  docIds.add(doc.id);

  if (!doc.title) fail(`document ${doc.id} 缺少 title`);
  if (!doc.category) fail(`document ${doc.id} 缺少 category`);
  else if (!categoryIds.has(doc.category)) fail(`document ${doc.id} 的 category "${doc.category}" 未在 categories 中声明`);
  else perCategory.set(doc.category, (perCategory.get(doc.category) ?? 0) + 1);

  if (!Array.isArray(doc.tags) || doc.tags.length < 2) fail(`document ${doc.id} 的 tags 少于 2 个`);
  if (!doc.source?.path) fail(`document ${doc.id} 缺少 source.path`);

  for (const ref of doc.refs ?? []) {
    if (!sourceIds.has(ref)) fail(`document ${doc.id} 引用了未知来源 ${ref}`);
  }

  if (!Array.isArray(doc.chunks)) {
    fail(`document ${doc.id} 缺少 chunks 数组`);
    continue;
  }
  if (doc.chunks.length < 2) fail(`document ${doc.id} 只有 ${doc.chunks.length} 个 chunk（要求 ≥2）`);

  doc.chunks.forEach((chunk, index) => {
    chunkCount += 1;
    const where = `${doc.id}[${index}]`;
    if (!chunk?.id) return fail(`${where} 缺少 chunk id`);
    if (chunkIds.has(chunk.id)) fail(`chunk id 重复: ${chunk.id}`);
    chunkIds.add(chunk.id);
    if (!chunk.id.startsWith(`${doc.id}#`)) fail(`chunk id "${chunk.id}" 未以 "${doc.id}#" 开头`);
    if (!chunk.heading) fail(`${where} 缺少 heading`);

    const text = chunk.text;
    if (typeof text !== "string" || text.length === 0) return fail(`${where} text 为空或非字符串`);
    if (text.length < MIN_TEXT) fail(`${where} text 过短 ${text.length} < ${MIN_TEXT}`);
    if (text.length > MAX_TEXT) fail(`${where} text 过长 ${text.length} > ${MAX_TEXT}`);
    minLen = Math.min(minLen, text.length);
    maxLen = Math.max(maxLen, text.length);

    if (/<script/i.test(text)) fail(`${where} text 含 <script`);
    if (/```|\*\*/.test(text) || /^#{1,6}\s/m.test(text)) warn(`${where} text 疑似含 Markdown 语法`);

    if (!Array.isArray(chunk.keywords) || chunk.keywords.length < MIN_KEYWORDS) {
      return fail(`${where} keywords 少于 ${MIN_KEYWORDS} 个`);
    }

    // 关键词必须能被检索到：出现在 heading 或 text 中（归一化后匹配）。
    const searchable = `${normalize(chunk.heading)} ${normalize(text)}`;
    for (const keyword of chunk.keywords) {
      if (typeof keyword !== "string" || keyword.length === 0) {
        fail(`${where} 存在空 keyword`);
        continue;
      }
      if (!searchable.includes(normalize(keyword))) {
        fail(`${where} keyword "${keyword}" 既不在 heading 也不在 text 中`);
      }
    }
  });
}

// 渲染后 id 必须唯一：阅读器用 querySelector('[id="<anchor>"]') 定位，只取第一个匹配。
// 同一个分册文件会被整体渲染，所以「文档标题锚点」与「小节锚点」共享命名空间，
// 一旦碰撞就会让某个小节无法被唯一定位（点「查看原文」跳到文档标题而不是正文）。
{
  const bySource = new Map();
  for (const doc of corpus.documents ?? []) {
    const sourcePath = doc?.source?.path;
    if (!sourcePath) continue;
    if (!bySource.has(sourcePath)) bySource.set(sourcePath, []);
    bySource.get(sourcePath).push(doc);
  }
  for (const [sourcePath, docs] of bySource) {
    const seen = new Map();
    const note = (id, what) => {
      const prev = seen.get(id);
      if (prev) {
        fail(`${sourcePath} 渲染后 id "${id}" 重复：${prev} 与 ${what}`);
      } else {
        seen.set(id, what);
      }
    };
    for (const doc of docs) {
      note(`doc-${slugify(doc.title || doc.id || "document")}`, `文档标题「${doc.title}」`);
      for (const chunk of doc.chunks ?? []) {
        if (chunk?.anchor) note(String(chunk.anchor), `小节「${chunk.heading}」`);
      }
    }
  }
}

for (const category of categoryIds) {
  const count = perCategory.get(category) ?? 0;
  if (count < 2) fail(`category ${category} 只有 ${count} 个 document（要求 ≥2）`);
}

if (chunkCount < MIN_CHUNKS) fail(`chunk 总数 ${chunkCount} < ${MIN_CHUNKS}`);
// 用真实字节数，而不是字符串长度：中文在 UTF-8 下是 3 字节，字符串长度会低估体积。
const bytes = Buffer.byteLength(raw, "utf8");
if (bytes > MAX_BYTES) fail(`文件 ${(bytes / 1024).toFixed(1)}KB 超过 ${MAX_BYTES / 1024}KB`);

const orderedCategories = [...categoryIds].sort((a, b) => categoryOrder.get(a) - categoryOrder.get(b));
console.log(`documents : ${corpus.documents?.length ?? 0}`);
console.log(`chunks    : ${chunkCount}`);
console.log(`size      : ${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)`);
console.log(`text len  : min ${minLen} / max ${maxLen}`);
console.log(`categories: ${categoryIds.size}`);
for (const category of orderedCategories) {
  const docs = perCategory.get(category) ?? 0;
  const chunks = (corpus.documents ?? [])
    .filter((doc) => doc.category === category)
    .reduce((total, doc) => total + (doc.chunks?.length ?? 0), 0);
  console.log(`  ${String(category).padEnd(14)} ${String(docs).padStart(2)} docs / ${String(chunks).padStart(3)} chunks`);
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const message of warnings.slice(0, 20)) console.log(`  ! ${message}`);
  if (warnings.length > 20) console.log(`  ... ${warnings.length - 20} more`);
}

if (errors.length > 0) {
  console.log(`\n${errors.length} ERROR(s):`);
  for (const message of errors.slice(0, 40)) console.log(`  x ${message}`);
  if (errors.length > 40) console.log(`  ... ${errors.length - 40} more`);
  process.exitCode = 1;
} else {
  console.log("\nCorpus validation: PASS");
}
