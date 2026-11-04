// 真实浏览器验证脚手架（A4）。
//
// 为什么需要它：
//   `scripts/run-tests.mjs` 与 `tests/*.test.mjs` 只能覆盖 Node 层逻辑和手写 DOM 桩；
//   它们无法证明 CSS 布局没塌、ES module 在真实浏览器里能加载、CSP 没把脚本杀掉、
//   中文没变成豆腐块、移动端没有水平溢出。这些只有真浏览器能证明。
//
// 实现约束（见 .runtime/reader-contract.md §8）：
//   1. 零第三方依赖：只用 node: 内置模块 + createStaticServer（../server.mjs）。
//   2. spawn Chrome 时必须 `stdio: 'ignore'`；管道 stdio 在受限沙箱下会 EPERM。
//   3. 不自起 `node` 子进程；静态服务在本进程内起、用完关闭。
//   4. Chrome 用 `--headless=new`；交互（切工作区 / 检索 / 开阅读器）走 CDP
//      （Chrome DevTools Protocol）。Node >= 22 自带全局 WebSocket，所以仍是零依赖。
//
// 为什么需要放宽沙箱权限：
//   Chrome 在 Windows 上用**命名管道**做 Mojo 进程间通信。DSH 的受限沙箱禁止进程
//   打开命名管道，Chrome 于是在启动阶段 FATAL：
//     mojo\public\cpp\platform\platform_channel.cc:112 Check failed: 拒绝访问 (0x5)
//     crashpad_client_win.cc:431 OpenProcess: 拒绝访问 (0x5)
//   因此运行本脚本必须用 `sandbox_permissions: "danger-full-access"`。
//   脚本探测到这种情况会打印诊断并以退出码 2 结束，不会崩掉，也不会假装通过。
//
// 退出码：
//   0  验证通过（PASS），或环境里没有 Chrome/Edge 而优雅跳过（SKIP）
//   1  验证失败（截图缺失/尺寸异常/DOM 断言失败/未捕获异常）
//   2  找到了浏览器但启动不起来（沙箱限制、profile 锁、端口不通……）
//
// 用法：
//   node scripts/browser-verify.mjs                       # 自起随机端口服务 + 截图 + 断言
//   node scripts/browser-verify.mjs --url http://127.0.0.1:4173/
//   node scripts/browser-verify.mjs --out .runtime/shots --chrome "C:\...\chrome.exe"
//   node scripts/browser-verify.mjs --list                # 只看会跑哪些用例
//   node scripts/browser-verify.mjs --self-check          # 无浏览器自检（不启动 Chrome）
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants as zlibConstants, deflateSync } from "node:zlib";

import { createStaticServer } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const DEFAULT_OUT_DIR = path.join(".runtime", "shots");
const DEFAULT_TIMEOUT_MS = 30000;
const RENDER_BUDGET_MS = 4000;
// 检索用例：用文档里反复出现的关键词，保证 BM25 一定有命中。
const SAMPLE_QUERY = "EcuM 启动顺序";

// 桌面 / 移动两套视口。deviceScaleFactor 固定 1，这样 PNG 像素尺寸 == 逻辑尺寸，
// 报告里的「1440×1000」「390×844」就能和截图文件直接对上，不会被 DPR 放大两倍。
const VIEWPORTS = {
  desktop: { width: 1440, height: 1000, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};

// 每个视口下依次执行的截图用例（同一个视口内状态是累积的）。
const SCENARIOS = [
  { id: "startup", state: "startup", label: "启动流程首页", fullPage: true },
  {
    id: "knowledge",
    state: "knowledge",
    label: "第 8 个工作区「知识库检索」空态",
    fullPage: false,
  },
  {
    id: "results",
    state: "results",
    label: `知识库检索结果态（“${SAMPLE_QUERY}”）`,
    fullPage: true,
  },
  {
    id: "reader",
    state: "reader",
    label: "阅读器打开态（未集成则跳过）",
    optional: true,
    fullPage: false,
  },
];

const CHROME_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ],
};

// 阅读器触发点 / 容器的候选选择器。阅读器由 A3 落地、Lead 集成，写法会演进，
// 所以不写死一个选择器，而是按"当前实现 → 兼容写法"的顺序探测；全都没有就记
// SKIP，而不是误报成 FAIL。
// 当前实现（src/rag-ui.mjs sourceControl()）：button.rag-source[data-rag-action="open-source"]
// 未注入 reader 时退回：<a class="rag-source" target="_blank">（不应被点击，否则会跳走）
const READER_TRIGGER_SELECTORS = [
  '[data-rag-action="open-source"]',
  '[data-rag-action="read"]',
  '[data-rag-action="open-reader"]',
  "[data-reader-open]",
  "button.rag-source.rag-source-inline",
  "button.rag-source",
  "button.rag-cite-open",
  ".rag-source[role='button']",
];

// 当前实现（src/rag-reader.mjs）：<div data-rag-reader><div class="rag-reader-shell" data-open="true">
// 未打开时 shell 也在 DOM 里但 data-open="false"，所以判定必须带"打开且非空"。
const READER_CONTAINER_SELECTORS = [
  '[data-rag-reader][data-open="true"]',
  ".rag-reader-shell[data-open='true']",
  "[data-rag-reader]",
  ".rag-reader-shell",
  ".rag-reader-panel",
  "[data-reader-root]",
  "#article-reader",
  ".article-reader",
  "[data-reader-panel]",
  "dialog[open]",
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 按显示宽度补空格（中文算 2 列），只为对齐好看。 */
function pad(text, width) {
  const value = String(text);
  let displayWidth = 0;
  for (const char of value) {
    displayWidth += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1;
  }
  return value + " ".repeat(Math.max(0, width - displayWidth));
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 轮询直到 fn() 返回真值；超时返回 null（不抛异常，方便上层分类处理）。 */
async function waitFor(fn, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch {
      // 页面可能还在导航，evaluate 会短暂失败，继续等。
    }
    await sleep(intervalMs);
  }
  return null;
}

/** 从 PNG 的 IHDR 读取真实像素尺寸，用来核对截图不是空的、也没被缩放。 */
function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
    return null;
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) {
      return null;
    }
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = {
    url: null,
    out: DEFAULT_OUT_DIR,
    chrome: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mode: "auto",
    strict: false,
    keepProfile: false,
    selfCheck: false,
    list: false,
    help: false,
  };
  const args = [...argv];

  while (args.length > 0) {
    const current = args.shift();

    switch (current) {
      case "--url": {
        const value = args.shift();
        if (!value) {
          throw new Error("Expected --url <http://host:port/>.");
        }
        let url;
        try {
          url = new URL(value);
        } catch {
          throw new Error(`Invalid --url value: ${value}`);
        }
        if (!/^https?:$/.test(url.protocol)) {
          throw new Error(`--url must be http(s): ${value}`);
        }
        parsed.url = url.href;
        break;
      }
      case "--out": {
        const value = args.shift();
        if (!value) {
          throw new Error("Expected --out <dir>.");
        }
        parsed.out = value;
        break;
      }
      case "--chrome": {
        const value = args.shift();
        if (!value) {
          throw new Error("Expected --chrome <path>.");
        }
        parsed.chrome = value;
        break;
      }
      case "--timeout": {
        const value = Number(args.shift());
        if (!Number.isFinite(value) || value < 1000) {
          throw new Error("Expected --timeout <ms>, >= 1000.");
        }
        parsed.timeoutMs = value;
        break;
      }
      case "--mode": {
        const value = args.shift();
        if (value !== "auto" && value !== "cdp" && value !== "cli") {
          throw new Error("Expected --mode auto|cdp|cli.");
        }
        parsed.mode = value;
        break;
      }
      case "--strict":
        parsed.strict = true;
        break;
      case "--keep-profile":
        parsed.keepProfile = true;
        break;
      case "--self-check":
        parsed.selfCheck = true;
        break;
      case "--list":
        parsed.list = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return parsed;
}

const HELP_TEXT = `真实浏览器验证（零依赖 headless Chrome）

用法:
  node scripts/browser-verify.mjs [选项]

选项:
  --url <url>       验证已开着的服务（缺省：本进程自起 createStaticServer，随机端口）
  --out <dir>       截图与 DOM 快照输出目录（默认 ${DEFAULT_OUT_DIR}）
  --chrome <path>   指定 Chrome/Edge 可执行文件（缺省自动探测常见安装路径）
  --timeout <ms>    单步等待上限（默认 ${DEFAULT_TIMEOUT_MS}）
  --mode <mode>     auto（默认，优先 CDP 交互）/ cdp / cli（只截首屏，能力受限）
  --strict          把 WARN 升级为 FAIL（控制台报错、未渲染的语料标记等）
  --keep-profile    保留临时 Chrome profile（排障用）
  --self-check      不启动浏览器，自检脚本自身的解析/断言/服务/CDP 客户端逻辑
  --list            打印将执行的截图用例与断言清单后退出
  --help            显示本帮助

退出码: 0 通过或跳过 / 1 验证失败 / 2 浏览器启动失败（多为沙箱限制）

注意: 本脚本会启动 Chrome，需要命名管道。受限沙箱下 Chrome 会 FATAL 于
      mojo platform_channel.cc，必须在放宽权限（danger-full-access）下运行。`;

// ---------------------------------------------------------------------------
// 浏览器探测
// ---------------------------------------------------------------------------

/**
 * 按 显式路径 → 常见安装路径 → LOCALAPPDATA → PATH 的顺序找浏览器。
 * 找不到不算错误：调用方会优雅跳过（退出码 0）。
 */
async function detectBrowser(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (await pathExists(resolved)) {
      return { path: resolved, source: "--chrome" };
    }
    return { path: null, source: "--chrome", missing: resolved };
  }

  for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
    if (await pathExists(candidate)) {
      return { path: candidate, source: "known-path" };
    }
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    for (const suffix of [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ]) {
      const candidate = path.join(process.env.LOCALAPPDATA, suffix);
      if (await pathExists(candidate)) {
        return { path: candidate, source: "localappdata" };
      }
    }
  }

  // 最后扫 PATH。这里刻意不调 `where`/`which`：受限沙箱下捕获子进程 stdout
  // 需要管道（会 EPERM），直接按 PATH 拼路径检查文件存在即可。
  const names =
    process.platform === "win32"
      ? ["chrome.exe", "msedge.exe"]
      : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
  const entries = (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await pathExists(candidate)) {
        return { path: candidate, source: "PATH" };
      }
    }
  }

  return { path: null, source: "auto" };
}

