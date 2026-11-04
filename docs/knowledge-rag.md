# 知识库检索（RAG）

第 8 个工作区。用一套**在浏览器里跑的检索式 RAG**，把本实验室涉及的概念、边界与常见误解变成可检索、可溯源的知识条目。

它解决一个很具体的问题：实验室能演示「NvM 请求受理不等于已写入」，但学习者常常还需要快速确认「EcuM Fixed 和 Flexible 到底差在哪」「CAN FD 会不会省掉 ISO-TP 流控」。这些答案原本散在 `docs/` 的几篇长文里，翻找成本高。知识库把它们切成小块并建立索引，用一条中文查询就能定位到具体段落，还给出处。

## 为什么是「检索式」RAG，而不是神经嵌入

这是一个明确的设计取舍，不是能力缺失：

| 方案 | 需要什么 | 本项目的约束 |
| --- | --- | --- |
| 神经嵌入 / 向量库 | 模型权重、推理运行时、通常还有 embedding API | 违反「零第三方依赖、离线运行」 |
| 云端大模型问答 | 网络、API Key、把内容上传出去 | 违反「所有数据留在本机」 |
| **检索式 RAG（本项目）** | 只要一段确定性的 JavaScript | 满足全部约束 |

所以这里做的是**检索 + 抽取式合成**：

1. 用 BM25 变体从语料里检索最相关的若干片段；
2. 从这些片段里**原样抽取**句子，拼成答案，并给每句标注引用编号。

关键在于：**答案里的每一句都来自语料原文，系统不会生成语料之外的事实。** 这与生成式大模型的行为有本质区别——它不会"编"，但它也不会推理、不会总结你没写进去的东西。当检索不到相关内容时，它诚实地告诉你覆盖率低，而不是硬编一个答案。

## 语料库规范

语料分**两层**，这点很关键：

```
knowledge/
├── 01-startup.md        # ← 真源：人手写的可读文章（9 个分册）
├── 02-uds.md
├── ...
├── corpus.json          # ← 派生产物：由上面的 .md 生成，不要手改
└── README.md            # 语料编写规范
```

`corpus.json` 是**从文章派生的**（41 个文档 / 208 个 chunk），由 [`scripts/build-corpus.mjs`](../scripts/build-corpus.mjs) 解析 `knowledge/*.md` 生成：

```powershell
node scripts/build-corpus.mjs      # 重建 corpus.json
node scripts/validate-corpus.mjs   # 校验结构
```

浏览器只 `fetch` `corpus.json`，运行时不需要任何构建步骤；构建只是**开发期**把文章编译成索引输入。

每篇文章的格式：

```markdown
# 文章标题

<!-- doc: startup-ecum-flexible -->
<!-- tags: EcuM, 启动, 状态机 -->
<!-- summary: 一次冷启动的完整主线。 -->
<!-- refs: AUTOSAR SWS ECU Manager -->

一两句导语，说明这篇要解决什么问题。

## EcuM_Init 是上电后的第一个 BSW 入口

<!-- keywords: EcuM_Init, BSW, 复位向量 -->

正文段落……

## StartOS 是控制权边界

<!-- keywords: StartOS, 控制权, pre-OS, post-OS -->

正文段落……
```

结构要点（完整字段说明见 [knowledge/README.md](../knowledge/README.md)）：

- **document**：一篇有主题的文档，含 `title` / `category` / `tags` / `summary` / `source` / `refs`
- **chunk**：文档下的一个小节，含 `id` / `heading` / `text` / `keywords` / **`anchor`**，是检索的最小单位
- **anchor**：由小节标题经 `slugify()` 算出，**同时**是该小节在渲染后 HTML 里的 `id`。阅读器靠它精确定位，所以它是 corpus 与文章之间唯一的硬约定
- **category**：九大分类（启动、诊断、通信、存储、OS、XCP、系统、方法论、边界），每类 ≥2 个文档

## 检索算法

全部实现在 [`src/rag/`](../src/rag/)，纯函数、无副作用、可在 Node 里直接测试。

### 1. 分词（`tokenize.mjs`）

AUTOSAR 语料是中英混排，标准空格分词对中文完全无效，所以分两路：

- **中文**：单字 + 相邻二元组（bigram）。「启动流程」→ `启` `动` `流` `程` `启动` `动流` `流程`。
  二元组比单字精确得多（`启` 会匹配到「触发」），又比词典分词简单可靠、无需维护词表。
