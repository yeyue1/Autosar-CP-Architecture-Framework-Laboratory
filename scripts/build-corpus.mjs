// 从 knowledge/*.md 文章派生 knowledge/corpus.json。
//
// 用法：
//   node scripts/build-corpus.mjs
//
// 设计原则（见 .runtime/reader-contract.md §2/§3/§5）：
//   1. 文章是唯一事实来源。改完 knowledge/*.md 就跑这个脚本重建索引，
//      再也不需要「改文章 + 手工改 JSON」两处同步。
//   2. anchor 用契约 §3 的 slugify 生成，与阅读器给 <h2> 生成的 id 完全同规则，
//      因此「查看原文」跳锚点必然命中。
//   3. chunk.text 用契约 §5 的 toPlainText 从该小节 Markdown 生成，
//      与 src/rag/article.mjs 的 section.plain 同一规则，保证两边不脱节。
//
// 零依赖、进程内运行、不 spawn 子进程。
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeDir = path.join(root, "knowledge");
const corpusPath = path.join(knowledgeDir, "corpus.json");

// ---------------------------------------------------------------------------
// 契约实现：slugify（§3）与 toPlainText（§5）
//
// 优先复用 src/rag/article.mjs（A2 的文章模型，toPlainText 是两边共享的唯一实现），
// 这样 corpus 的 chunk.text 与阅读器 parseArticle 出的 section.plain 逐字一致。
// 该模块缺失或被改动时退回下面这份同规则副本，脚本仍然可用。
// ---------------------------------------------------------------------------

/** 由标题生成稳定锚点（契约 §3，兜底副本）。 */
export function slugify(heading) {
  return (
    String(heading)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** 把一段 Markdown 压成纯文本（契约 §5，兜底副本）。 */
export function toPlainText(markdown) {
  const withoutComments = String(markdown ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [];
  for (const rawLine of withoutComments.replace(/\r\n?/g, "\n").split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) continue; // 分隔线不算正文
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>[ ]?/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "");
    line = line.replace(/\s+/g, " ").trim();
    if (line) blocks.push(line);
  }
  return blocks.join("\n");
}

let slugifyImpl = slugify;
let toPlainTextImpl = toPlainText;
const reused = [];

/** 尝试从 A2 的模块取实现；取不到就用本文件里的同规则副本。 */
async function adoptShared(modulePath, exportName, apply) {
  try {
    const shared = await import(new URL(modulePath, import.meta.url).href);
    if (typeof shared[exportName] === "function") {
      apply(shared[exportName]);
      reused.push(`${modulePath.replace("../", "")} → ${exportName}()`);
    }
  } catch {
    // 模块还不存在（或正在被改写）：静默退回内联副本，规则相同。
  }
}

await adoptShared("../src/rag/markdown.mjs", "slugify", (fn) => {
  slugifyImpl = fn;
});
await adoptShared("../src/rag/article.mjs", "toPlainText", (fn) => {
  toPlainTextImpl = fn;
});

// ---------------------------------------------------------------------------
// 分类与来源登记表（顶层 categories / sources 的唯一事实来源）
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: "startup", label: "启动与 EcuM", order: 1 },
  { id: "uds", label: "诊断与刷写", order: 2 },
  { id: "communication", label: "通信与网络管理", order: 3 },
  { id: "storage", label: "存储 NvM/Fee", order: 4 },
  { id: "os", label: "OS 与多核调度", order: 5 },
  { id: "xcp", label: "XCP 标定", order: 6 },
  { id: "system", label: "系统架构与 CDD", order: 7 },
  { id: "methodology", label: "方法论与工程实践", order: 8 },
  { id: "boundary", label: "边界与常见误解", order: 9 },
];

