# 真实浏览器验证

> 对应契约：`.runtime/reader-contract.md` §8。
> 工具：`scripts/browser-verify.mjs`（零第三方依赖）。
> 产物目录：`.runtime/shots/`（已 gitignore）。

---

## 1. 为什么还要一层「真实浏览器」验证

本项目的验证体系是**分层**的，每一层能证明的东西不一样，缺一层就会留下盲区：

| 层 | 入口 | 规模 | 能证明什么 | 证明不了什么 |
| --- | --- | --- | --- | --- |
| ① Node 单元测试 | `node scripts/run-tests.mjs` | 20 个文件 / 274 个用例 | 纯函数语义、状态机、BM25 打分、Markdown/Article 解析、锚点算法、`toPlainText` 与 corpus 的同步 | 界面到底长什么样 |
| ② DOM 桩集成测试 | 同上（`tests/*.test.mjs` 里手写的 DOM 桩） | 覆盖 `RagWorkspaceUi`、阅读器交互 | 事件绑定、状态流转、`updateHtml` 的渲染字符串是否正确 | 真实布局、真实 CSS、真实模块加载 |
| ③ 真实浏览器 | `node scripts/browser-verify.mjs` | 7~8 张截图 + 20 条 DOM/运行期断言 | 浏览器能不能**真的**把页面跑起来并画对 | 逐分支逻辑覆盖（那是 ①② 的活） |

第 ③ 层专门回答第 ①② 层天然答不了的问题：

1. **ES module 真的能加载吗**：`src/**` 无构建步骤、直接 `import`，任何路径/语法/CSP 问题只会在浏览器里炸。
2. **CSP 有没有误伤自己**：服务端下发 `script-src 'self'`，`server.mjs` 还带 COOP/CORP/XCTO `nosniff`。桩测试里根本没有"策略"这个概念。
3. **样式有没有塌**：网格折叠、`hidden` 属性失效、滑出面板盖住内容，只有渲染后才看得见。
4. **移动端溢不溢出**：390px 下 `document.scrollWidth > innerWidth` 就是横向滚动条，纯 JS 断言抓不到，必须真实布局。
5. **中文有没有变豆腐块**：字体族/编码问题只在真实渲染管线里出现。
6. **语料有没有把构建期标记漏到用户眼前**：`@@DOC` / `@@CHUNK` 出现在 DOM 里，说明渲染层漏了处理——这是本项目最初的"简陋根源"，值得专门盯住。
7. **知识库只有被点击后才挂载**：`app.mjs` 的 `renderKnowledge()` 在切到第 8 个工作区时才 `ragUi.mount()`。静态 HTML 里没有 `.rag-*`，所以**必须真的点一下**才能验证。

---

## 2. 为什么必须放宽沙箱权限（Windows 命名管道）

这不是"图省事"，而是 Chrome 在 Windows 上的进程模型决定的：

- Chrome 用 **Mojo** 做多进程通信，Windows 上的 Mojo 通道底层是**命名管道**；
- crashpad 崩溃收集器还要 `OpenProcess` 打开浏览器进程。

DSH 的受限沙箱（`workspace-write` / `read-only`）会**禁止进程打开命名管道**、也会挡住对其它进程的句柄操作。于是 Chrome 在启动阶段直接 FATAL，一个页面都渲染不出来：

```
[ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:431] OpenProcess: 拒绝访问。 (0x5)
[FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
[ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:145] crash server failed to launch, self-terminating
```

退出码是 `4294930433 (0xffff7001)`。

**结论**：运行本脚本的 shell 调用必须声明放宽权限：

```jsonc
// 工具调用参数（示例语义）
{
  "command": "node scripts/browser-verify.mjs",
  "sandbox_permissions": "danger-full-access",
  "justification": "Chrome headless 需要命名管道做 Mojo IPC，受限沙箱下会 FATAL"
}
```

补充说明：

