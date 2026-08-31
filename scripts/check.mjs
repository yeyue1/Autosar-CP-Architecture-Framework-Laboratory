import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRequiredFiles = ["index.html", "styles.css"];
const phaseRequiredCount = 7;
const stepRequiredCount = 42;
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
    if (entry.name === ".git" || entry.name === "node_modules") {
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

function runNodeCheck(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", filePath], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stderr: stderr.trim(),
      });
    });
  });
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

  for (const relativePath of uiRequiredFiles) {
    if (!(await exists(relativePath))) {
      failures.push(`Missing required UI file: ${relativePath}`);
    }
  }

  const jsFiles = await collectJavaScriptFiles(root);
  for (const filePath of jsFiles) {
    const result = await runNodeCheck(filePath);
    if (!result.ok) {
      failures.push(`Syntax check failed for ${path.relative(root, filePath)}: ${result.stderr}`);
    }
  }

  const model42Result = await inspectModel42();
  if (!model42Result.ok) {
    failures.push(model42Result.message);
  }

  const externalRefs = await inspectStaticReferences();
  if (externalRefs.length > 0) {
    for (const ref of externalRefs) {
      failures.push(`External URL found in ${ref.file}: ${ref.value}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`CHECK FAILED: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Check passed for ${jsFiles.length} JavaScript files.`);
  console.log(model42Result.message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