const SOURCES = [
  {
    id: "src-ecum",
    title: "AUTOSAR SWS ECU State Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_ECUStateManager.pdf",
  },
  {
    id: "src-fixed",
    title: "AUTOSAR SWS ECU State Manager Fixed R4.3.1 (历史)",
    url: "https://www.autosar.org/fileadmin/standards/R4.3.1/CP/AUTOSAR_SWS_ECUStateManagerFixed.pdf",
  },
  {
    id: "src-mode-guide",
    title: "AUTOSAR EXP Mode Management Guide R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_ModeManagementGuide.pdf",
  },
  {
    id: "src-bswm",
    title: "AUTOSAR SWS BSW Mode Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_BSWModeManager.pdf",
  },
  {
    id: "src-rte",
    title: "AUTOSAR SWS RTE R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_RTE.pdf",
  },
  {
    id: "src-nvm",
    title: "AUTOSAR SWS NVRAM Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_NVRAMManager.pdf",
  },
  {
    id: "src-fee",
    title: "AUTOSAR SWS Flash EEPROM Emulation R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_FlashEEPROMEmulation.pdf",
  },
  {
    id: "src-fls",
    title: "AUTOSAR SWS Flash Driver R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_FlashDriver.pdf",
  },
  {
    id: "src-comm",
    title: "AUTOSAR SWS Communication Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_COMManager.pdf",
  },
  {
    id: "src-cansm",
    title: "AUTOSAR SWS CAN State Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_CANStateManager.pdf",
  },
  {
    id: "src-com",
    title: "AUTOSAR SWS COM R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_COM.pdf",
  },
  {
    id: "src-pdur",
    title: "AUTOSAR SWS PDU Router R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_PDURouter.pdf",
  },
  {
    id: "src-cantp",
    title: "AUTOSAR SWS CAN Transport Layer R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_CANTransportLayer.pdf",
  },
  {
    id: "src-nm",
    title: "AUTOSAR SWS Network Management Interface R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_NetworkManagementInterface.pdf",
  },
  {
    id: "src-e2e",
    title: "AUTOSAR SWS E2E Library R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_E2ELibrary.pdf",
  },
  {
    id: "src-dcm",
    title: "AUTOSAR SWS Diagnostic Communication Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticCommunicationManager.pdf",
  },
  {
    id: "src-dem",
    title: "AUTOSAR SWS Diagnostic Event Manager R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticEventManager.pdf",
  },
  {
    id: "src-os",
    title: "AUTOSAR SWS Operating System R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_OS.pdf",
  },
  {
    id: "src-wdg",
    title: "AUTOSAR SWS Watchdog Driver R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_WatchdogDriver.pdf",
  },
  {
    id: "src-cdd",
    title: "AUTOSAR EXP CDD Design and Integration Guideline R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_CDDDesignAndIntegrationGuideline.pdf",
  },
  {
    id: "src-vfb",
    title: "AUTOSAR EXP Virtual Functional Bus R24-11",
    url: "https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_VFB.pdf",
  },
  {
    id: "src-arxml",
    title: "AUTOSAR TPS Generic Structure Template / ARXML",
    url: "https://www.autosar.org/standards/classic-platform/",
  },
  {
    id: "src-xcp",
    title: "ASAM MCD-1 XCP 与 A2L (MCD-2 MC) 概念参照",
    url: "https://www.asam.net/standards/detail/mcd-1-xcp/",
  },
  {
    id: "src-model",
    title: "本项目 src/model.mjs 教学模型（内部）",
    url: "https://github.com/yueyue1/Autosar-CP-Architecture-Framework-Laboratory",
  },
  {
    id: "src-tests",
    title: "本项目 tests 与 docs 教学说明（内部）",
    url: "https://github.com/yueyue1/Autosar-CP-Architecture-Framework-Laboratory",
  },
];

// 分册 → 分类。文件名（含序号）决定文档在 corpus 中的顺序。
const FILES = [
  ["01-startup.md", "startup"],
  ["02-uds.md", "uds"],
  ["03-communication.md", "communication"],
  ["04-storage.md", "storage"],
  ["05-os.md", "os"],
  ["06-xcp.md", "xcp"],
  ["07-system.md", "system"],
  ["08-methodology.md", "methodology"],
  ["09-boundary.md", "boundary"],
];

// ---------------------------------------------------------------------------
// Markdown 文章解析（契约 §2 格式）
// ---------------------------------------------------------------------------

const H1 = /^#[ \t]+(.+?)\s*$/;
const H2 = /^##[ \t]+(.+?)\s*$/;
const COMMENT = /^<!--\s*([\s\S]*?)\s*-->\s*$/;

const splitList = (value) =>
  String(value ?? "")
    .split(/[,，、;；]/) // 与 src/rag/article.mjs 的 splitList 同一套分隔符
    .map((item) => item.trim())
    .filter(Boolean);

/** 读取形如 `<!-- doc: xxx -->` 的单行注释；不是元数据注释则返回 null。 */
function readMetaComment(line) {
  const match = COMMENT.exec(line.trim());
  if (!match) return null;
  const body = match[1];
  const meta = /^(doc|tags|summary|refs|keywords)\s*:\s*([\s\S]*)$/i.exec(body);
  if (!meta) return null;
  return { key: meta[1].toLowerCase(), value: meta[2].trim() };
}

