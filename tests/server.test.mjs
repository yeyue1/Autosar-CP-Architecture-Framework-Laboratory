import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStaticServer } from "../server.mjs";

async function makeFixture() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "autosar-server-"));
  await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "assets"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "docs"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "knowledge"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "tests"), { recursive: true });

  await writeFile(path.join(fixtureRoot, "index.html"), "<!doctype html><title>AUTOSAR</title>", "utf8");
  await writeFile(path.join(fixtureRoot, "styles.css"), "body { color: #111; }", "utf8");
  await writeFile(path.join(fixtureRoot, "src", "app.mjs"), "export const ready = true;", "utf8");
  await writeFile(path.join(fixtureRoot, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8");
  await writeFile(path.join(fixtureRoot, "docs", "note.md"), "# note", "utf8");
  await writeFile(path.join(fixtureRoot, "knowledge", "corpus.json"), '{"version":1,"documents":[]}', "utf8");
  await writeFile(path.join(fixtureRoot, "knowledge", "01-startup.md"), "# 启动", "utf8");
  await writeFile(path.join(fixtureRoot, "knowledge", "secret.txt"), "nope", "utf8");
  await writeFile(path.join(fixtureRoot, "tests", "secret.mjs"), "export const secret = 1;", "utf8");

  return fixtureRoot;
}

async function withServer(run) {
  const fixtureRoot = await makeFixture();
  const app = createStaticServer({ root: fixtureRoot, port: 0 });

  try {
    const details = await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", () => {
        const address = app.server.address();
        resolve({
          host: "127.0.0.1",
          port: address.port,
          url: `http://127.0.0.1:${address.port}/`,
        });
      });
    });

    await run({ ...details, fixtureRoot, app });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    const realFixtureRoot = path.resolve(fixtureRoot);
    const tempBase = path.resolve(tmpdir());
    assert.ok(realFixtureRoot.startsWith(tempBase), "fixture cleanup must stay inside tempdir");
    // Windows 上删除目录联接（junction）时 rm 可能先返回 ENOTEMPTY，重试即可。
    await rm(realFixtureRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}

async function requestRaw({ host, port, method = "GET", path: requestPath }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        method,
        path: requestPath,
        port,
      },
      async (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            body,
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("serves root html and allows query strings", async () => {
  await withServer(async ({ url }) => {
    const { response, text } = await request(`${url}?step=1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(text, /AUTOSAR/);
  });
});

test("HEAD returns headers without a body", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}styles.css?cache=bust`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/css/);
    assert.equal(await response.text(), "");
  });
});

test("healthz returns json", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}healthz`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const payload = await response.json();
    assert.equal(payload.ok, true);
  });
});

test("knowledge corpus is served as json and markdown is readable", async () => {
  await withServer(async ({ url }) => {
    const corpus = await fetch(`${url}knowledge/corpus.json`);
    assert.equal(corpus.status, 200);
    assert.match(corpus.headers.get("content-type") ?? "", /application\/json/);
    assert.equal((await corpus.json()).version, 1);

    const note = await fetch(`${url}knowledge/01-startup.md`);
    assert.equal(note.status, 200);
    assert.match(note.headers.get("content-type") ?? "", /text\/markdown/);

    // 只放行 .json 与 .md：其它扩展名一律 404，避免把 knowledge/ 变成任意文件出口。
    const blocked = await fetch(`${url}knowledge/secret.txt`);
    assert.equal(blocked.status, 404);
  });
});

test("knowledge route keeps traversal protection", async () => {
  await withServer(async ({ host, port }) => {
    const traversal = await requestRaw({
      host,
      path: "/knowledge/%2e%2e/server.mjs",
      port,
    });
    assert.equal(traversal.statusCode, 400);

    const nested = await requestRaw({
      host,
      path: "/knowledge/..%2fserver.mjs",
      port,
    });
    assert.equal(nested.statusCode, 400);
  });
});

test("missing and disallowed methods are rejected", async () => {
  await withServer(async ({ url }) => {
    const missing = await fetch(`${url}src/missing.mjs`);
    assert.equal(missing.status, 404);

    const method = await fetch(url, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET, HEAD");
  });
});

test("encoded traversal and sensitive paths are blocked", async () => {
  await withServer(async ({ host, port, url }) => {
    const traversal = await requestRaw({
      host,
      path: "/src/%2e%2e/server.mjs",
      port,
    });
    assert.equal(traversal.statusCode, 400);

    const backslash = await requestRaw({
      host,
      path: "/src%5Capp.mjs",
      port,
    });
    assert.equal(backslash.statusCode, 400);

    const sensitive = await fetch(`${url}tests/secret.mjs`);
    assert.equal(sensitive.status, 404);
  });
});

test("symlink escape is blocked", async (t) => {
  await withServer(async ({ url, fixtureRoot }) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "autosar-server-outside-"));
    const linkPath = path.join(fixtureRoot, "src", "link");
    let linkCreated = false;
    try {
      await writeFile(path.join(outsideDir, "escape.mjs"), "export const escaped = true;", "utf8");
      try {
        await symlink(outsideDir, linkPath, "junction");
        linkCreated = true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
          t.skip("junction creation is not permitted in this environment");
          return;
        }
        throw error;
      }

      const escaped = await fetch(`${url}src/link/escape.mjs`);
      assert.equal(escaped.status, 404);
    } finally {
      // Windows 无法在目录联接仍存在时递归删除父目录（ENOTEMPTY），
      // 必须先解链，再清理外部目录与夹具。
      if (linkCreated) {
        await rm(linkPath, { force: true, recursive: true }).catch(() => {});
      }
      const realOutsideDir = path.resolve(outsideDir);
      const tempBase = path.resolve(tmpdir());
      assert.ok(realOutsideDir.startsWith(tempBase), "outside cleanup must stay inside tempdir");
      await rm(realOutsideDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