- **只放宽"运行浏览器"这一件事**。脚本本身仍然只读项目文件、只写 `.runtime/shots/`、只监听 `127.0.0.1` 的随机端口。
- 用户已授权做浏览器验证；这只为渲染验证服务，不改变项目任何代码。
- 若当前会话不允许放宽权限，脚本会**明确失败而不是假装通过**（退出码 2，见 §5）。

---

## 3. 怎么跑

### 3.1 最常用

```powershell
chcp 65001 > $null; $OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
node scripts\browser-verify.mjs
```

脚本自己用 `createStaticServer` 起一个**随机端口**的本地服务（复用 `server.mjs`，用完关闭），然后把 Chrome 指过去。

### 3.2 指定已有服务 / 输出目录 / 浏览器

```powershell
# 已经开着 node server.mjs（默认 4173）
node scripts\browser-verify.mjs --url http://127.0.0.1:4173/

# 截图存到别处
node scripts\browser-verify.mjs --out .runtime\shots-2026-11-04

# 显式指定浏览器（PATH 外的安装位置 / Edge）
node scripts\browser-verify.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

### 3.3 全部参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--url <url>` | 自起随机端口 | 验证一个已经开着的服务 |
| `--out <dir>` | `.runtime/shots` | 截图、DOM 快照、Chrome 日志 |
| `--chrome <path>` | 自动探测 | Chrome/Edge 可执行文件 |
| `--timeout <ms>` | `30000` | 单步等待上限 |
| `--mode auto\|cdp\|cli` | `auto` | `auto`=优先 CDP 交互；`cli`=只截首屏的降级模式 |
| `--strict` | 关 | 把 WARN 升级成 FAIL（控制台报错、语料标记泄漏等） |
| `--keep-profile` | 关 | 保留临时 Chrome profile，排障用 |
| `--self-check` | — | **不启动浏览器**，自检脚本自身的逻辑（见 §7） |
| `--list` | — | 只打印会用到的截图用例与断言清单 |
| `--help` | — | 帮助 |

### 3.4 两个零依赖的实现细节（改动时请勿破坏）

1. **`spawn` 必须 `stdio: 'ignore'`**（或重定向到**文件描述符**）。用 `'pipe'` 抓子进程输出在受限沙箱下会 `EPERM`。
   脚本因此把 Chrome 的 stderr 写进 `.runtime/shots/chrome-stderr.log`（文件描述符不是管道），用于失败诊断。
2. **交互走 CDP**：`--remote-debugging-port=0` + 读 `<profile>/DevToolsActivePort` + Node **内置全局 WebSocket**（Node ≥ 22）连 `ws://127.0.0.1:<port>/...`。这样"切工作区 / 输入检索词 / 点开阅读器"都是真实用户操作，且不引入 Puppeteer。

---

## 4. 产出物在哪、长什么样

全部落在 `--out`（默认 `.runtime/shots/`，**已 gitignore**，不会污染仓库）：

| 文件 | 内容 |
| --- | --- |
| `01-desktop-startup.png` | 桌面 1440×1000 启动流程首页（**整页**） |
| `02-desktop-knowledge.png` | 桌面，第 8 个工作区「知识库检索」空态（视口） |
| `03-desktop-results.png` | 桌面，检索「EcuM 启动顺序」后的结果态（**整页**） |
| `04-desktop-reader.png` | 桌面，阅读器打开态（未集成则不生成，记 SKIP） |
| `05-mobile-startup.png` | 移动 390×844 启动流程首页（**整页**） |
| `06-mobile-knowledge.png` | 移动，知识库空态 |
| `07-mobile-results.png` | 移动，知识库结果态 |
| `dom-shell.html` | 桌面首页 DOM 快照（`--dump-dom` 等价物） |
| `dom-knowledge.html` | 切到知识库后的 DOM 快照 |
| `dom-results.html` | 检索后的 DOM 快照 |
| `chrome.log` / `chrome-stderr.log` | Chrome 自身日志，失败排障用 |
| `.chrome-profile/` | 临时 profile，正常退出后自动删除（`--keep-profile` 可保留） |