/** 解析一篇分册 Markdown，返回其中的文档数组。 */
function parseArticleFile(source, { file, category }) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const documents = [];
  let doc = null;
  let section = null;

  const flushSection = () => {
    if (!section || !doc) return;
    const body = section.lines.join("\n").replace(/^\n+|\n+$/g, "");
    // heading 同样过一遍纯文本化：阅读器用 plainHeading + slugify 生成锚点，
    // 这里保持同一条链，corpus 的 heading/anchor 才与渲染结果一致。
    const heading = toPlainTextImpl(section.heading) || section.heading;
    doc.sections.push({
      heading,
      keywords: section.keywords,
      markdown: body,
      plain: toPlainTextImpl(body),
    });
    section = null;
  };

  const flushDoc = () => {
    flushSection();
    if (doc) documents.push(doc);
    doc = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const h1 = H1.exec(line);
    if (h1 && !line.startsWith("##")) {
      flushDoc();
      doc = {
        id: "",
        title: h1[1].trim(),
        tags: [],
        summary: "",
        refs: [],
        introLines: [],
        sections: [],
      };
      continue;
    }
    if (!doc) continue; // 文件级序言/头注释，忽略

    const h2 = H2.exec(line);
    if (h2) {
      flushSection();
      section = { heading: h2[1].trim(), keywords: [], lines: [] };
      continue;
    }

    if (trimmed === "") {
      if (section) section.lines.push("");
      else doc.introLines.push("");
      continue;
    }

    const meta = readMetaComment(trimmed);
    if (meta) {
      if (meta.key === "keywords") {
        // keywords 注释只在小节开头生效，正文里的同形注释当普通注释丢弃。
        if (section && section.lines.filter((item) => item.trim() !== "").length === 0) {
          section.keywords = splitList(meta.value);
        }
        continue;
      }
      // 文档元数据只在小节开始之前生效。
      if (section) continue;
      if (meta.key === "doc") doc.id = meta.value;
      else if (meta.key === "tags") doc.tags = splitList(meta.value);
      else if (meta.key === "summary") doc.summary = meta.value;
      else if (meta.key === "refs") doc.refs = splitList(meta.value);
      continue;
    }

    // 普通注释（含文件头）直接丢弃。
    if (COMMENT.test(trimmed)) continue;

    if (section) section.lines.push(line);
    else doc.introLines.push(line);
  }
  flushDoc();

  for (const item of documents) {
    item.category = category;
    item.path = `knowledge/${file}`;
    item.intro = item.introLines.join("\n").replace(/^\n+|\n+$/g, "");
    delete item.introLines;
    if (!item.id) throw new Error(`${file} 中「${item.title}」缺少 <!-- doc: ... --> 元数据`);
    if (!item.summary) throw new Error(`${item.id} 缺少 <!-- summary: ... --> 元数据`);
    if (item.tags.length < 2) throw new Error(`${item.id} 的 tags 少于 2 个`);
    if (item.sections.length < 2 || item.sections.length > 8) {
      throw new Error(`${item.id} 的小节数 ${item.sections.length} 不在 2–8 之间`);
    }
    if (!item.intro) throw new Error(`${item.id} 缺少 # 标题之后的导语段落`);
  }
  return documents;
}

// ---------------------------------------------------------------------------
// 组装 corpus
// ---------------------------------------------------------------------------

function buildCorpus() {
  const documents = [];
  const stats = new Map();

  for (const [file, category] of FILES) {
    const full = path.join(knowledgeDir, file);
    const source = readFileSync(full, "utf8");
    const parsed = parseArticleFile(source, { file, category });

    for (const doc of parsed) {
      const usedAnchors = new Map();
      const chunks = doc.sections.map((section, index) => {
        const base = slugifyImpl(section.heading);
        const seen = usedAnchors.get(base) ?? 0;
        usedAnchors.set(base, seen + 1);
        const anchor = seen === 0 ? base : `${base}-${seen + 1}`;
        return {
          id: `${doc.id}#${index + 1}`,
          heading: section.heading,
          level: 2,
          anchor,
          keywords: section.keywords,
          text: section.plain,
        };
      });

      documents.push({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        tags: doc.tags,
        summary: doc.summary,
        source: { kind: "original", path: doc.path },
        refs: doc.refs,
        chunks,
      });

      const bucket = stats.get(doc.category) ?? { docs: 0, chunks: 0 };
      bucket.docs += 1;
      bucket.chunks += chunks.length;
      stats.set(doc.category, bucket);
    }
  }

  // generatedAt 取知识库文章的最新修改日期：输入不变则输出稳定，便于 diff 与复现。
  let newest = 0;
  for (const [file] of FILES) {
    const mtime = statSync(path.join(knowledgeDir, file)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  const generatedAt = new Date(newest).toISOString().slice(0, 10);

  return {
    corpus: {
      version: 1,
      title: "AUTOSAR CP 知识库",
      generatedAt,
      license: "原创教学文本，语义参考 AUTOSAR R24-11 规范",
      categories: CATEGORIES,
      sources: SOURCES,
      documents,
    },
    stats,
  };
}

const { corpus, stats } = buildCorpus();
writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");

const chunkCount = corpus.documents.reduce((total, doc) => total + doc.chunks.length, 0);
const anchorCount = corpus.documents.reduce(
  (total, doc) => total + doc.chunks.filter((chunk) => chunk.anchor).length,
  0,
);

console.log(`knowledge/*.md → knowledge/corpus.json`);
console.log(
  `规则来源  : ${reused.length > 0 ? reused.join("，") : "内联副本（契约 §3/§5，与 src/rag/*.mjs 同规则）"}`,
);
console.log(`documents : ${corpus.documents.length}`);
console.log(`chunks    : ${chunkCount}（全部带 anchor: ${anchorCount === chunkCount ? "是" : "否"}）`);
console.log(`categories: ${corpus.categories.length}`);
for (const category of [...CATEGORIES].sort((a, b) => a.order - b.order)) {
  const bucket = stats.get(category.id) ?? { docs: 0, chunks: 0 };
  console.log(
    `  ${category.id.padEnd(14)} ${String(bucket.docs).padStart(2)} docs / ${String(bucket.chunks).padStart(3)} chunks  ${category.label}`,
  );
}
