# 知识库语料

本目录是「知识库检索」工作区的**全部数据来源**。运行时不读取任何其它位置，也不联网。

```
knowledge/
├── corpus.json            # 检索索引（**由文章生成**，不要手改）
├── 01-startup.md          # 分册文章：给人读的正文，也是 corpus 的唯一事实来源
├── 02-uds.md
├── 03-communication.md
├── 04-storage.md
├── 05-os.md
├── 06-xcp.md
├── 07-system.md
├── 08-methodology.md
├── 09-boundary.md
└── README.md              # 本文件
```

规模：**41 篇文档 / 208 个 chunk / 九大分类**；九篇分册合计约 113 KB，派生出的 `corpus.json` 约 171 KB。

## 两层结构

| 层 | 作用 | 谁在读 |
| --- | --- | --- |
| `*.md` 分册 | 人读的技术文章；「查看原文」在应用内渲染器的落地页 | 你；阅读器 |
| `corpus.json` | 检索用的切分片段（BM25 索引输入） | 浏览器里的 RAG 引擎 |

**方向只有一个**：文章 → `corpus.json`。改完文章跑一次构建即可，不需要、也不应该手工编辑 JSON：

```powershell
node scripts\build-corpus.mjs      # 重建索引（打印文档数 / chunk 数 / 每分类分布）
node scripts\validate-corpus.mjs   # 校验契约（必须 PASS）
```

每个 document 的 `source.path` 指回它所在的分册，因此从检索结果永远能追到原文。
因为索引是派生的，**文章和索引不可能脱节**——这正是这次把 `@@DOC/@@CHUNK` 构建格式
改成标准 Markdown 文章的目的。

## corpus.json 结构

```jsonc
{
  "version": 1,
  "title": "AUTOSAR CP 知识库",
  "generatedAt": "2026-11-04",        // 取分册最新修改日期，由构建写入
  "categories": [
    { "id": "startup", "label": "启动与 EcuM", "order": 1 }
  ],
  "sources": [
    { "id": "src-ecum", "title": "AUTOSAR SWS ECU State Manager R24-11", "url": "https://..." }
  ],
  "documents": [
    {
      "id": "startup-ecum-flexible",
      "title": "EcuM Flexible 启动顺序",
      "category": "startup",
      "tags": ["EcuM", "StartOS", "BswM"],
      "summary": "一句话摘要",
      "source": { "kind": "original", "path": "knowledge/01-startup.md" },
      "refs": ["src-ecum"],
      "chunks": [
        {
          "id": "startup-ecum-flexible#1",
          "heading": "StartOS 是控制权边界",
          "level": 2,
          "anchor": "startos-是控制权边界",   // 与阅读器 <h2 id> 一致
          "keywords": ["StartOS", "EcuM_StartupTwo", "控制权"],
          "text": "正文，90–600 个字符的纯文本……"
        }
      ]
    }
  ]
}
```

`chunks[i]` 与文章里第 i 个 `##` 小节一一对应：`heading` 是小节标题、`anchor` 是标题锚点、
`keywords` 来自 `<!-- keywords: -->`、`text` 由该小节 Markdown 纯文本化而来。
所以一个 document 有几节，就有几个 chunk——追加小节就自动多一个 chunk。

## 锚点：文章与索引之间唯一的硬约定

`anchor` 是整套溯源机制的支点，规则只有一条：

```
anchor = slugify(小节标题)
```

`slugify` 的算法（[`src/rag/markdown.mjs`](../src/rag/markdown.mjs)）：NFKC 归一化 → 转小写 → 把非「字母/数字」的连续字符压成一个 `-` → 去掉首尾 `-` → 空则退化成 `section`。同一文档内标题重名时，第二个起追加 `-2`、`-3`。

这个字符串在三个地方必须完全一致，否则阅读器会跳错位置：