- **英文 / 标识符**：整词小写，并拆出下划线与驼峰子词。
  `EcuM_StartupTwo` → `ecum_startuptwo` `ecum` `startup` `two`。

同时做归一化：全角转半角、统一小写、压缩空白。

### 2. 同义词扩展（`synonyms.mjs`）

学习者不会只用一种说法提问。`synonyms.mjs` 维护 40 组以上中英术语映射，查询时把每个 token 扩展到同义组：

```
标定 ↔ calibration ↔ 校准
刷写 ↔ flashing ↔ 编程
休眠 ↔ sleep ↔ BusSleep
```

扩展出的 token 权重是原词的 **0.55 倍**——它帮助召回，但不该压过用户真正打的词。

### 3. BM25 打分（`index.mjs`）

经典 BM25 变体，`k1 = 1.4`、`b = 0.72`。不同字段给不同权重：文档标题、`heading`、`keywords`、`tags` 都高于正文，因为它们信息密度更高。

排序保证**确定性**：分数相同时按 `chunkId` 升序，同一 corpus + 同一查询永远得到完全相同的顺序。这是可回归测试的前提。

每次命中还会算出 `highlights` 区间——正文里命中的真实字符偏移量（有序、不重叠、最多 8 段），交给 UI 做高亮。

### 4. 抽取式合成（`answer.mjs`）

1. 把每个命中片段切成句子（按 `。！？；` 与英文句点）；
2. 按 `命中分数 × 句子与查询的词重合度` 排序；
3. 去重（相似度 > 0.8 视为重复），最多取 6 句；
4. 给每句标注来源，生成 `[1] [2]` 引用列表。

同时给出 `coverage` 分级：

| coverage | 含义 | 该怎么读 |
| --- | --- | --- |
| `high` | 最相关片段分数充足 | 语料里有直接答案，看引用 |
| `medium` | 找到了，但相关性一般 | 答案可能只覆盖问题的一部分 |
| `low` | 勉强相关 | 建议换关键词，或直接看命中列表 |
| `none` | 没有命中 | 语料里没有这个概念，不要相信任何"答案" |

## 如何新增一条知识

1. 在对应的 `knowledge/*.md` 里加一个 `## 小节`，紧跟着写一行 `<!-- keywords: ... -->`；
2. 重建并校验：

```powershell
node scripts/build-corpus.mjs
node scripts/validate-corpus.mjs
```

3. 刷新浏览器。

**不要直接改 `corpus.json`**：它是派生产物，下次 build 会被覆盖。

校验会检查 chunk id 唯一性、文本长度（下限 90 字符）、`keywords` 是否真的出现在标题或正文里、每个分类的文档数、文件体积等。**`keywords` 必须真实出现**——写一个语料里不存在的关键词，那个权重就永远不会生效，是纯粹的死重。

> 文本下限是 90 而不是更长，是有意的：短的定义型小节（「P2 与 P2* 的区别」这类）检索精度反而更高。但低于 90 字符通常意味着这个小节没写清，校验会拦下来。

## 阅读原文：应用内文章阅读器

「查看原文」**不是**打开一个裸 `.md` 链接，而是在右侧滑出面板里读文章，并且**直接定位到你点了的那一小节**。

实现分三层：

| 文件 | 职责 |
| --- | --- |
| [`src/rag/markdown.mjs`](../src/rag/markdown.mjs) | 零依赖 Markdown 渲染器：`parseInline` 一份行内解析，`renderInline` 出 HTML、`stripInlineMarkers` 出纯文本，两条路径共用同一判定 |
| [`src/rag/article.mjs`](../src/rag/article.mjs) | `parseArticle` 解析文章元数据与各小节，`renderArticle` 输出带 `id="<anchor>"` 的 HTML，`findSection` 按锚点找回小节 |
| [`src/rag-reader.mjs`](../src/rag-reader.mjs) | `ArticleReader` 面板：滑出、目录、锚点定位、高亮、键盘操作 |

交互细节：

