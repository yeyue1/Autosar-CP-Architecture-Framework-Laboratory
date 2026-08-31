import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import {
  access,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const ALLOWED_ROOT_FILES = new Set([
  "/",
  "/index.html",
  "/styles.css",
  "/favicon.ico",
  "/favicon.svg",
]);
const ALLOWED_SOURCE_EXTENSIONS = new Set([".css", ".js", ".mjs"]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
]);
const SENSITIVE_SEGMENTS = new Set([
  ".env",
  ".git",
  "README",
  "README.md",
  "reference",
  "scripts",
  "server",
  "server.mjs",
  "start.cmd",
  "start.ps1",
  "tests",
]);

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

function safeDecodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function containsEncodedBackslash(rawPathname) {
  return /%5c/i.test(rawPathname);
}

function normalizeRequestPath(rawUrl) {
  const input = typeof rawUrl === "string" && rawUrl.length > 0 ? rawUrl : "/";
  const queryIndex = input.indexOf("?");
  const hashIndex = input.indexOf("#");
  const cutIndex = [queryIndex, hashIndex]
    .filter((value) => value >= 0)
    .reduce((min, value) => Math.min(min, value), input.length);
  const rawPathname = input.slice(0, cutIndex) || "/";

  if (!rawPathname.startsWith("/")) {
    return { error: 400, message: "Malformed request URL." };
  }

  if (rawPathname.includes("\0") || rawPathname.includes("\\")) {
    return { error: 400, message: "Invalid path." };
  }

  if (containsEncodedBackslash(rawPathname)) {
    return { error: 400, message: "Encoded backslashes are not allowed." };
  }

  const decodedSegments = [];
  for (const rawSegment of rawPathname.split("/")) {
    if (rawSegment === "") {
      continue;
    }

    const decoded = safeDecodeSegment(rawSegment);
    if (decoded === null) {
      return { error: 400, message: "Path decoding failed." };
    }

    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      return { error: 400, message: "Path traversal is not allowed." };
    }

    if (SENSITIVE_SEGMENTS.has(decoded)) {
      return { error: 404, message: "Not found." };
    }

    decodedSegments.push(decoded);
  }

  return {
    pathname:
      decodedSegments.length === 0 ? "/" : `/${decodedSegments.join("/")}`,
  };
}

function routeToRelativePath(pathname) {
  if (pathname === "/healthz") {
    return { type: "healthz" };
  }

  if (ALLOWED_ROOT_FILES.has(pathname)) {
    if (pathname === "/" || pathname === "/index.html") {
      return { relativePath: "index.html" };
    }

    return { relativePath: pathname.slice(1) };
  }

  if (pathname.startsWith("/src/")) {
    const extension = path.extname(pathname);
    if (!ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
      return { error: 404, message: "Not found." };
    }

    return { relativePath: pathname.slice(1) };
  }

  if (pathname.startsWith("/assets/")) {
    const extension = path.extname(pathname);
    if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
      return { error: 404, message: "Not found." };
    }

    return { relativePath: pathname.slice(1) };
  }

  if (pathname.startsWith("/docs/")) {
    if (path.extname(pathname) !== ".md") {
      return { error: 404, message: "Not found." };
    }

    return { relativePath: pathname.slice(1) };
  }

  return { error: 404, message: "Not found." };
}

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream";
}

function applySecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store, max-age=0");
}

function send(response, statusCode, body, contentType, method = "GET") {
  applySecurityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(body);
}

async function resolveSafeFile(rootDir, relativePath) {
  const absolutePath = path.resolve(rootDir, relativePath);
  const realRoot = await realpath(rootDir);

  let realFilePath;
  try {
    realFilePath = await realpath(absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        return { error: 404, message: "Not found." };
      }
    }
    throw error;
  }

  const relativeRealPath = path.relative(realRoot, realFilePath);
  if (
    relativeRealPath.startsWith("..") ||
    path.isAbsolute(relativeRealPath) ||
    relativeRealPath === ""
  ) {
    return { error: 404, message: "Not found." };
  }

  const fileStats = await stat(realFilePath);
  if (!fileStats.isFile()) {
    return { error: 404, message: "Not found." };
  }

  return { absolutePath, realFilePath, fileStats };
}

export function createStaticServer(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const configuredPort = options.port ?? DEFAULT_PORT;

  const server = createHttpServer(async (request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      applySecurityHeaders(response);
      response.setHeader("Allow", "GET, HEAD");
      response.statusCode = 405;
      response.end("Method Not Allowed");
      return;
    }

    const normalized = normalizeRequestPath(request.url ?? "/");
    if (normalized.error) {
      send(
        response,
        normalized.error,
        normalized.message,
        "text/plain; charset=utf-8",
        method,
      );
      return;
    }

    const route = routeToRelativePath(normalized.pathname);
    if (route.error) {
      send(
        response,
        route.error,
        route.message,
        "text/plain; charset=utf-8",
        method,
      );
      return;
    }

    if (route.type === "healthz") {
      const body = JSON.stringify({
        ok: true,
        root,
        time: new Date().toISOString(),
      });
      send(response, 200, body, "application/json; charset=utf-8", method);
      return;
    }

    const resolved = await resolveSafeFile(root, route.relativePath);
    if (resolved.error) {
      if (route.relativePath.startsWith("favicon")) {
        send(
          response,
          404,
          "Not found.",
          "text/plain; charset=utf-8",
          method,
        );
        return;
      }

      send(
        response,
        resolved.error,
        resolved.message,
        "text/plain; charset=utf-8",
        method,
      );
      return;
    }

    try {
      const contents = await readFile(resolved.realFilePath);
      applySecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypeFor(resolved.realFilePath));
      response.setHeader("Content-Length", resolved.fileStats.size);
      if (method === "HEAD") {
        response.end();
        return;
      }
      response.end(contents);
    } catch {
      applySecurityHeaders(response);
      response.statusCode = 500;
      response.end("Internal Server Error");
    }
  });

  async function listen(port = configuredPort) {
    await access(root);

    return new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off("listening", handleListening);
        if (error && typeof error === "object" && "code" in error) {
          if (error.code === "EADDRINUSE") {
            reject(
              new Error(
                `Port ${port} is already in use on ${DEFAULT_HOST}. Stop the other process or choose a different port with --port.`,
              ),
            );
            return;
          }
        }
        reject(error);
      };

      const handleListening = () => {
        server.off("error", handleError);
        const address = server.address();
        const actualPort =
          address && typeof address === "object" ? address.port : port;
        resolve({
          host: DEFAULT_HOST,
          port: actualPort,
          url: `http://${DEFAULT_HOST}:${actualPort}/`,
        });
      };

      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(port, DEFAULT_HOST);
    });
  }

  return {
    root,
    server,
    listen,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export const createServer = createStaticServer;

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    open: false,
    port: DEFAULT_PORT,
  };

  while (args.length > 0) {
    const current = args.shift();
    if (current === "--open") {
      parsed.open = true;
      continue;
    }

    if (current === "--port") {
      const value = args.shift();
      const port = Number(value);
      if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Expected --port <1-65535>.");
      }
      parsed.port = port;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return parsed;
}

async function openBrowser(url) {
  const platform = process.platform;
  if (platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  if (platform === "darwin") {
    const child = spawn("open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function runCli() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const app = createStaticServer({
    root: path.dirname(fileURLToPath(import.meta.url)),
    port: parsedArgs.port,
  });

  try {
    const details = await app.listen(parsedArgs.port);
    console.log(details.url);
    if (parsedArgs.open) {
      await openBrowser(details.url);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  runCli();
}