// ---------------------------------------------------------------------------
// CDP 客户端（Node 全局 WebSocket，零依赖）
// ---------------------------------------------------------------------------

class DevToolsSession {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", () => this.#handleClose());
    socket.addEventListener("error", () => this.#handleClose());
  }

  static async open(webSocketUrl, { timeoutMs = 15000 } = {}) {
    if (typeof WebSocket !== "function") {
      throw new Error(
        "本 Node 没有全局 WebSocket（需要 Node >= 22）。请升级 Node，或改用 --mode cli。",
      );
    }
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 CDP WebSocket 超时")), timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("连接 CDP WebSocket 失败"));
        },
        { once: true },
      );
    });
    return new DevToolsSession(socket);
  }

  get closed() {
    return this.#closed;
  }

  #handleClose() {
    this.#closed = true;
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`CDP 连接已关闭，${entry.method} 未完成`));
      this.#pending.delete(id);
    }
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const entry = this.#pending.get(message.id);
      if (!entry) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new Error(
            `CDP ${entry.method} 失败: ${message.error.message ?? JSON.stringify(message.error)}`,
          ),
        );
        return;
      }
      entry.resolve(message.result ?? {});
      return;
    }

    if (typeof message.method === "string") {
      const listeners = this.#listeners.get(message.method);
      if (!listeners) {
        return;
      }
      for (const listener of listeners) {
        try {
          listener(message.params ?? {});
        } catch {
          // 监听器自身抛错不能污染协议流。
        }
      }
    }
  }

  on(method, listener) {
    if (!this.#listeners.has(method)) {
      this.#listeners.set(method, new Set());
    }
    this.#listeners.get(method).add(listener);
    return () => this.#listeners.get(method)?.delete(listener);
  }

  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error(`CDP 连接已关闭，无法发送 ${method}`));
    }
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** 在页面里求值并取回 JSON 值；页面内抛错时转成可读异常。 */
  async evaluate(expression, { awaitPromise = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
        includeCommandLineAPI: false,
      },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(
        `页面内表达式抛错: ${details.exception?.description ?? details.text ?? "unknown"}`,
      );
    }
    return result.result?.value;
  }

  async close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP 连接已关闭"));
    }
    this.#pending.clear();
    try {
      this.#socket.close();
    } catch {
      // 已经断开就忽略。
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome 进程生命周期
// ---------------------------------------------------------------------------

function buildChromeArgs({ profileDir, windowSize, logFile }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--metrics-recording-only",
    "--mute-audio",
    `--user-data-dir=${profileDir}`,
    // 0 = 让 Chrome 自己挑端口，实际端口写进 <profile>/DevToolsActivePort。
    "--remote-debugging-port=0",
    `--window-size=${windowSize}`,
    `--log-file=${logFile}`,
    "about:blank",
  ];
}

async function readDevToolsPort(profileDir, { timeoutMs, child }) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  // 进程有可能在监听器挂上之前就退出了（沙箱直接拒绝启动），先看一眼。
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      ok: false,
      reason: `浏览器启动后立即退出（exit code ${child.exitCode ?? child.signalCode}）`,
    };
  }

  const found = await waitFor(
    async () => {
      if (exited) {
        return { exited: true, exitCode };
      }
      try {
        const raw = await readFile(portFile, "utf8");
        const port = Number(raw.split(/\r?\n/)[0]);
        return Number.isInteger(port) && port > 0 ? { port } : null;
      } catch {
        return null;
      }
    },
    { timeoutMs, intervalMs: 120 },
  );

  if (!found) {
    return { ok: false, reason: `等待 ${path.basename(portFile)} 超时（${timeoutMs}ms）` };
  }
  if (found.exited) {
    const code = found.exitCode;
    const hex = typeof code === "number" ? ` (0x${(code >>> 0).toString(16)})` : "";
    return { ok: false, reason: `浏览器启动后立即退出（exit code ${code}${hex}）` };
  }
  return { ok: true, port: found.port };
}

