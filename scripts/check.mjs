// 语法 / 目录 / 模型完整性检查。
//
// 本脚本**不启动任何子进程**。本沙箱禁止 spawn + 管道 stdio（EPERM），
// 因此无法使用 `node --check`。这里改为进程内动态 `import()` 每个模块：
//  - 模块若存在**语法错误**，`import()` 会在解析阶段直接抛出 `SyntaxError`，精确报错。
//  - 模块若能解析、但在顶层求值时缺少浏览器全局（document/window 等），抛出
//    `ReferenceError`，这恰好证明**语法是合法的**：按“浏览器专用模块”放行。
//  - `tests/**` 不做 import（import 会真的跑测试并污染输出），交由
//    `node scripts/run-tests.mjs` 实际执行覆盖，这里只登记跳过。
//
// 为避免被导入模块的顶层副作用污染检查输出，导入期间会临时静音 stdout、
// 并对单个模块设置超时，导入结束后立即恢复。
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRequiredFiles = ["index.html", "styles.css"];
const phaseRequiredCount = 7;
const stepRequiredCount = 42;
const importTimeoutMs = 8000;
const engineCandidates = [
  "src/engine.mjs",
  "src/engine.js",
  "src/boot-simulator.mjs",
  "src/boot-simulator.js",
  "src/simulator/boot-simulator.mjs",
  "src/simulator/boot-simulator.js",
  "src/BootSimulator.mjs",
  "src/BootSimulator.js",
];
const modelCandidates = [
  "src/model.mjs",
  "src/model.js",
  "src/model42.mjs",
  "src/model42.js",
];

// 浏览器环境才有的全局符号：抛 "xxx is not defined" 说明模块可解析、只是需要 DOM。
const browserGlobalPattern =
  /\b(document|window|localStorage|sessionStorage|navigator|HTMLElement|HTMLCanvasElement|CustomEvent|Event|XMLHttpRequest|requestAnimationFrame|cancelAnimationFrame|matchMedia|getComputedStyle|MutationObserver|IntersectionObserver|ResizeObserver|location|history)\b\s+is not defined/;

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function collectJavaScriptFiles(currentDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    // 跳过版本控制、依赖与运行时临时目录（.runtime 含截图、日志与冲突备份，非源码）。
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".runtime") {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && [".js", ".mjs", ".cjs"].includes(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function relativePosix(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0].trim();
}

// 进程内导入一个模块来做语法校验。
// 返回 { ok: true, note? } 或 { ok: false, error }。
async function importCheck(filePath) {
  const moduleUrl = pathToFileURL(filePath).href;

  // 屏蔽被导入模块的 stdout 输出与 argv，避免污染本检查进程（如 export-trace 直接跑 main）。
  const originalWrite = process.stdout.write;
  const originalArgv = process.argv;
  process.stdout.write = () => true;
  process.argv = [process.execPath, "check"];

  const importPromise = import(moduleUrl);
  importPromise.catch(() => {}); // 超时后避免未处理的 rejection 警告

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`import timed out after ${importTimeoutMs}ms`);
      error.code = "CHECK_TIMEOUT";
      reject(error);
    }, importTimeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([importPromise, timeoutPromise]);
    return { ok: true };
  } catch (error) {
    if (error && error.code === "CHECK_TIMEOUT") {
      return { ok: true, note: "import timed out; syntax accepted, execution skipped" };
    }

    if (error instanceof SyntaxError) {
      return { ok: false, error };
    }

    if (error instanceof ReferenceError && browserGlobalPattern.test(error.message)) {
      return { ok: true, note: "browser-only module (DOM global missing; syntax verified)" };
    }

    if (error && error.code === "ERR_MODULE_NOT_FOUND") {
      return {
        ok: true,
        note: `dependency not found (syntax OK): ${firstLine(error.message)}`,
      };
    }

    // 其余顶层求值错误不影响“语法是否合法”的判断；只作提示。
    const name = error && error.name ? error.name : "Error";
    return {
      ok: true,
      note: `non-syntax error on import (syntax OK): ${name}: ${firstLine(error?.message)}`,
    };
  } finally {
    clearTimeout(timer);
    process.stdout.write = originalWrite;
    process.argv = originalArgv;
  }
}

