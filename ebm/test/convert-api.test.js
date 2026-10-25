// convert-api.test.js —— PDF→EPUB 接口契约 + 转换产物推送（假设备，全程离线）
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { makeLibrary, makeTextPdf, startServer, tmpDir, cleanup } = require("./helper");

let lib, dataDir, srv, dev;

function startFakeDevice(limit = 200) {
  const received = [];
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fileSizeLimit: limit }));
      return;
    }
    if (req.method === "POST" && req.url === "/upload") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        const headEnd = buf.indexOf("\r\n\r\n");
        const tailStart = buf.lastIndexOf("\r\n--");
        received.push({
          field: /name="([^"]+)"/.exec(text)?.[1],
          filename: /filename="([^"]+)"/.exec(text)?.[1],
          bytes: buf.subarray(headEnd + 4, tailStart),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"msg":"上传成功"}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((x) => srv.close(x)) })));
}

async function postJson(base, p, body) {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 文本 PDF 放一个到书库（供转换用；书库扫描会收录它） */
async function addTextBook(root) {
  const rel = "文本/测试文本书.pdf";
  await makeTextPdf(path.join(root, rel), 4);
  return rel;
}

before(async () => {
  lib = await makeLibrary();
  await makeTextPdf(path.join(lib.root, "文本/测试文本书.pdf"), 4);
  dataDir = await tmpDir("ebm-convert-api-");
  dev = await startFakeDevice();
  await fsp.writeFile(path.join(dataDir, "push-target.json"), JSON.stringify({ url: dev.url }), "utf-8");
  srv = await startServer({ libraryRoot: lib.root, dataDir });
});

after(async () => {
  if (srv) await srv.stop();
  if (dev) await dev.close();
  if (lib) await cleanup(lib.root);
  if (dataDir) await cleanup(dataDir);
});

test("POST /api/convert：文本版 PDF 转换成功，返回章节/字数/大小", async () => {
  const rel = "文本/测试文本书.pdf";
  const r = await postJson(srv.base, "/api/convert", { rel });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.ok(["text", "hybrid"].includes(String(r.body.kind)));
  assert.ok((r.body.chapters || 0) >= 1, `章节数 ${r.body.chapters}`);
  assert.ok((r.body.sizeBytes || 0) > 0);
  assert.ok(String(r.body.id || "").length >= 8);
  // 记录下来给后续用例
  globalThis.__convId = r.body.id;
});

test("GET /api/converted/:id：能下载到合法 EPUB（PK 魔数 + epub 内容类型）", async () => {
  const id = globalThis.__convId;
  assert.ok(id, "前置用例应已产生 id");
  const res = await fetch(`${srv.base}/api/converted/${id}`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("content-type")), /epub/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(buf.toString("latin1").includes("application/epub+zip"));
});

test("POST /api/convert：非 PDF / 不存在的文件给出明确错误", async () => {
  const notPdf = await postJson(srv.base, "/api/convert", { rel: "历史/万历十五年.txt" });
  assert.equal(notPdf.status, 400);
  assert.match(String(notPdf.body.error), /只支持 PDF/);

  const missing = await postJson(srv.base, "/api/convert", { rel: "文本/不存在.pdf" });
  assert.equal(missing.status, 404);

  const bad = await postJson(srv.base, "/api/convert", { rel: "../../etc/passwd" });
  assert.equal(bad.status, 403);
});

test("POST /api/push/send {converted}：把转换后的 EPUB 推送到设备", async () => {
  const id = globalThis.__convId;
  const before = dev.received.length;
  const r = await postJson(srv.base, "/api/push/send", { converted: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(dev.received.length, before + 1);
  const got = dev.received[dev.received.length - 1];
  assert.equal(got.field, "sfile");
  assert.match(String(got.filename), /\.epub$/, `文件名应为 epub：${got.filename}`);
  assert.ok(got.bytes.subarray(0, 2).toString("latin1") === "PK", "设备收到的应是 EPUB");
});