async function fetchJson(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findPageTarget(port, { timeoutMs = 15000 } = {}) {
  return waitFor(
    async () => {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (!Array.isArray(list)) {
        return null;
      }
      return (
        list.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ??
        list.find((item) => item.webSocketDebuggerUrl) ??
        null
      );
    },
    { timeoutMs, intervalMs: 120 },
  );
}

async function readLogTail(logFile, maxLines = 12) {
  try {
    const raw = await readFile(logFile, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 页面驱动
// ---------------------------------------------------------------------------

function createConsoleCollector() {
  const state = {
    exceptions: [],
    consoleErrors: [],
    consoleWarnings: [],
    cspViolations: [],
    failedRequests: [],
  };

  const recordCsp = (text, source) => {
    if (/content security policy|refused to (load|execute|apply)/i.test(text)) {
      state.cspViolations.push({ text: truncate(text, 300), source });
    }
  };

  const handlers = {
    "Runtime.exceptionThrown"(params) {
      const details = params.exceptionDetails ?? {};
      state.exceptions.push({
        text: truncate(
          details.exception?.description ?? details.text ?? "未捕获异常",
          400,
        ),
        url: details.url ?? "",
        line: details.lineNumber ?? null,
      });
    },
    "Runtime.consoleAPICalled"(params) {
      const type = params.type ?? "log";
      if (type !== "error" && type !== "warning" && type !== "assert") {
        return;
      }
      const text = (params.args ?? [])
        .map((arg) => {
          if (typeof arg.value === "string") {
            return arg.value;
          }
          if (arg.value !== undefined) {
            return JSON.stringify(arg.value);
          }
          return arg.description ?? arg.type ?? "";
        })
        .join(" ");
      if (type === "warning") {
        state.consoleWarnings.push(truncate(text, 300));
      } else {
        state.consoleErrors.push(truncate(text, 300));
      }
      recordCsp(text, "console");
    },
    "Log.entryAdded"(params) {
      const entry = params.entry ?? {};
      const text = entry.text ?? "";
      recordCsp(text, entry.source ?? "log");
      if (entry.level === "error") {
        state.consoleErrors.push(truncate(`[${entry.source ?? "log"}] ${text}`, 300));
      } else if (entry.level === "warning") {
        state.consoleWarnings.push(truncate(`[${entry.source ?? "log"}] ${text}`, 300));
      }
    },
    "Network.responseReceived"(params) {
      const response = params.response ?? {};
      if (typeof response.status === "number" && response.status >= 400) {
        state.failedRequests.push({
          url: truncate(response.url ?? "", 200),
          status: response.status,
        });
      }
    },
    "Network.loadingFailed"(params) {
      state.failedRequests.push({
        url: "",
        status: null,
        error: truncate(params.errorText ?? "loadingFailed", 160),
      });
    },
  };

  return { state, handlers };
}

async function createSession({ chromePath, outDir, timeoutMs }) {
  const profileDir = path.join(outDir, ".chrome-profile");
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  const logFile = path.join(outDir, "chrome.log");
  const stderrFile = path.join(outDir, "chrome-stderr.log");

  // stderr 重定向到文件而不是管道：受限沙箱下管道 stdio 会 EPERM，但文件描述符可以。
  // 这样 Chrome 起不来时还能读到它的 FATAL 原文，诊断才有意义。
  let stderrFd = null;
  try {
    stderrFd = openSync(stderrFile, "w");
  } catch {
    stderrFd = null;
  }

  const child = spawn(
    chromePath,
    buildChromeArgs({
      profileDir,
      windowSize: `${VIEWPORTS.desktop.width},${VIEWPORTS.desktop.height}`,
      logFile,
    }),
    {
      // stdout 用 'ignore'；受限沙箱下管道 stdio 会 EPERM。
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
      windowsHide: true,
    },
  );

  // 子进程已经继承了自己的句柄，父进程这份可以立刻关掉。
  if (stderrFd !== null) {
    try {
      closeSync(stderrFd);
    } catch {
      // ignore
    }
  }

  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  const portResult = await readDevToolsPort(profileDir, { timeoutMs, child });
  if (spawnError) {
    return {
      ok: false,
      child,
      profileDir,
      logFile,
      stderrFile,
      reason: `无法启动浏览器进程: ${errorText(spawnError)}`,
    };
  }
  if (!portResult.ok) {
    return { ok: false, child, profileDir, logFile, stderrFile, reason: portResult.reason };
  }

  const target = await findPageTarget(portResult.port, { timeoutMs });
  if (!target) {
    return {
      ok: false,
      child,
      profileDir,
      logFile,
      stderrFile,
      reason: `DevTools 端口 ${portResult.port} 上找不到可用的 page target`,
    };
  }

  const session = await DevToolsSession.open(target.webSocketDebuggerUrl, { timeoutMs });

  const collector = createConsoleCollector();
  for (const [method, handler] of Object.entries(collector.handlers)) {
    session.on(method, handler);
  }

  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Log.enable");
  await session.send("Network.enable");

  return {
    ok: true,
    session,
    child,
    profileDir,
    logFile,
    port: portResult.port,
    console: collector.state,
  };
}

async function shutdownSession(context, { keepProfile }) {
  if (!context) {
    return;
  }
  if (context.session) {
    try {
      await context.session.send("Browser.close", {}, { timeoutMs: 3000 });
    } catch {
      // 浏览器可能已经退出。
    }
    await context.session.close();
  }
  if (context.child && context.child.exitCode === null) {
    try {
      context.child.kill();
    } catch {
      // ignore
    }
    const exited = await waitFor(() => context.child.exitCode !== null, {
      timeoutMs: 5000,
      intervalMs: 100,
    });
    if (!exited) {
      try {
        context.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  if (!keepProfile && context.profileDir) {
    // Chrome 退出后文件句柄可能还没释放，重试几次再放弃。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(context.profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
}

async function applyViewport(session, viewport) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  try {
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: viewport.mobile,
      maxTouchPoints: viewport.mobile ? 5 : 0,
    });
  } catch {
    // 某些版本不支持，忽略。
  }
}

async function navigateAndSettle(session, url, timeoutMs) {
  await session.send("Page.navigate", { url });
  const ready = await waitFor(
    () =>
      session.evaluate(
        'document.readyState === "complete" && document.querySelectorAll(".lab-switcher-tab").length === 8',
      ),
    { timeoutMs, intervalMs: 120 },
  );
  if (!ready) {
    throw new Error(`页面在 ${timeoutMs}ms 内没有完成启动（模块脚本未执行？）`);
  }
  // 等两帧 rAF + 一点点余量，避免截到骨架态。
  try {
    await session.evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      { awaitPromise: true, timeoutMs: 5000 },
    );
  } catch {
    // 忽略：不影响后续等待。
  }
  await sleep(150);
}

async function switchToKnowledge(session, timeoutMs) {
  const clicked = await session.evaluate(`(() => {
    const tab = document.querySelector('[data-lab-view="knowledge"]');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  if (!clicked) {
    throw new Error('找不到第 8 个工作区标签 [data-lab-view="knowledge"]');
  }

  const mounted = await waitFor(
    () => session.evaluate('!!document.querySelector(".rag-workspace")'),
    { timeoutMs, intervalMs: 120 },
  );
  if (!mounted) {
    throw new Error("切到知识库后 .rag-workspace 没有挂载（rag-ui 未运行？）");
  }

  // 等索引状态离开 loading/idle：ready 或 error 都算有结论。
  const status = await waitFor(
    async () => {
      const value = await session.evaluate(
        'document.querySelector(".rag-status-dot")?.getAttribute("data-status") ?? ""',
      );
      return value === "ready" || value === "error" ? value : null;
    },
    { timeoutMs: Math.min(timeoutMs, 15000), intervalMs: 150 },
  );

  return { status: status ?? "timeout" };
}

async function runSampleSearch(session, timeoutMs) {
  const submitted = await session.evaluate(`(() => {
    const form = document.querySelector("#rag-search-form");
    const input = document.querySelector("#rag-query");
    if (!form || !input) return false;
    input.value = ${JSON.stringify(SAMPLE_QUERY)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  })()`);

  if (!submitted) {
    return { ok: false, reason: "找不到检索表单 #rag-search-form / #rag-query" };
  }

  const outcome = await waitFor(
    () =>
      session.evaluate(`(() => {
        const cards = document.querySelectorAll(".rag-card").length;
        if (cards > 0) return { kind: "cards", cards };
        if (document.querySelector(".rag-state-error")) return { kind: "error" };
        if (document.querySelector(".rag-state-empty")) return { kind: "empty" };
        return null;
      })()`),
    { timeoutMs, intervalMs: 150 },
  );

  if (!outcome) {
    return { ok: false, reason: "检索后既没有结果卡片也没有空态提示" };
  }
  return { ok: outcome.kind === "cards", ...outcome };
}

async function findFirstSelector(session, selectors) {
  const value = await session.evaluate(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return selector;
    }
    return "";
  })()`);
  return value || null;
}

async function openReader(session, timeoutMs) {
  const trigger = await findFirstSelector(session, READER_TRIGGER_SELECTORS);
  if (!trigger) {
    return {
      status: "skip",
      reason: "未找到阅读器触发控件（reader 未注入，「查看原文」还是裸链接）",
    };
  }

  const clicked = await session.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(trigger)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) {
    return { status: "skip", reason: `点击 ${trigger} 失败` };
  }

  // 判定「阅读器真的打开了」：容器存在 + 没被 aria-hidden + data-open 不是 false
  // + 正文有内容。只看"容器存在"会漏判：未打开时 shell 也在 DOM 里。
  const opened = await waitFor(
    () =>
      session.evaluate(`(() => {
        const selectors = ${JSON.stringify(READER_CONTAINER_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) continue;
          if (node.getAttribute("aria-hidden") === "true") continue;
          const open = node.getAttribute("data-open");
          if (open !== null && open !== "true") continue;
          if ((node.textContent ?? "").trim().length < 80) continue;
          return selector;
        }
        return "";
      })()`),
    { timeoutMs: Math.min(timeoutMs, 15000), intervalMs: 150 },
  );

  if (!opened) {
    return {
      status: "warn",
      reason: `已点击 ${trigger}，但 ${Math.round(Math.min(timeoutMs, 15000) / 1000)}s 内没有出现「已打开且有内容」的阅读器容器`,
    };
  }

  return { status: "ok", trigger, container: opened };
}

async function captureScreenshot(session, { fullPage }) {
  if (!fullPage) {
    const result = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return Buffer.from(result.data, "base64");
  }

  const metrics = await session.send("Page.getLayoutMetrics");
  const size = metrics.cssContentSize ?? metrics.contentSize ?? {
    width: VIEWPORTS.desktop.width,
    height: VIEWPORTS.desktop.height,
  };
  const width = Math.max(1, Math.ceil(size.width));
  const height = Math.max(1, Math.ceil(size.height));
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return Buffer.from(result.data, "base64");
}

async function readDom(session) {
  return session.evaluate("document.documentElement.outerHTML");
}

async function measureLayout(session) {
  return session.evaluate(`(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      innerWidth: window.innerWidth,
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
      title: document.title,
      dpr: window.devicePixelRatio,
    };
  })()`);
}

// ---------------------------------------------------------------------------
// DOM 断言
// ---------------------------------------------------------------------------

function countMatches(haystack, regex) {
  const matches = String(haystack ?? "").match(regex);
  return matches ? matches.length : 0;
}

function countScriptTags(dom) {
  return countMatches(dom, /<script\b[^>]*>/gi);
}

function countClassPrefix(dom, prefix) {
  return countMatches(dom, new RegExp(`class="[^"]*\\b${prefix}`, "gi"));
}

const SECURITY_CHECKS = [
  {
    id: "security.no-inline-handler",
    label: "DOM 里没有内联事件处理器（onerror/onclick…）",
    test: (dom) => /<[a-zA-Z][^>]*\son[a-z]+\s*=\s*/i.test(dom),
  },
  {
    id: "security.no-javascript-url",
    label: "DOM 里没有 javascript: 伪协议",
    test: (dom) => /(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(dom),
  },
];

/**
 * 纯函数断言引擎：输入几个关键时刻的 DOM 快照 + 运行期观测值，
 * 输出 PASS/FAIL/WARN/SKIP 列表。
 * 抽成纯函数是为了能在 --self-check 里用正例/反例验证断言本身没写错（不依赖浏览器）。
 */
function runDomAssertions(contextIn) {
  const results = [];
  const add = (entry) => results.push({ status: "PASS", detail: "", ...entry });

  const shellDom = contextIn.shellDom ?? "";
  const knowledgeDom = contextIn.knowledgeDom ?? "";
  const resultsDom = contextIn.resultsDom ?? "";
  const expectedScripts = Number.isInteger(contextIn.expectedScripts)
    ? contextIn.expectedScripts
    : 1;

  // ---- 外壳结构 ----
  add({
    id: "shell.lab-switcher",
    label: "存在工作区切换器 #lab-switcher",
    status: shellDom.includes('id="lab-switcher"') ? "PASS" : "FAIL",
  });

  const tabCount = countClassPrefix(shellDom, "lab-switcher-tab");
  add({
    id: "shell.tabs-8",
    label: ".lab-switcher-tab 数量为 8",
    status: tabCount === 8 ? "PASS" : "FAIL",
    detail: `实际 ${tabCount} 个`,
  });

  add({
    id: "shell.tab-knowledge",
    label: '第 8 个 tab 指向知识库（data-lab-view="knowledge"）',
    status: shellDom.includes('data-lab-view="knowledge"') ? "PASS" : "FAIL",
  });

  add({
    id: "shell.knowledge-content",
    label: "存在知识库容器 #knowledge-content",
    status: shellDom.includes('id="knowledge-content"') ? "PASS" : "FAIL",
  });

  // ---- 知识库渲染 ----
  const ragNodeCount = countClassPrefix(knowledgeDom, "rag-");
  add({
    id: "knowledge.rag-nodes",
    label: "知识库工作区渲染出 .rag-* 节点",
    status: ragNodeCount > 0 ? "PASS" : "FAIL",
    detail: `命中 ${ragNodeCount} 个带 rag- 前缀类名的元素`,
  });

  add({
    id: "knowledge.workspace",
    label: "存在 .rag-workspace 与检索表单 #rag-search-form",
    status:
      knowledgeDom.includes("rag-workspace") && knowledgeDom.includes('id="rag-search-form"')
        ? "PASS"
        : "FAIL",
  });

  const indexStatus = contextIn.indexStatus ?? "unknown";
  add({
    id: "knowledge.index-status",
    label: "知识索引状态为 ready",
    status: indexStatus === "ready" ? "PASS" : indexStatus === "error" ? "FAIL" : "WARN",
    detail:
      indexStatus === "ready"
        ? ""
        : indexStatus === "error"
          ? "corpus.json 加载失败：先跑 node scripts/validate-corpus.mjs"
          : `索引状态 = ${indexStatus}（可能只是超时，语料较大？）`,
  });

  // ---- 检索 ----
  const cardCount = countClassPrefix(resultsDom, "rag-card");
  add({
    id: "search.cards",
    label: `检索「${SAMPLE_QUERY}」有命中卡片`,
    status: cardCount > 0 ? "PASS" : "FAIL",
    detail: `实际 ${cardCount} 张 .rag-card`,
  });

  add({
    id: "search.answer-panel",
    label: "答案/引用面板已渲染",
    status: resultsDom.includes("rag-answer") || resultsDom.includes("rag-citations")
      ? "PASS"
      : "WARN",
  });

  const drive = contextIn.searchOutcome;
  add({
    id: "search.interaction",
    label: "检索交互确实被执行（表单可提交）",
    status: drive ? (drive.ok ? "PASS" : "FAIL") : "SKIP",
    detail: drive?.reason ?? "",
  });

  // ---- 安全 ----
  for (const check of SECURITY_CHECKS) {
    const offenders = [shellDom, knowledgeDom, resultsDom].filter((dom) =>
      dom ? check.test(dom) : false,
    );
    add({
      id: check.id,
      label: check.label,
      status: offenders.length === 0 ? "PASS" : "FAIL",
      detail: offenders.length === 0 ? "" : `${offenders.length} 份 DOM 命中`,
    });
  }

  const scriptCounts = {
    shell: countScriptTags(shellDom),
    knowledge: countScriptTags(knowledgeDom),
    results: countScriptTags(resultsDom),
  };
  const injected = Object.entries(scriptCounts).filter(([, value]) => value > expectedScripts);
  add({
    id: "security.no-script-injection",
    label: `没有未转义的 <script> 注入（各处均 ≤ ${expectedScripts} 个）`,
    status: injected.length === 0 ? "PASS" : "FAIL",
    detail:
      injected.length === 0
        ? `shell=${scriptCounts.shell}, knowledge=${scriptCounts.knowledge}, results=${scriptCounts.results}`
        : injected.map(([key, value]) => `${key}=${value}`).join(", "),
  });

  const markerLeak =
    /@@DOC|@@CHUNK|@@END/.test(knowledgeDom) || /@@DOC|@@CHUNK|@@END/.test(resultsDom);
  add({
    id: "content.no-raw-cursor-markers",
    label: "知识库 DOM 里没有泄漏 @@DOC/@@CHUNK 原始标记",
    status: markerLeak ? "WARN" : "PASS",
    detail: markerLeak
      ? "渲染层还在输出构建期标记，检查 knowledge/*.md 或 markdown 渲染器"
      : "",
  });

  // ---- 运行期观测 ----
  const exceptions = contextIn.exceptions ?? [];
  add({
    id: "runtime.no-exceptions",
    label: "页面没有未捕获异常",
    status: exceptions.length === 0 ? "PASS" : "FAIL",
    detail: exceptions.length === 0 ? "" : exceptions[0].text,
  });

  const cspViolations = contextIn.cspViolations ?? [];
  add({
    id: "runtime.no-csp-violation",
    label: "没有 CSP 违规（script-src 'self' 未误伤自身资源）",
    status: cspViolations.length === 0 ? "PASS" : "FAIL",
    detail: cspViolations.length === 0 ? "" : cspViolations[0].text,
  });

  const consoleErrors = contextIn.consoleErrors ?? [];
  add({
    id: "runtime.console-clean",
    label: "控制台无 error 级输出",
    status: consoleErrors.length === 0 ? "PASS" : contextIn.strict ? "FAIL" : "WARN",
    detail:
      consoleErrors.length === 0 ? "" : `${consoleErrors.length} 条：${consoleErrors[0]}`,
  });

  const failedRequests = (contextIn.failedRequests ?? []).filter(
    (item) => item.status !== 404 || /\.(mjs|js|css|json)$/.test(item.url ?? ""),
  );
  add({
    id: "runtime.no-failed-assets",
    label: "关键资源没有加载失败（4xx/5xx）",
    status: failedRequests.length === 0 ? "PASS" : "FAIL",
    detail:
      failedRequests.length === 0
        ? ""
        : failedRequests
            .map((item) => `${item.status ?? item.error} ${item.url}`)
            .join(" | "),
  });

  // ---- 布局 ----
  const mobile = contextIn.mobileLayout;
  add({
    id: "layout.mobile-no-overflow",
    label: "移动端 390px 无水平溢出",
    status: mobile && Number.isFinite(mobile.scrollWidth)
      ? mobile.scrollWidth <= mobile.innerWidth + 1
        ? "PASS"
        : "FAIL"
      : "SKIP",
    detail: mobile
      ? `scrollWidth=${mobile.scrollWidth} / innerWidth=${mobile.innerWidth}`
      : "",
  });

  // ---- 阅读器 ----
  const reader = contextIn.reader ?? { status: "skip", reason: "未检测" };
  add({
    id: "reader.panel",
    label: "阅读器面板可打开（A3/A4 集成后生效）",
    status: reader.status === "ok" ? "PASS" : reader.status === "warn" ? "WARN" : "SKIP",
    detail:
      reader.status === "ok"
        ? `触发点 ${reader.trigger} → 容器 ${reader.container}`
        : (reader.reason ?? ""),
  });

  return results;
}

// ---------------------------------------------------------------------------
// 输出渲染
// ---------------------------------------------------------------------------

function renderScreenshotLine(item) {
  const status = item.ok ? "PASS" : (item.status ?? "FAIL");
  return (
    `${pad(status, 6)}${pad(item.relativePath ?? item.id, 40)}` +
    `${pad(item.size ? `${item.size.width}×${item.size.height}` : "—", 12)}` +
    `${pad(formatBytes(item.bytes), 12)}${item.label ?? ""}`
  );
}

function summarize(results) {
  const tally = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const item of results) {
    tally[item.status] = (tally[item.status] ?? 0) + 1;
  }
  return tally;
}

function printAssertions(results) {
  for (const item of results) {
    const detail = item.detail ? `  — ${item.detail}` : "";
    console.log(`  ${pad(item.status, 6)}${pad(item.id, 34)}${item.label}${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程：CDP 模式
// ---------------------------------------------------------------------------

async function runCdpVerification({ url, outDir, chromePath, timeoutMs }) {
  let context;
  try {
    context = await createSession({ chromePath, outDir, timeoutMs });
  } catch (error) {
    return {
      status: "browser-failed",
      reason: `建立 CDP 会话失败: ${errorText(error)}`,
      context: null,
    };
  }
  if (!context.ok) {
    return { status: "browser-failed", reason: context.reason, context };
  }

  const shots = [];
  const doms = {};
  const layouts = {};
  const stepErrors = [];
  let indexStatus = "unknown";
  let searchOutcome = null;
  let reader = { status: "skip", reason: "未执行" };
  let fatal = null;

  try {
    for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
      await applyViewport(context.session, viewport);
      try {
        await navigateAndSettle(context.session, url, timeoutMs);
      } catch (error) {
        fatal = `${viewportName} 视口导航失败: ${errorText(error)}`;
        break;
      }
      layouts[viewportName] = await measureLayout(context.session);

      for (const scenario of SCENARIOS) {
        // 阅读器只截桌面一套；移动端不重复打开，避免留下半开面板。
        if (viewportName === "mobile" && scenario.state === "reader") {
          continue;
        }

        try {
          if (scenario.state === "knowledge") {
            const knowledgeState = await switchToKnowledge(context.session, timeoutMs);
            if (viewportName === "desktop") {
              indexStatus = knowledgeState.status;
            }
          } else if (scenario.state === "results") {
            const outcome = await runSampleSearch(context.session, timeoutMs);
            if (viewportName === "desktop") {
              searchOutcome = outcome;
            }
          } else if (scenario.state === "reader") {
            const outcome = await openReader(context.session, timeoutMs);
            reader = outcome;
            if (outcome.status !== "ok") {
              console.log(
                `  ${pad("SKIP", 6)}${pad("reader", 40)}${outcome.reason ?? "阅读器未集成"}`,
              );
              continue;
            }
          }

          let buffer;
          try {
            buffer = await captureScreenshot(context.session, { fullPage: scenario.fullPage });
          } catch (error) {
            shots.push({
              id: `${viewportName}-${scenario.id}`,
              ok: false,
              status: "FAIL",
              label: `${scenario.label}：截图失败 ${errorText(error)}`,
            });
            continue;
          }

          const fileName =
            [String(shots.length + 1).padStart(2, "0"), viewportName, scenario.id].join("-") +
            ".png";
          const absolutePath = path.join(outDir, fileName);
          await writeFile(absolutePath, buffer);
          const fileStats = await stat(absolutePath);
          const size = readPngSize(buffer);

          shots.push({
            id: `${viewportName}-${scenario.id}`,
            ok: Boolean(size) && fileStats.size > 0,
            relativePath: fileName,
            label: `${scenario.label}（${viewportName === "desktop" ? "1440×1000" : "390×844"}）`,
            bytes: fileStats.size,
            size,
            fullPage: scenario.fullPage,
            viewport,
          });

          if (["knowledge", "results"].includes(scenario.state) && viewportName === "desktop") {
            doms[scenario.state] = await readDom(context.session);
          }
          if (scenario.state === "startup") {
            doms[`startup-${viewportName}`] = await readDom(context.session);
          }
        } catch (error) {
          // 单个用例失败不能让整轮验证崩掉：记下来，继续跑下一张。
          const message = `${viewportName}/${scenario.id}: ${errorText(error)}`;
          stepErrors.push(message);
          console.log(
            `  ${pad("FAIL", 6)}${pad(`${viewportName}/${scenario.id}`, 40)}${errorText(error)}`,
          );
          // 知识库都挂不住时，后面的 results 用例没有意义。
          if (scenario.state === "knowledge") {
            break;
          }
        }
      }

      // 移动端布局在「知识库结果态」下最严苛，取那一刻的值。
      if (viewportName === "mobile") {
        try {
          layouts.mobileAfterResults = await measureLayout(context.session);
        } catch {
          // 忽略：布局断言会退化成 SKIP。
        }
      }
    }

    doms.shell = doms["startup-desktop"] ?? doms["startup-mobile"] ?? "";
  } catch (error) {
    fatal = errorText(error);
  }

  // 把 DOM 快照落盘，方便人工复核（.runtime 已 gitignore）。
  for (const [key, value] of Object.entries(doms)) {
    if (typeof value === "string" && value.length > 0) {
      await writeFile(path.join(outDir, `dom-${key}.html`), value, "utf8");
    }
  }

  return {
    status: fatal ? "failed" : "ok",
    reason: fatal,
    shots,
    doms,
    layouts,
    indexStatus,
    searchOutcome,
    reader,
    stepErrors,
    consoleState: context.console,
    context,
  };
}

// ---------------------------------------------------------------------------
// 主流程：CLI 模式（无 CDP 时的降级，只覆盖首屏）
// ---------------------------------------------------------------------------

async function runCliMode({ url, outDir, chromePath, timeoutMs }) {
  const shots = [];
  const doms = {};
  const results = [];

  const runChrome = (args, { stdoutFd = "ignore" } = {}) =>
    new Promise((resolve) => {
      const child = spawn(chromePath, args, {
        stdio: ["ignore", stdoutFd, "ignore"],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve(null);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    const fileName = `${viewportName === "desktop" ? "01" : "02"}-${viewportName}-startup-cli.png`;
    const absolutePath = path.join(outDir, fileName);
    const profileDir = path.join(outDir, `.chrome-profile-${viewportName}`);
    const windowSize = `${viewport.width},${viewport.height}`;

    const code = await runChrome([
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-crash-reporter",
      "--disable-breakpad",
      `--user-data-dir=${profileDir}`,
      `--window-size=${windowSize}`,
      `--virtual-time-budget=${RENDER_BUDGET_MS}`,
      `--screenshot=${absolutePath}`,
      url,
    ]);

    if (await pathExists(absolutePath)) {
      const buffer = await readFile(absolutePath);
      const fileStats = await stat(absolutePath);
      shots.push({
        id: `${viewportName}-startup-cli`,
        ok: buffer.length > 0,
        relativePath: fileName,
        label: `启动流程首页（CLI 降级模式，${windowSize}）`,
        bytes: fileStats.size,
        size: readPngSize(buffer),
      });
    } else {
      shots.push({
        id: `${viewportName}-startup-cli`,
        ok: false,
        status: "FAIL",
        label: `CLI 截图未生成（chrome exit code ${code}）`,
      });
    }

    await rm(profileDir, { recursive: true, force: true });
  }

  // CLI 模式点不动页面，只能拿首屏 DOM。
  // `--dump-dom` 把 HTML 打到 stdout；受限沙箱禁止管道 stdio，所以把 stdout
  // 直接重定向到一个文件描述符（文件不是管道，允许），而不是用 'pipe' 去收。
  const domFile = path.join(outDir, "dom-cli.html");
  let domCode = null;
  let domFd = null;
  try {
    domFd = openSync(domFile, "w");
    domCode = await runChrome(
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-crash-reporter",
        "--disable-breakpad",
        `--user-data-dir=${path.join(outDir, ".chrome-profile-dom")}`,
        "--window-size=1440,1000",
        `--virtual-time-budget=${RENDER_BUDGET_MS}`,
        "--dump-dom",
        url,
      ],
      { stdoutFd: domFd },
    );
  } catch (error) {
    domCode = `打开 DOM 输出文件失败: ${errorText(error)}`;
  } finally {
    if (domFd !== null) {
      try {
        closeSync(domFd);
      } catch {
        // ignore
      }
    }
  }
  await rm(path.join(outDir, ".chrome-profile-dom"), { recursive: true, force: true });

  if (await pathExists(domFile)) {
    const raw = await readFile(domFile, "utf8");
    if (raw.trim().length > 0) {
      doms.shell = raw;
    }
  }

  results.push({
    status: "SKIP",
    id: "mode.cli",
    label: "CLI 降级模式：页面点不动，知识库/检索/阅读器断言跳过",
    detail: `dump-dom exit=${domCode}`,
  });

  return { shots, doms, results };
}

// ---------------------------------------------------------------------------
// 汇总输出
// ---------------------------------------------------------------------------

function printHeader({ url, chrome, outDir, expectedScripts, mode }) {
  console.log("");
  console.log("AUTOSAR 启动实验室 · 真实浏览器验证");
  console.log(`  Node      : ${process.version} (${process.platform}/${process.arch})`);
  console.log(`  服务地址  : ${url}`);
  console.log(`  浏览器    : ${chrome ?? "（未找到）"}`);
  console.log(`  模式      : ${mode}`);
  console.log(`  输出目录  : ${path.resolve(outDir)}`);
  console.log(`  注入基准  : index.html 里 <script> 共 ${expectedScripts} 个`);
  console.log("");
}

function printShotsSummary(shots) {
  console.log("▶ 截图");
  if (shots.length === 0) {
    console.log("  （无）");
    return;
  }
  for (const item of shots) {
    console.log(`  ${renderScreenshotLine(item)}`);
  }
  console.log("");
}

function printConsoleSection(state) {
  console.log("▶ 运行期观测");
  console.log(
    `  ${pad("INFO", 6)}未捕获异常 ${state.exceptions.length} / console.error ${state.consoleErrors.length} / CSP 违规 ${state.cspViolations.length} / 失败请求 ${state.failedRequests.length}`,
  );
  for (const item of state.exceptions.slice(0, 5)) {
    console.log(`  ${pad("ERROR", 6)}${item.text}`);
  }
  for (const item of state.consoleErrors.slice(0, 5)) {
    console.log(`  ${pad("ERROR", 6)}${item}`);
  }
  for (const item of state.failedRequests.slice(0, 5)) {
    console.log(`  ${pad("HTTP", 6)}${item.status ?? item.error} ${item.url}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// 自检（不启动浏览器）
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 生成纯色 PNG（自检用，避免引入第三方图像库）。 */
function createTestPng(width, height, rgb = [24, 32, 48]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: zlibConstants.Z_BEST_SPEED })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function wsAcceptKey(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeWsFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload, "utf8");
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function parseWsFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) {
    return null;
  }
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const unmasked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      unmasked[index] = payload[index] ^ mask[index % 4];
    }
    payload = unmasked;
  }
  return { opcode, payload, total: offset + maskLength + length };
}

/**
 * 极小的假 CDP 服务器：在没有浏览器的环境里验证
 * DevToolsSession + 截图落盘 + PNG 尺寸解析这条管线本身是对的。
 */
function startFakeCdpServer({ onMethod }) {
  const server = createHttpServer((request, response) => {
    response.statusCode = 404;
    response.end("not found");
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.end();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    let pendingBuffer = Buffer.alloc(0);
    const sendJson = (payload) => socket.write(encodeWsFrame(JSON.stringify(payload)));

    socket.on("data", (chunk) => {
      pendingBuffer = Buffer.concat([pendingBuffer, chunk]);
      for (;;) {
        const frame = parseWsFrame(pendingBuffer);
        if (!frame) {
          break;
        }
        pendingBuffer = pendingBuffer.subarray(frame.total);
        if (frame.opcode === 0x8) {
          socket.end(encodeWsFrame("", 0x8));
          return;
        }
        if (frame.opcode !== 0x1) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(frame.payload.toString("utf8"));
        } catch {
          continue;
        }
        if (typeof message.method !== "string") {
          continue;
        }
        const outcome = onMethod(message.method, message.params ?? {}, {
          sendEvent: (method, params) => sendJson({ method, params }),
        }) ?? {};
        if (outcome.__event) {
          sendJson(outcome.__event);
        }
        if (outcome.__error) {
          sendJson({ id: message.id, error: { message: outcome.__error } });
          continue;
        }
        const { __event, __error, ...result } = outcome;
        sendJson({ id: message.id, result });
      }
    });

    socket.on("error", () => {
      // ignore
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `ws://127.0.0.1:${port}/devtools/page/FAKE`,
        close: () =>
          new Promise((done) => {
            try {
              server.closeAllConnections?.();
            } catch {
              // ignore
            }
            server.close(() => done());
          }),
      });
    });
  });
}