截图命名是 `序号-视口-状态.png`，序号按实际生成顺序递增。

**尺寸是怎么核对的**：脚本不接受"文件非空就算成功"。它直接解析 PNG 的 `IHDR` 读真实像素宽高（`readPngSize`），
并固定 `deviceScaleFactor = 1`，所以 PNG 像素尺寸应当等于逻辑视口尺寸——报告里的 `1440×1000` / `390×844` 可以和文件对上。

### 自动化脚本的截图清单（每个视口一套）

- 桌面 1440×1000：启动流程首页（整页）、知识库空态、检索结果态（整页）、阅读器（可选）
- 移动 390×844：启动流程首页（整页）、知识库空态、检索结果态

---

## 5. 怎么解读结果

### 5.1 退出码

| 退出码 | 含义 | 该怎么办 |
| --- | --- | --- |
| `0` | PASS；或本机没有 Chrome/Edge 而**优雅跳过**（打印 SKIP 提示） | 跳过时：装浏览器或 `--chrome` 指定 |
| `1` | 验证失败：截图缺失/尺寸异常/DOM 断言 FAIL/未捕获异常 | 看 `▶ DOM 断言` 段落哪条 FAIL |
| `2` | 找到了浏览器但**起不来**（沙箱、profile 锁、端口） | 先看 `chrome-stderr.log` 末尾；多半是 §2 的权限问题 |

> 注意区分：`0 + SKIP` 是"环境里没有浏览器"，不是"验证通过"。判定 CI 绿之前请看输出里的 `SKIP` 字样。

### 5.2 每条断言的状态语义

| 状态 | 含义 | 计入失败吗 |
| --- | --- | --- |
| `PASS` | 通过 | 否 |
| `FAIL` | 明确不满足要求 | **是**（退出码 1） |
| `WARN` | 可疑但可能是进行中的中间态（如语料标记泄漏、控制台报错） | 否，除非 `--strict` |
| `SKIP` | 前置条件不存在（阅读器还没集成、CLI 模式点不动页面） | 否 |

### 5.3 断言清单

外壳（首页 DOM）：

- `shell.lab-switcher`：存在 `#lab-switcher`
- `shell.tabs-8`：`.lab-switcher-tab` 恰好 8 个
- `shell.tab-knowledge`：第 8 个 tab 是 `data-lab-view="knowledge"`
- `shell.knowledge-content`：存在知识库容器 `#knowledge-content`

知识库（切到第 8 个工作区后）：

- `knowledge.rag-nodes`：`.rag-*` 类名节点数 > 0（**证明知识库真的渲染了**，不是空壳）
- `knowledge.workspace`：`.rag-workspace` + `#rag-search-form` 都在
- `knowledge.index-status`：索引状态 `ready`（`error` → FAIL，超时 → WARN）

检索（真实提交一次查询）：

- `search.interaction`：表单确实被提交成功
- `search.cards`：`.rag-card` 命中数 > 0
- `search.answer-panel`：答案/引用面板已渲染（`WARN` 级，允许进行中的调整）

安全：

- `security.no-script-injection`：DOM 里的 `<script>` 数量不超过 `index.html` 的基准数（1），**三份 DOM 都比对**
- `security.no-inline-handler`：没有 `onerror=` / `onclick=` 之类内联处理器
- `security.no-javascript-url`：没有 `javascript:` 伪协议
- `content.no-raw-cursor-markers`：没有 `@@DOC` / `@@CHUNK` 漏到界面（`WARN` 级）

运行期：

- `runtime.no-exceptions`：没有未捕获异常
- `runtime.no-csp-violation`：没有 CSP 违规
- `runtime.console-clean`：无 `console.error`（`WARN`，`--strict` 下 FAIL）
- `runtime.no-failed-assets`：`.mjs/.js/.css/.json` 没有被 4xx/5xx 打回

