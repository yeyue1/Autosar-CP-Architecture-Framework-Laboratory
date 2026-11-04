// 单进程内运行的 `tests/*.test.mjs` 测试运行器。
//
// 为什么需要它：本沙箱禁止 spawn + 管道 stdio（EPERM），`node --test` 会为每个
// 测试文件起子进程，因而直接失败。这里改用 `node:test` 的进程内 `run()` API
// （`isolation: "none"`，不派生子进程），一次调用跑完全部文件，再按文件汇总。
//
// 关键实现约束：`run()` 在当前进程里只能成功调用一次——第二次调用返回的
// TestsStream 不会再发 `end` 事件，等待会永久挂起。因此必须把全部文件一次性
// 传进去，然后从事件流里按 `event.file` 归组统计。
//
// 用法：
//   node scripts/run-tests.mjs                 # 跑全部 tests/*.test.mjs
//   node scripts/run-tests.mjs rag            # 只跑匹配的文件（子串匹配，可多个）
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

async function listTestFiles(filters) {
  const entries = (await readdir(testsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort();

  if (filters.length === 0) {
    return entries;
  }

  return entries.filter((name) => filters.some((filter) => name.includes(filter)));
}

function createTally() {
  return { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
}

async function main() {
  const filters = process.argv.slice(2);
  const files = await listTestFiles(filters);

  if (files.length === 0) {
    console.error(
      filters.length
        ? `No matching test files for: ${filters.join(", ")}`
        : `No test files found in ${testsDir}`,
    );
    return 1;
  }

  console.log(
    `Running ${files.length} test file(s) in a single process (no subprocess).\n`,
  );

  const filePaths = files.map((name) => path.join(testsDir, name));
  const perFile = new Map();
  const tally = (name) => {
    if (!perFile.has(name)) {
      perFile.set(name, createTally());
    }
    return perFile.get(name);
  };

  let stream;
  try {
    stream = run({
      files: filePaths,
      concurrency: 1,
      isolation: "none",
      testNamePatterns: undefined,
    });
  } catch (error) {
    console.error(`Failed to start test runner: ${error?.message ?? error}`);
    return 1;
  }

  for await (const event of stream) {
    const data = event?.data ?? {};
    const type = event?.type;
    if (type !== "test:pass" && type !== "test:fail") {
      continue;
    }

    // suite 也是 test:pass/fail，必须跳过，否则统计会重复计数。
    if (data.details?.type === "suite" || data.details?.type === "suiteHook") {
      continue;
    }

    const name = data.file ? path.basename(data.file) : "(unknown)";
    const entry = tally(name);
    entry.tests += 1;

    if (data.skip === true || data.todo === true) {
      entry.skipped += 1;
      continue;
    }

    if (type === "test:pass") {
      entry.passed += 1;
    } else {
      entry.failed += 1;
    }
  }

  let failedFiles = 0;
  const total = createTally();

  for (const name of files) {
    const entry = perFile.get(name) ?? createTally();
    total.tests += entry.tests;
    total.passed += entry.passed;
    total.failed += entry.failed;
    total.skipped += entry.skipped;

    const ok = entry.failed === 0 && entry.tests > 0;
    if (!ok) {
      failedFiles += 1;
    }

    const extra = entry.skipped > 0 ? `, ${entry.skipped} skipped` : "";
    const note = entry.tests === 0 ? "  (no tests collected)" : "";
    console.log(
      `${ok ? "PASS" : "FAIL"}  tests/${name}  -> ${entry.passed} passed, ${entry.failed} failed${extra}${note}`,
    );
  }

  console.log(
    `\nTotal: ${files.length} file(s), ${total.tests} test(s), ` +
      `${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped.`,
  );

  if (total.failed > 0 || failedFiles > 0) {
    console.log(`Result: FAIL (${failedFiles} file(s) with failures).`);
    return 1;
  }

  console.log("Result: PASS.");
  return 0;
}

if (isMainModule()) {
  main()
    .then((code) => {
      // 测试可能留下计时器或开放的 HTTP server；显式退出避免挂起。
      process.exit(code);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exit(1);
    });
}

export { main };