async function runSelfCheck({ outDir }) {
  const checks = [];
  const check = (id, label, fn) => {
    try {
      const detail = fn();
      checks.push({ id, label, status: "PASS", detail: detail ?? "" });
    } catch (error) {
      checks.push({ id, label, status: "FAIL", detail: errorText(error) });
    }
  };
  const checkAsync = async (id, label, fn) => {
    try {
      const detail = await fn();
      checks.push({ id, label, status: "PASS", detail: detail ?? "" });
    } catch (error) {
      checks.push({ id, label, status: "FAIL", detail: errorText(error) });
    }
  };

  console.log("");
  console.log("AUTOSAR 启动实验室 · browser-verify 自检（不启动浏览器）");
  console.log(`  输出目录  : ${path.resolve(outDir)}`);
  console.log("");

  await mkdir(outDir, { recursive: true });

  // ---- 1. 参数解析 ----
  check("args.defaults", "--url 缺省、--out 默认 .runtime/shots", () => {
    const parsed = parseArgs([]);
    if (parsed.url !== null) {
      throw new Error(`预期 url=null，实际 ${parsed.url}`);
    }
    if (parsed.out !== DEFAULT_OUT_DIR) {
      throw new Error(`预期 out=${DEFAULT_OUT_DIR}，实际 ${parsed.out}`);
    }
    return `out=${parsed.out}`;
  });

  check("args.parse", "--url/--out/--chrome/--strict/--timeout 解析正确", () => {
    const parsed = parseArgs([
      "--url",
      "http://127.0.0.1:4300/",
      "--out",
      ".runtime/x",
      "--chrome",
      "C:\\chrome.exe",
      "--strict",
      "--timeout",
      "9000",
    ]);
    if (parsed.url !== "http://127.0.0.1:4300/") {
      throw new Error(`url 解析错误: ${parsed.url}`);
    }
    if (parsed.out !== ".runtime/x") {
      throw new Error(`out 解析错误: ${parsed.out}`);
    }
    if (parsed.chrome !== "C:\\chrome.exe" || !parsed.strict || parsed.timeoutMs !== 9000) {
      throw new Error("其余参数解析错误");
    }
    return "ok";
  });

  check("args.reject", "非法参数会报错而不是静默吞掉", () => {
    for (const argv of [["--url", "not-a-url"], ["--mode", "nope"], ["--bogus"]]) {
      let threw = false;
      try {
        parseArgs(argv);
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`未报错: ${argv.join(" ")}`);
      }
    }
    return "3 组非法参数均被拒绝";
  });

  // ---- 2. PNG 尺寸解析 ----
  check("png.parse", "能读出自生成 PNG 的真实宽高", () => {
    const buffer = createTestPng(1440, 1000);
    const size = readPngSize(buffer);
    if (!size || size.width !== 1440 || size.height !== 1000) {
      throw new Error(`解析结果异常: ${JSON.stringify(size)}`);
    }
    return `${size.width}×${size.height}, ${buffer.length} bytes`;
  });

  check("png.invalid", "非 PNG 数据不会被误判成 PNG", () => {
    if (readPngSize(Buffer.from("not a png at all, just text"))) {
      throw new Error("普通文本被误判成 PNG");
    }
    return "ok";
  });

  // ---- 3. 断言引擎 ----
  const goodShell = `<html><body><nav id="lab-switcher">${Array.from(
    { length: 8 },
    (_, index) =>
      `<button class="lab-switcher-tab${index === 0 ? " active" : ""}" data-lab-view="${
        index === 7 ? "knowledge" : `lab${index}`
      }">${index + 1}</button>`,
  ).join("")}</nav><section><div id="knowledge-content"></div></section><script type="module" src="/src/app.mjs"></script></body></html>`;
  const goodKnowledge = `<section class="rag-workspace"><form id="rag-search-form"><input id="rag-query"></form><span class="rag-status-dot" data-status="ready"></span></section>`;
  const goodResults = `<section class="rag-workspace"><article class="rag-card"><span class="rag-card-text">EcuM</span></article><aside class="rag-answer"></aside></section>`;

  const contextFor = (overrides = {}) => ({
    shellDom: goodShell,
    knowledgeDom: goodKnowledge,
    resultsDom: goodResults,
    expectedScripts: 1,
    indexStatus: "ready",
    exceptions: [],
    cspViolations: [],
    consoleErrors: [],
    failedRequests: [],
    mobileLayout: { scrollWidth: 390, innerWidth: 390 },
    reader: { status: "ok", trigger: "x", container: "y" },
    searchOutcome: { ok: true },
    strict: true,
    ...overrides,
  });

  check("assert.pass", "健康 DOM 上全部断言 PASS（无 FAIL）", () => {
    const results = runDomAssertions(contextFor());
    const failed = results.filter((item) => item.status === "FAIL");
    if (failed.length > 0) {
      throw new Error(
        `出现 ${failed.length} 条 FAIL: ${failed.map((item) => item.id).join(", ")}`,
      );
    }
    if (results.length < 15) {
      throw new Error(`断言数量偏少: ${results.length}`);
    }
    return `${results.length} 条断言全部 PASS`;
  });

  const negatives = [
    ["shell.tabs-8", { shellDom: goodShell.replace("lab-switcher-tab active", "other active") }],
    ["shell.lab-switcher", { shellDom: goodShell.replace('id="lab-switcher"', 'id="x"') }],
    ["shell.knowledge-content", { shellDom: goodShell.replace('id="knowledge-content"', 'id="x"') }],
    ["knowledge.rag-nodes", { knowledgeDom: "<div>nothing here</div>" }],
    ["knowledge.workspace", { knowledgeDom: "<div>nothing here</div>" }],
    ["search.cards", { resultsDom: "<div>no cards</div>" }],
    ["search.interaction", { searchOutcome: { ok: false, reason: "表单不可提交" } }],
    // 注入用例：知识库 DOM 里多出两个真正的 <script> 标签（页面本身只有 1 个）。
    [
      "security.no-script-injection",
      {
        knowledgeDom: `${goodKnowledge}<script>alert(1)</script><script src="/evil.js"></script>`,
      },
    ],
    ["security.no-inline-handler", { resultsDom: `<img src="/a.png" onerror="alert(1)">` }],
    ["runtime.no-exceptions", { exceptions: [{ text: "boom" }] }],
    [
      "runtime.no-csp-violation",
      { cspViolations: [{ text: "Refused to execute inline script" }] },
    ],
    ["runtime.no-failed-assets", { failedRequests: [{ url: "/src/app.mjs", status: 500 }] }],
    ["layout.mobile-no-overflow", { mobileLayout: { scrollWidth: 620, innerWidth: 390 } }],
    ["knowledge.index-status", { indexStatus: "error" }],
  ];

  for (const [expectedId, overrides] of negatives) {
    check(`assert.negative.${expectedId}`, `反例能识别出 ${expectedId} 失败`, () => {
      const results = runDomAssertions(contextFor(overrides));
      const target = results.find((item) => item.id === expectedId);
      if (!target) {
        throw new Error(`找不到断言 ${expectedId}`);
      }
      if (target.status !== "FAIL") {
        throw new Error(`预期 FAIL，实际 ${target.status}`);
      }
      return `${expectedId} → FAIL`;
    });
  }

  // ---- 4. 复用 createStaticServer ----
  await checkAsync("server.reuse", "复用 createStaticServer：/、CSP 头、corpus.json", async () => {
    const app = createStaticServer({ root: projectRoot, port: 0 });
    const details = await app.listen(0);
    try {
      const indexResponse = await fetch(details.url);
      if (!indexResponse.ok) {
        throw new Error(`GET / 返回 ${indexResponse.status}`);
      }
      const html = await indexResponse.text();
      if (!html.includes("lab-switcher")) {
        throw new Error("首页没有 lab-switcher 标记，服务根目录可能不对");
      }
      const csp = indexResponse.headers.get("content-security-policy") ?? "";
      if (!/script-src 'self'/.test(csp)) {
        throw new Error(`CSP 头缺失或异常: ${csp}`);
      }

      let corpusNote = "corpus.json 未加载（A1 可能还没构建）";
      const corpusResponse = await fetch(new URL("/knowledge/corpus.json", details.url));
      if (corpusResponse.ok) {
        // 响应体只能读一次：先取文本再自己 JSON.parse。
        const text = await corpusResponse.text();
        let corpus;
        try {
          corpus = JSON.parse(text);
        } catch {
          throw new Error("corpus.json 不是合法 JSON");
        }
        // 结构与 A1 的产出约定一致：{ documents: [{ id, chunks: [{ id, heading, anchor, text }] }] }
        const documents = Array.isArray(corpus?.documents) ? corpus.documents : null;
        if (!documents || documents.length === 0) {
          throw new Error("corpus.json 缺少 documents 数组（A1 的产出格式变了？）");
        }
        let chunkCount = 0;
        for (const document of documents) {
          if (!Array.isArray(document?.chunks)) {
            throw new Error(`文档 ${document?.id ?? "?"} 缺少 chunks 数组`);
          }
          for (const chunk of document.chunks) {
            chunkCount += 1;
            if (!chunk?.id || !chunk?.heading || !chunk?.anchor || typeof chunk?.text !== "string") {
              throw new Error(`chunk 字段不全: ${chunk?.id ?? JSON.stringify(chunk).slice(0, 60)}`);
            }
          }
        }
        corpusNote = `corpus.json ${text.length} bytes / ${documents.length} 篇文档 / ${chunkCount} 个片段`;
      }
      return `${details.url} · ${corpusNote}`;
    } finally {
      await app.close();
    }
  });

  // ---- 5. CDP 客户端 + 截图管线（假服务器） ----
  await checkAsync("cdp.pipeline", "CDP 往返 / 事件 / 异常 / 截图落盘（假服务器）", async () => {
    const fakePng = createTestPng(1440, 1000);
    let evaluateCalls = 0;
    const server = await startFakeCdpServer({
      onMethod: (method, params, { sendEvent }) => {
        switch (method) {
          case "Page.navigate":
            sendEvent("Page.loadEventFired", { timestamp: Date.now() / 1000 });
            return { frameId: "FAKE" };
          case "Page.getLayoutMetrics":
            return { cssContentSize: { width: 1440, height: 2400 } };
          case "Page.captureScreenshot":
            return { data: fakePng.toString("base64") };
          case "Runtime.evaluate": {
            evaluateCalls += 1;
            if (String(params.expression).includes("__throw__")) {
              return { exceptionDetails: { text: "Uncaught Error: boom" } };
            }
            if (String(params.expression).includes("__counter__")) {
              return { result: { value: evaluateCalls >= 3 } };
            }
            return { result: { value: true } };
          }
          default:
            return {};
        }
      },
    });

    try {
      const session = await DevToolsSession.open(server.url, { timeoutMs: 5000 });
      let loadFired = false;
      session.on("Page.loadEventFired", () => {
        loadFired = true;
      });

      await session.send("Page.enable");
      await session.send("Page.navigate", { url: "http://127.0.0.1:1/" });
      const sawLoad = await waitFor(() => loadFired, { timeoutMs: 2000, intervalMs: 20 });
      if (!sawLoad) {
        throw new Error("Page.loadEventFired 事件没有送达");
      }

      const layout = await session.send("Page.getLayoutMetrics");
      if (layout.cssContentSize?.height !== 2400) {
        throw new Error("Page.getLayoutMetrics 返回值异常");
      }

      const buffer = await captureScreenshot(session, { fullPage: true });
      const size = readPngSize(buffer);
      if (!size || size.width !== 1440 || size.height !== 1000) {
        throw new Error(`截图管线产出的 PNG 尺寸异常: ${JSON.stringify(size)}`);
      }
      const shotPath = path.join(outDir, "selfcheck-cdp.png");
      await writeFile(shotPath, buffer);
      const fileStats = await stat(shotPath);
      if (fileStats.size !== fakePng.length) {
        throw new Error(`截图落盘字节数不符: ${fileStats.size} != ${fakePng.length}`);
      }

      const polled = await waitFor(() => session.evaluate("__counter__"), {
        timeoutMs: 2000,
        intervalMs: 20,
      });
      if (polled !== true) {
        throw new Error("waitFor 轮询没有拿到真值");
      }

      let threw = false;
      try {
        await session.evaluate("__throw__");
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error("页面异常没有被转成 rejection");
      }

      await session.close();
      return `事件/往返/截图/异常均正常（${formatBytes(fileStats.size)} → ${shotPath}）`;
    } finally {
      await server.close();
    }
  });

  // ---- 6. 浏览器探测 ----
  await checkAsync("chrome.detect", "浏览器探测返回结构正确（找不到不算错误）", async () => {
    const detected = await detectBrowser(null);
    if (!detected || !("path" in detected)) {
      throw new Error("探测结果结构异常");
    }
    return detected.path
      ? `找到 ${detected.path}（来源 ${detected.source}）`
      : "本机没找到 Chrome/Edge → 正式运行会 SKIP 并退出 0";
  });

  await checkAsync(
    "chrome.detect.missing",
    "--chrome 指向不存在的路径时给出 missing 而不是抛错",
    async () => {
      const detected = await detectBrowser(
        path.join(outDir, "definitely-not-here", "chrome.exe"),
      );
      if (detected.path !== null || !detected.missing) {
        throw new Error(`预期 path=null 且有 missing，实际 ${JSON.stringify(detected)}`);
      }
      return detected.missing;
    },
  );

  // ---- 汇总 ----
  const tally = summarize(checks);
  for (const item of checks) {
    const detail = item.detail ? `  — ${item.detail}` : "";
    console.log(`  ${pad(item.status, 6)}${pad(item.id, 32)}${item.label}${detail}`);
  }
  console.log("");
  console.log(
    `自检结果: ${tally.PASS} PASS / ${tally.FAIL} FAIL / ${tally.WARN} WARN / ${tally.SKIP} SKIP`,
  );
  return tally.FAIL === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function printScenarioList(expectedScripts) {
  console.log("");
  console.log("将执行的截图用例（每个视口一套）:");
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    for (const scenario of SCENARIOS) {
      // 阅读器只截桌面一套（移动端会跳过，避免留下半开面板）。
      if (viewportName === "mobile" && scenario.state === "reader") {
        continue;
      }
      const sizeLabel = `${viewport.width}×${viewport.height}${viewport.mobile ? "（移动）" : ""}`;
      const optional = scenario.optional ? "  [可选，未集成则 SKIP]" : "";
      console.log(`  - ${viewportName}/${scenario.id}  ${sizeLabel}  ${scenario.label}${optional}`);
    }
  }
  console.log("");
  console.log("将执行的 DOM 断言:");
  for (const item of runDomAssertions({
    shellDom: "",
    knowledgeDom: "",
    resultsDom: "",
    expectedScripts,
  })) {
    console.log(`  - ${item.id}  ${item.label}`);
  }
  console.log("");
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(errorText(error));
    console.error("");
    console.error(HELP_TEXT);
    return 1;
  }

  if (options.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const outDir = path.resolve(projectRoot, options.out);
  await mkdir(outDir, { recursive: true });

  if (options.selfCheck) {
    return runSelfCheck({ outDir });
  }

  // index.html 里的 <script> 数量是「未转义注入」的基准线。
  let expectedScripts = 1;
  try {
    const indexSource = await readFile(path.join(projectRoot, "index.html"), "utf8");
    expectedScripts = countScriptTags(indexSource) || 1;
  } catch {
    // 拿不到就按 1 算，报告里会体现。
  }

  if (options.list) {
    printScenarioList(expectedScripts);
    return 0;
  }

  const detected = await detectBrowser(options.chrome);
  if (!detected.path) {
    console.log("");
    console.log("AUTOSAR 启动实验室 · 真实浏览器验证");
    console.log("");
    console.log("SKIP  未找到可用浏览器，本次跳过（退出码 0）。");
    console.log(
      `      ${detected.missing ? `--chrome 指定的路径不存在: ${detected.missing}` : "常见安装路径与 PATH 里都没有 Chrome/Edge。"}`,
    );
    console.log("      需要真实验证时：");
    console.log("        1) 安装 Chrome/Edge，或");
    console.log(
      '        2) 用 --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" 指定；',
    );
    console.log(
      "        3) 受限沙箱下还必须放宽权限（danger-full-access），否则 Chrome 会 FATAL 于命名管道。",
    );
    console.log("      详见 docs/browser-verification.md");
    console.log("");
    return 0;
  }

  let url = options.url;
  let app = null;

  if (!url) {
    app = createStaticServer({ root: projectRoot, port: 0 });
    const details = await app.listen(0);
    url = details.url;
  }

  printHeader({ url, chrome: detected.path, outDir, expectedScripts, mode: options.mode });

  // 声明在 try 外面：finally 要拿到 outcome 才能关浏览器与静态服务。
  let outcome = null;
  try {
    if (options.mode === "cli") {
      const cliResult = await runCliMode({
        url,
        outDir,
        chromePath: detected.path,
        timeoutMs: options.timeoutMs,
      });
      printShotsSummary(cliResult.shots);
      console.log("▶ DOM 断言");
      const results = [
        ...cliResult.results,
        ...runDomAssertions({
          shellDom: cliResult.doms.shell ?? "",
          knowledgeDom: "",
          resultsDom: "",
          expectedScripts,
        }).filter(
          (item) => !item.id.startsWith("knowledge.") && !item.id.startsWith("search."),
        ),
      ];
      printAssertions(results);
      const shotFailures = cliResult.shots.filter((item) => !item.ok).length;
      const tally = summarize(results);
      const failed = tally.FAIL + shotFailures;
      console.log("");
      console.log(
        `结果: ${failed === 0 ? "PASS" : "FAIL"}（截图 ${cliResult.shots.length} 张，` +
          `断言 ${tally.PASS} PASS / ${tally.FAIL} FAIL / ${tally.WARN} WARN / ${tally.SKIP} SKIP）`,
      );
      return failed === 0 ? 0 : 1;
    }

    outcome = await runCdpVerification({
      url,
      outDir,
      chromePath: detected.path,
      timeoutMs: options.timeoutMs,
    });

    if (outcome.status === "browser-failed") {
      const logTail = await readLogTail(path.join(outDir, "chrome.log"));
      const stderrTail = await readLogTail(path.join(outDir, "chrome-stderr.log"));
      console.error("");
      console.error("✗ 浏览器启动失败（退出码 2）");
      console.error(`  原因: ${outcome.reason}`);
      if (logTail.length > 0) {
        console.error("  Chrome 日志（chrome.log 末尾）:");
        for (const line of logTail) {
          console.error(`    ${line}`);
        }
      }
      if (stderrTail.length > 0) {
        console.error("  Chrome stderr（chrome-stderr.log 末尾）:");
        for (const line of stderrTail) {
          console.error(`    ${line}`);
        }
      }
      console.error("");
      console.error("  最常见原因是受限沙箱禁止命名管道（Mojo IPC），Chrome 会在启动阶段 FATAL：");
      console.error(
        "    mojo\\public\\cpp\\platform\\platform_channel.cc:112 Check failed: 拒绝访问 (0x5)",
      );
      console.error("    crashpad_client_win.cc:431 OpenProcess: 拒绝访问 (0x5)");
      console.error("  解决办法：在放宽权限（sandbox_permissions: danger-full-access）下运行");
      console.error("    node scripts/browser-verify.mjs");
      console.error("  只想验证脚本逻辑、不启动浏览器时");
      console.error("    node scripts/browser-verify.mjs --self-check");
      return 2; // context 交给 finally 统一关闭
    }

    printShotsSummary(outcome.shots);

    console.log("▶ DOM 断言");
    const results = runDomAssertions({
      shellDom: outcome.doms.shell ?? "",
      knowledgeDom: outcome.doms.knowledge ?? "",
      resultsDom: outcome.doms.results ?? "",
      expectedScripts,
      indexStatus: outcome.indexStatus,
      exceptions: outcome.consoleState.exceptions,
      cspViolations: outcome.consoleState.cspViolations,
      consoleErrors: outcome.consoleState.consoleErrors,
      failedRequests: outcome.consoleState.failedRequests,
      mobileLayout: outcome.layouts.mobileAfterResults ?? outcome.layouts.mobile,
      reader: outcome.reader,
      searchOutcome: outcome.searchOutcome,
      strict: options.strict,
    });
    printAssertions(results);
    console.log("");
    printConsoleSection(outcome.consoleState);

    if (outcome.status === "failed") {
      console.error(`✗ 验证过程中断: ${outcome.reason}`);
    }
    for (const line of outcome.stepErrors ?? []) {
      console.error(`  STEP FAIL ${line}`);
    }

    const shotFailures = outcome.shots.filter((item) => !item.ok);
    const tally = summarize(results);
    const failed = tally.FAIL + shotFailures.length + (outcome.status === "failed" ? 1 : 0);

    console.log(
      `结果: ${failed === 0 ? "PASS" : "FAIL"}（截图 ${outcome.shots.length} 张，` +
        `断言 ${tally.PASS} PASS / ${tally.FAIL} FAIL / ${tally.WARN} WARN / ${tally.SKIP} SKIP）`,
    );
    console.log(`截图与 DOM 快照: ${outDir}`);
    console.log("");
    return failed === 0 ? 0 : 1;
  } finally {
    if (outcome?.context) {
      await shutdownSession(outcome.context, { keepProfile: options.keepProfile });
    }
    if (app) {
      await app.close();
    }
  }
}

if (isMainModule()) {
  main(process.argv.slice(2))
    .then((code) => {
      // Chrome 子进程或未关闭的句柄可能留住事件循环，显式退出。
      process.exit(code ?? 0);
    })
    .catch((error) => {
      console.error(errorText(error));
      process.exit(1);
    });
}

export {
  buildChromeArgs,
  createTestPng,
  detectBrowser,
  DevToolsSession,
  parseArgs,
  readPngSize,
  runDomAssertions,
  SCENARIOS,
  VIEWPORTS,
};