布局与阅读器：

- `layout.mobile-no-overflow`：390px 下 `scrollWidth <= innerWidth + 1`
- `reader.panel`：点开阅读器后容器出现且正文有内容（未集成 → SKIP）

### 5.4 输出样例（结构）

```
AUTOSAR 启动实验室 · 真实浏览器验证
  Node      : v24.17.0 (win32/x64)
  服务地址  : http://127.0.0.1:57539/
  浏览器    : C:\Program Files\Google\Chrome\Application\chrome.exe
  模式      : auto
  输出目录  : ...\.runtime\shots
  注入基准  : index.html 里 <script> 共 1 个

▶ 截图
  PASS  01-desktop-startup.png              1440×4820   318.2 KB  启动流程首页（1440×1000）
  PASS  02-desktop-knowledge.png            1440×1000   141.7 KB  第 8 个工作区「知识库检索」空态（1440×1000）
  ...

▶ DOM 断言
  PASS  shell.tabs-8                        .lab-switcher-tab 数量为 8  — 实际 8 个
  ...

▶ 运行期观测
  INFO  未捕获异常 0 / console.error 0 / CSP 违规 0 / 失败请求 0

结果: PASS（截图 7 张，断言 14 PASS / 0 FAIL / 0 WARN / 1 SKIP）
```

---

## 6. 已知限制（诚实清单）

1. **受限沙箱下 Chrome 一定起不来**。这不是脚本缺陷：脚本会给出退出码 2 + 完整 stderr 证据。必须在放宽权限的环境跑。
2. **交互能力依赖 Node ≥ 22**（全局 `WebSocket`）。老 Node 请用 `--mode cli`：只截两个首屏 + 抓首屏 DOM，知识库/检索断言会记 SKIP。
3. **阅读器没集成时 `reader.panel` 记 SKIP**：A3 的 `ArticleReader` 与 Lead 的集成落地后自动变 PASS，不需要改脚本——脚本按多组候选选择器探测：
   - 触发点：`[data-rag-action="open-source"]`、`button.rag-source`、`[data-rag-action="read"]`…
     （未注入 reader 时 `rag-ui` 退回裸链接 `<a class="rag-source" target="_blank">`，脚本**不会**去点它，否则会跳走）
   - 容器：`[data-rag-reader][data-open="true"]`、`.rag-reader-shell`、`.rag-reader-panel`、`#article-reader`、`dialog[open]`…
   - 判定条件是"**打开且非空**"：未打开时阅读器 shell 也在 DOM 里（`data-open="false"`），只看"容器存在"会误判。
4. **不做逐分支逻辑覆盖**。真实浏览器层只回答"能不能跑对、画对、没炸"；逻辑正确性交给 `tests/*.test.mjs`。
5. **截图不可能等同人工审美评审**。"布局好看"仍需人眼；脚本只保证结构/尺寸/溢出/注入这类可判定的性质。
6. **`--url` 指向外部服务时**，`index.html` 的 `<script>` 基准数仍从本仓库读取；跨仓库验证请确认两边一致。
7. **中文乱码 ≠ 文件损坏**：PowerShell 默认代码页可能把 UTF-8 显示成乱码，`chcp 65001` 后再看。

---

## 7. `--self-check`：没有浏览器时的自证

没有浏览器环境（或想快速确认脚本自身没写坏）时：

```powershell
node scripts\browser-verify.mjs --self-check
```

它**完全不启动 Chrome**，检查 6 类东西：

