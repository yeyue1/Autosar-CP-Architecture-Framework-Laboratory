import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleCandidates = [
  "src/engine.mjs",
  "src/engine.js",
  "src/boot-simulator.mjs",
  "src/boot-simulator.js",
  "src/simulator/boot-simulator.mjs",
  "src/simulator/boot-simulator.js",
  "src/BootSimulator.mjs",
  "src/BootSimulator.js",
];

function parseArgs(argv) {
  const parsed = {
    duration: 250,
    out: null,
    scenario: "normal",
  };

  const args = [...argv];
  while (args.length > 0) {
    const current = args.shift();
    if (current === "--scenario") {
      const value = args.shift();
      if (!["normal", "pll-failure", "nvm-slow", "nvm-crc", "can-bus-off"].includes(value)) {
        throw new Error("Unsupported scenario.");
      }
      parsed.scenario = value;
      continue;
    }

    if (current === "--duration") {
      const value = Number(args.shift());
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("Expected --duration <positive number>.");
      }
      parsed.duration = value;
      continue;
    }

    if (current === "--out") {
      const value = args.shift();
      if (!value) {
        throw new Error("Expected --out <file>.");
      }
      parsed.out = path.resolve(root, value);
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return parsed;
}

async function importSimulatorModule() {
  for (const candidate of moduleCandidates) {
    try {
      const moduleUrl = pathToFileURL(path.join(root, candidate)).href;
      return await import(moduleUrl);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
        continue;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error("BootSimulator module was not found in src/.");
}

async function materializeTrace(parsedArgs, imported) {
  const scenarioOptions = {
    duration: parsedArgs.duration,
    scenario: parsedArgs.scenario,
  };

  if (typeof imported.exportTrace === "function") {
    return imported.exportTrace(scenarioOptions);
  }

  if (typeof imported.runScenario === "function") {
    return imported.runScenario(scenarioOptions);
  }

  if (typeof imported.createBootSimulator === "function") {
    const simulator = await imported.createBootSimulator(scenarioOptions);
    return extractTrace(simulator, parsedArgs.duration);
  }

  if (typeof imported.BootSimulator === "function") {
    const simulator = new imported.BootSimulator(scenarioOptions);
    return extractTrace(simulator, parsedArgs);
  }

  throw new Error("No supported BootSimulator export was found.");
}

function compactStepSnapshot(snapshot) {
  return {
    cursor: snapshot.cursor,
    phase: snapshot.phase,
    status: snapshot.status,
    time: snapshot.time,
    ecum: snapshot.ecum,
    bswm: snapshot.bswm,
    os: snapshot.os,
    rte: snapshot.rte,
    nvm: snapshot.nvm,
    comm: snapshot.comm,
    can: snapshot.can,
    warnings: snapshot.warnings,
    lastLog: snapshot.logs.at(-1) ?? null,
    activeModules: snapshot.activeModules,
  };
}

async function extractTrace(simulator, parsedArgs) {
  const methods = [
    "exportTrace",
    "toTrace",
    "run",
    "runScenario",
    "simulate",
  ];

  for (const method of methods) {
    if (typeof simulator?.[method] === "function") {
      return simulator[method]({
        duration: parsedArgs.duration,
        scenario: parsedArgs.scenario,
      });
    }
  }

  if (Array.isArray(simulator?.trace)) {
    return simulator.trace;
  }

  if (typeof simulator?.step === "function" && typeof simulator?.tick === "function") {
    const boot = [];
    let snapshot = simulator.getSnapshot?.() ?? null;

    while (true) {
      snapshot = simulator.step();
      boot.push(compactStepSnapshot(snapshot));
      if (
        snapshot.status === "blocked" ||
        snapshot.status === "running" ||
        snapshot.cursor >= 42
      ) {
        break;
      }
    }

    const runtime =
      snapshot?.status === "running"
        ? simulator.tick(parsedArgs.duration)
        : snapshot;

    return {
      scenario: parsedArgs.scenario,
      requestedDurationMs: parsedArgs.duration,
      boot,
      final: runtime,
    };
  }

  throw new Error("BootSimulator instance does not expose a supported trace method.");
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const imported = await importSimulatorModule();
  const trace = await materializeTrace(parsedArgs, imported);
  const payload = JSON.stringify(trace, null, 2);

  if (parsedArgs.out) {
    const outDir = path.dirname(parsedArgs.out);
    await mkdir(outDir, { recursive: true });
    await writeFile(parsedArgs.out, payload, "utf8");
  }

  process.stdout.write(`${payload}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