| 位置 | 形态 |
| --- | --- |
| `corpus.json` | `chunk.anchor` |
| 渲染后的 HTML | `<section class="rag-section" id="startos-是控制权边界">` |
| 检索命中 | `hit.anchor` → 引用 `citation.anchor` |

`tests/rag-integration.test.mjs` 里有两条测试专盯这件事：每个 `chunk.anchor` 都必须在 `renderArticle` 的输出里找到同名 `id`，且必须等于按 `slugify` 规则算出来的值。改标题就会改锚点，这是设计使然——**不要手写 anchor，它总是算出来的**。

> 阅读器把 `id` 放在包裹小节的 `.rag-section` 上（不是 `<h2>`），所以定位时查的是容器。
> 高亮样式也作用在容器上，再由容器传给标题的左侧竖条。

## 九大分类

| id | 名称 | 文档数 |
| --- | --- | --- |
| `startup` | 启动与 EcuM | 5 |
| `uds` | 诊断与刷写 | 5 |
| `communication` | 通信与网络管理 | 5 |
| `storage` | 存储 NvM/Fee | 5 |
| `os` | OS 与多核调度 | 5 |
| `xcp` | XCP 标定 | 4 |
| `system` | 系统架构与 CDD | 4 |
| `methodology` | 方法论与工程实践 | 4 |
| `boundary` | 边界与常见误解 | 4 |

`boundary` 这一类是刻意保留的：澄清误解和陈述事实同等重要。

## 文章格式

一个分册 = 一个分类，里面放若干**文档**；一个文档 = 一个 `#` 标题 + 导语 + 若干 `##` 小节。
元数据用 HTML 注释承载，**渲染时不可见**。

```markdown
<!-- 分类 startup「启动与 EcuM」· 原创教学源文本 ……（文件级说明，可选） -->

# EcuM Flexible 启动顺序

<!-- doc: startup-ecum-flexible -->
<!-- tags: EcuM, StartOS, BswM, 启动 -->
<!-- summary: 从复位到 StartOS 前后，EcuM 如何组织初始化块、配置选择与 post-OS 骨架。 -->
<!-- refs: src-ecum, src-mode-guide -->

这篇文档沿一次冷启动走一遍主线（1–3 句导语，是正文不是元数据）。

## EcuM_Init 是上电后的第一个 BSW 入口

<!-- keywords: EcuM_Init, StartOS, InitBlock, Cat2 -->

复位向量完成最小 C 环境之后，控制权交给 EcuM_Init()。……（正文段落）

## InitZero 不使用 Post-Build 配置

<!-- keywords: InitZero, InitOne, Post-Build, 一致性校验 -->

启动分为 InitZero 与 InitOne 两段。……
```

规则：

1. **`# ` 一级标题 = 一篇文档。** 标题下面是四行元数据注释：`doc`（文档 id）、`tags`、`summary`、`refs`。
   每个文件至少 2 篇文档。
2. **`## ` 二级标题 = 一个 chunk 小节。** `<!-- keywords: ... -->` 紧跟在标题后面，逗号（或 `、`）分隔。
   每篇文档 2–8 个小节，**小节顺序就是 chunk 顺序**，chunk id 为 `<docId>#<n>`，n 从 1 起。
3. **标题与第一个 `##` 之间写 1–3 句导语。** 导语是正文，会渲染出来，不要写元数据。
   文件开头的第一行可以放一条文件级注释，它不会被当成某篇文档的导语。
4. **正文段落之间必须空一行。** 可以用行内 `` `代码` ``、**加粗**、`-` 列表、`1.` 列表、`> 引用`、
   `---` 分隔线，以及 `#`/`##` 之外的 `###` 三级标题（它留在小节正文里）。
5. **正文里不要再出现 `@@DOC` / `@@CHUNK` / `@@END`。** 那是已经被淘汰的构建格式。
6. **正文是给人读的连贯中文。** 事实、语气与「教学级行为仿真、非量产」的边界必须保留；
   可以重排版、拆段、加列表，但**不要丢信息，也不要编造新事实**。