1. 参数解析（默认值、`--url/--out/--chrome/--strict/--timeout`、非法参数必须报错）
2. PNG 尺寸解析（自造 PNG 验证 `readPngSize`，非 PNG 不能被误判）
3. **断言引擎的正例与 14 组反例**：健康 DOM 必须全 PASS；把关键节点逐个破坏后，对应断言必须 FAIL
4. `createStaticServer` 复用：`/` 有 `lab-switcher`、CSP 含 `script-src 'self'`、`/knowledge/corpus.json` 结构合规（`documents[].chunks[]` 且字段齐全）
5. **CDP 客户端 + 截图管线**：用一个进程内假 CDP 服务器（手写 WebSocket 握手与帧编解码）跑通 `send` / 事件回调 / `evaluate` 异常映射 / 全页截图 / 落盘 / 尺寸解析
6. 浏览器探测：找不到不报错；`--chrome` 指向不存在路径时给出 `missing` 而不是抛异常

通过时退出码 `0`，任何一条 FAIL 退出码 `1`。这是把"我在没有浏览器的环境里声称脚本是对的"变成可复核证据的唯一办法。

---

## 8. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 退出码 2 + `platform_channel.cc:112` | 沙箱禁命名管道 | 放宽权限重跑（§2） |
| 退出码 2 + `DevToolsActivePort` 超时 | profile 被占用 / 启动极慢 | 加 `--keep-profile` 看现场；删 `.runtime/shots/.chrome-profile` 后重试 |
| `DevTools 端口 N 上找不到可用的 page target` | Chrome 起的不是普通 page target | 重跑；仍失败则用 `--mode cli` |
| 退出码 1 且 `knowledge.index-status` FAIL | `corpus.json` 加载失败 | `node scripts/build-corpus.mjs` + `node scripts/validate-corpus.mjs` |
| `knowledge.rag-nodes` FAIL | 切到知识库后 `.rag-*` 没渲染 | 看 `dom-knowledge.html` 与浏览器控制台；通常是 `rag-ui.mjs` 抛错 |
| `search.cards` FAIL | 检索无命中 | 看 `dom-results.html`；确认语料里确实有该关键词 |
| `layout.mobile-no-overflow` FAIL | 390px 横向溢出 | 用 `05-mobile-*.png` 定位是哪个容器固定宽度 |
| `security.no-script-injection` FAIL | 有未转义文本进了 DOM | 高危：查渲染路径是否绕过 `esc()`/`renderMarkdown` |
| 截图是纯白 | 页面在 `--virtual-time-budget` 内没画完 | 提高 `--timeout`；检查控制台异常 |

---

## 9. 与契约 §8 的对应

| 契约要求 | 实现 |
| --- | --- |
| 启动本地静态服务（复用 `createStaticServer`，随机端口）或 `--url` | `main()` → `createStaticServer({root, port: 0}).listen(0)`，`finally` 中 `close()` |
| `--screenshot` 截桌面 1440×1000 与移动 390×844 | `VIEWPORTS` + `Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot`（整页用 `captureBeyondViewport` + `cssContentSize`） |
| 逐个工作区切换并截图（至少 启动流程 / 知识库 / 检索结果 / 阅读器） | `SCENARIOS`；切工作区 = 真实 `tab.click()`；检索 = 真实 `input` + `submit` 事件 |
| `--dump-dom` 抓 DOM 并断言（8 个 tab、`#knowledge-content`、`.rag-*`、阅读器容器、无注入） | 三份 DOM 快照 + `runDomAssertions`（20 条） |
| 收集失败信息并以退出码反映 | `PASS/FAIL/WARN/SKIP` 汇总 + 退出码 0/1/2 |
| 截图写进 `.runtime/shots/` | 默认 `--out`，已 gitignore |
| 允许 `--virtual-time-budget` | CDP 模式用显式轮询等待（比固定预算更稳）；CLI 模式用 `--virtual-time-budget=4000` |
| 零依赖、不 spawn node 子进程、Chrome 用 `stdio: 'ignore'` | 仅 spawn Chrome；stdio 为 `ignore` 或文件描述符 |

---

## 10. 一句话总结

`tests/*.test.mjs` 保证**逻辑**对，`scripts/browser-verify.mjs` 保证**用户看到的**对。
两层都绿，才算这个实验室在这个沙箱里真的能跑。