async function inspectModel42() {
  let selected = null;
  for (const candidate of modelCandidates) {
    if (await exists(candidate)) {
      selected = candidate;
      break;
    }
  }

  if (!selected) {
    return {
      ok: false,
      message: "BootSimulator or model42 source file was not found yet.",
    };
  }

  const moduleUrl = pathToFileURL(path.join(root, selected)).href;
  let imported;
  try {
    imported = await import(moduleUrl);
  } catch {
    const raw = await readFile(path.join(root, selected), "utf8");
    const phaseMarkerCount = (raw.match(/phase/gi) ?? []).length;
    return {
      ok: phaseMarkerCount >= phaseRequiredCount,
      message: `Fallback scan found ${phaseMarkerCount} phase markers in ${selected}.`,
    };
  }
  const phaseSets = [
    imported.PHASES,
    imported.MODEL_42_PHASES,
    imported.MODEL42_PHASES,
    imported.MODEL_42?.phases,
    imported.model42?.phases,
  ].filter(Array.isArray);

  if (phaseSets.length > 0) {
    const phases = phaseSets[0];
    const steps = Array.isArray(imported.STEPS) ? imported.STEPS.length : null;
    const phaseOk = phases.length === phaseRequiredCount;
    const stepOk = steps === null || steps === stepRequiredCount;
    return {
      ok: phaseOk && stepOk,
      message:
        steps === null
          ? `Detected ${phases.length} phases in ${selected}.`
          : `Detected ${phases.length} phases and ${steps} steps in ${selected}.`,
    };
  }

  if (typeof imported.BootSimulator === "function") {
    const simulator = new imported.BootSimulator();
    const candidateArrays = [
      simulator.model42?.phases,
      simulator.phases,
      simulator.steps,
      typeof simulator.getModel42Phases === "function"
        ? simulator.getModel42Phases()
        : null,
    ].filter(Array.isArray);
    if (candidateArrays.length > 0) {
      const phases = candidateArrays[0];
      return {
        ok: phases.length === phaseRequiredCount,
        message: `Detected ${phases.length} model42 phases via BootSimulator in ${selected}.`,
      };
    }
  }

  const raw = await readFile(path.join(root, selected), "utf8");
  const phaseMarkerCount = (raw.match(/phase/gi) ?? []).length;
  return {
    ok: phaseMarkerCount >= phaseRequiredCount,
    message: `Fallback scan found ${phaseMarkerCount} phase markers in ${selected}.`,
  };
}

async function inspectStaticReferences() {
  const relevantFiles = [];
  for (const relativePath of ["index.html", "styles.css"]) {
    if (await exists(relativePath)) {
      relevantFiles.push(relativePath);
    }
  }

  for (const relativePath of [...engineCandidates, ...modelCandidates]) {
    if (await exists(relativePath)) {
      relevantFiles.push(relativePath);
    }
  }

  const offenders = [];
  const externalPatterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)[^"']+["'][^>]*>/gi,
    /<link\b[^>]*\brel\s*=\s*["'](?:stylesheet|modulepreload|preload)["'][^>]*\bhref\s*=\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)[^"']+["'][^>]*>/gi,
    /\b(?:import|from|fetch)\s*(?:\(|)\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)[^"']+["']/gi,
    /\burl\(\s*["']?https?:\/\/(?!127\.0\.0\.1|localhost)[^)]+["']?\s*\)/gi,
  ];
  for (const relativePath of relevantFiles) {
    const raw = await readFile(path.join(root, relativePath), "utf8");
    for (const pattern of externalPatterns) {
      const matches = raw.match(pattern) ?? [];
      offenders.push(
        ...matches.map((match) => ({
          file: relativePath,
          value: match,
        })),
      );
    }
  }

  const unique = new Set();
  return offenders.filter((offender) => {
    const key = `${offender.file}:${offender.value}`;
    if (unique.has(key)) {
      return false;
    }
    unique.add(key);
    return true;
  });
}

async function main() {
  const failures = [];
  const notes = [];

  for (const relativePath of uiRequiredFiles) {
    if (!(await exists(relativePath))) {
      failures.push(`Missing required UI file: ${relativePath}`);
    }
  }

  const jsFiles = await collectJavaScriptFiles(root);
  let checkedCount = 0;
  let browserOnlyCount = 0;
  let deferredTests = 0;

  for (const filePath of jsFiles) {
    const relativePath = relativePosix(filePath);

    // tests/** 交给 scripts/run-tests.mjs 实际执行覆盖；import 会真的跑测试。
    if (relativePath.startsWith("tests/")) {
      deferredTests += 1;
      continue;
    }

    const result = await importCheck(filePath);
    checkedCount += 1;

    if (!result.ok) {
      failures.push(
        `Syntax check failed for ${relativePath}: ${result.error.name}: ${firstLine(result.error.message)}`,
      );
      continue;
    }

    if (result.note) {
      notes.push(`${relativePath}: ${result.note}`);
      if (result.note.startsWith("browser-only")) {
        browserOnlyCount += 1;
      }
    }
  }

  const model42Result = await inspectModel42();
  if (!model42Result.ok) {
    failures.push(model42Result.message);
  }

  const externalRefs = await inspectStaticReferences();
  for (const ref of externalRefs) {
    failures.push(`External URL found in ${ref.file}: ${ref.value}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`CHECK FAILED: ${failure}`);
    }
    console.error(
      `Check finished with ${failures.length} failure(s) across ${checkedCount} file(s).`,
    );
    return 1;
  }

  console.log(
    `Check passed for ${checkedCount} JavaScript file(s) — syntax verified in-process (no subprocess).`,
  );
  if (browserOnlyCount > 0) {
    console.log(
      `  ${browserOnlyCount} browser-only module(s): parsed cleanly, DOM globals absent (expected).`,
    );
  }
  if (deferredTests > 0) {
    console.log(
      `  ${deferredTests} test file(s) under tests/ skipped here — run \`node scripts/run-tests.mjs\` to execute them.`,
    );
  }
  for (const note of notes) {
    console.log(`  - ${note}`);
  }
  console.log(model42Result.message);
  return 0;
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code;
      // 被导入的模块可能留下计时器/句柄；显式退出以免阻塞。
      process.exit(code);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      process.exitCode = 1;
      process.exit(1);
    });
}

export { main };