7. **锚点由标题自动生成**（见下），不需要手写。同一文档内出现重复标题时，
   第 2 个锚点追加 `-2`，第 3 个追加 `-3`。
8. **`refs` 只能引用 `sources` 里已声明的 id。** 来源清单维护在 `scripts/build-corpus.mjs` 的
   `SOURCES` 里（顶层 `categories` 同理），新增来源请改那里，而不是手改 `corpus.json`。
9. **标识符保持原样**（`EcuM_StartupTwo()`、`0x27`、`P2*`）。
   注意 `*` 会被当作 Markdown 强调标记：同一段落里出现**成对的 `*`** 会在纯文本化时被剥掉，
   所以一个段落里只写一处 `P2*` 这类带星号的参数名。
10. **原创表述，不整段照抄 `docs/`。** 守住诚实边界：不得声称本实验室能生成 ARXML、
    能烧录硬件、能做功能安全认证。

## 锚点规则

锚点由标题算出，构建脚本（A1）与阅读器（A2）用**同一个函数**，所以 `corpus.json` 里的 `anchor`
必然等于文章渲染出的 `<h2 id="...">`：

```js
export function slugify(heading) {
  return String(heading)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')   // 非字母数字 → 连字符
    .replace(/^-+|-+$/g, '')            // 去掉首尾连字符
    || 'section';                        // 全是符号时的兜底
}
```

例如 `## StartOS 是控制权边界` → `startos-是控制权边界`。

## 改完文章之后

```powershell
node scripts\build-corpus.mjs      # 1. 重建 knowledge/corpus.json
node scripts\validate-corpus.mjs   # 2. 校验契约，必须看到 "Corpus validation: PASS"
node scripts\run-tests.mjs         # 3. 全量测试（含文章↔语料一致性）
```

`build-corpus.mjs` 会打印文档数、chunk 数与每个分类的分布，用来和上面的「规模」数字对账。

## 校验

```powershell
node scripts\validate-corpus.mjs
# 等价于 npm run check:corpus
```

会检查：JSON 合法性、BOM、chunk id 唯一性与前缀、文本长度区间、keyword 真实性、
`refs` 有效性、分类覆盖、文件体积、`<script>` 注入痕迹。

另外 `tests/rag-markdown.test.mjs` 里有一条**同步契约**测试：每个 `chunk.text` 必须是
`toPlainText()` 的不动点（即索引文本与文章正文逐字一致）；`tests/rag.test.mjs` 会用真实语料
建一次索引。两者都在 `node scripts\run-tests.mjs` 里跑。

## 为什么这些内容值得收进来

语料刻意补足了实验室**看得见但说不透**的部分：

- EcuM **Fixed 与 Flexible** 的真实差异（界面上只有教学阶段标签）
- BswM 的**规则求值与动作列表**（界面上只看到模式跳变的结果）
- DEM 的**DTC 状态字节**八位含义
- NvM 的**冗余块与失败回退策略**
- COM / PduR / CanIf / CanTp 的**PDU 路由路径**
- OS 的**时间保护**与 OS-Application 隔离
- XCP 的 **A2L 与 SHORT_UPLOAD**
- E2E / WdgM 与 **ISO 26262 的关系边界**
- ARXML、ECU Extract、配置变体与 ASPICE
- 一整类**常见误解**（把教学标签当规范、把 Flexible 当 Fixed、以为请求等于完成……）

## 边界

- 这里的文本是**原创教学说明**，语义参考 AUTOSAR R24-11 规范，但**不是规范原文**，不能作为一致性测试或合规依据。
- 需要权威结论时，请查 [`docs/sources.md`](../docs/sources.md) 中列出的官方文档与章节。
- 检索原理与算法见 [`docs/knowledge-rag.md`](../docs/knowledge-rag.md)。