- **触发点**：检索结果卡片上的「查看原文」，以及答案引用列表里的每一条（整条可点）。有阅读器时它们都是 `<button data-rag-action="open-source">`，带上 `data-rag-path` / `data-rag-anchor` / `data-rag-chunk`；没注入阅读器时退回成新标签打开 `.md` 的 `<a>` 兜底链接。
- **定位**：直接用 `querySelector('[id="<anchor>"]')` 找小节容器（`renderArticle` 把 id 放在 `.rag-section` 上），瞬间滚到容器顶部——**不是平滑动画**，因为用户的意图是「带我到那一段」，动画反而让人以为没生效。
- **高亮**：目标小节给琥珀色左竖条 + 淡黄渐变底，约 2.4 秒后淡出，不干扰持续阅读。
- **目录**：左侧列出全文所有小节（跨文档时按文档分组），当前小节高亮；点击是即时滚动 + 平滑动画。
- **兜底**：面板顶部保留「原始 Markdown ↗」链接（窄屏收成 `↗` 图标），随时能看未渲染的源文件。
- **键盘**：`Esc` 关闭；关闭后焦点归还给触发它的那个按钮，不会把人丢回页面顶部。
- 加载失败有错误态与「重试」按钮，不会静默失败或抛未捕获异常。

一个容易踩的布局坑记录在这里：面板正文容器是 grid 布局，`grid-template-rows` **必须**显式写成 `minmax(0, 1fr)`。隐式 `auto` 行会让滚动容器拿不到确定高度，`overflow-y: auto` 永不生效——长文会被裁掉且无法滚动。这个问题单元测试查不出来，只有真浏览器会暴露。

## 界面

`src/rag-ui.mjs` + `src/rag.css`，构造为 `RagWorkspaceUi`：

- 顶部搜索框（支持 `/` 聚焦）、分类筛选条、索引状态（chunk 数 / 构建耗时）
- 左栏：结果卡片，带高亮片段、文档标题、标题层级、命中词
- 右栏：合成答案（带编号引用）、相关术语、追问建议、边界提醒
- 四种状态都有实现：加载中 / 空查询引导 / 无结果 / 加载失败（可重试）

界面不会直接 `innerHTML =` 整段重建，而是复用 [`src/dom-update.mjs`](../src/dom-update.mjs) 做最小化 DOM 补丁——否则你正在输入的搜索框会在每次重绘时丢焦点。语料文本一律 HTML 转义后才插入。

## 性能实测

在 208 chunk 的语料上（Node 24，单核）：

| 操作 | 耗时 |
| --- | --- |
| 索引构建 | ~29 ms |
| 单次查询（含答案合成） | 0.5–4 ms |

首次进入工作区才异步加载，不拖慢启动动画的首屏。文章阅读器更晚：只有你点「查看原文」时才会去 `fetch` 那一个 `.md` 文件，纯粹打开工作区不多花一次请求。

## 验证

三层，从便宜到贵：

```powershell
node scripts/check.mjs            # 语法与静态检查（进程内，不 spawn）
node scripts/validate-corpus.mjs  # 语料结构与锚点一致性
node scripts/run-tests.mjs        # 单元 + 集成测试
node scripts/browser-verify.mjs   # 真浏览器：截图 + DOM 断言
```

其中 `tests/rag-integration.test.mjs` 专门盯**接缝**：引擎给出的每个命中，其 `anchor` 必须等于该 chunk 在 corpus 里的 anchor；corpus 里每个 anchor 必须能在 `renderArticle` 的输出里找到同名 `id`。这条链断了，阅读器就会跳错地方——单元测试各自都是绿的，只有拼起来才露出来。

浏览器验证需要注意：Chrome 在 Windows 上用命名管道做 Mojo IPC，受限沙箱下会直接 FATAL（`mojo platform_channel.cc:112 拒绝访问 (0x5)`），必须放宽权限运行。细节见 [browser-verification.md](browser-verification.md)。

## 诚实边界

这一点必须写清楚，否则会误导：

- **这是检索，不是理解。** 系统不理解 AUTOSAR，它计算词频与共现。换个说法提问可能就检索不到，这时的正确反应是换关键词，而不是相信一个低覆盖率的答案。
- **答案不会超出语料。** 好处是不会编造；代价是语料没写的，它也无能为力。
- **语料不是规范的替代品。** `knowledge/` 是原创教学文本，语义参考 AUTOSAR R24-11，但它是**二次组织**的表述，不是规范原文，也不能作为一致性或合规依据。要确认权威结论，请查 [docs/sources.md](sources.md) 里列出的官方文档。
- **没有向量语义检索。** 同义词靠手工词表，同义但不在表内的说法检索不到。
- **不联网、不上传。** 语料随仓库分发，检索完全在本机浏览器内存里完成。
- **阅读器只是渲染器，不是编辑器。** 它把 `knowledge/*.md` 渲染成可读页面并支持定位，但不提供编辑、批注或版本对比。要改内容请改 `.md` 并重新 build。

想理解依赖关系与调试思路，这个知识库够用；想据此判断某个量产项目的实现是否正确，请回到规范与实测。
