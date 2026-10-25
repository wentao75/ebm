// push-api.test.js —— /api/push/status 与 /api/push/send 的接口契约（假设备，全程离线）
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { makeLibrary, startServer, tmpDir, cleanup } = require("./helper");

let lib, dataDir, srv, dev;

/** 假设备：GET /config + POST /upload（字段 sfile） */
function startFakeDevice() {
  const received = [];
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fileSizeLimit: 200 }));
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
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) }));
  });
}

async function postJson(base, p, body) {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  lib = await makeLibrary();
  dataDir = await tmpDir("ebm-push-api-");
  dev = await startFakeDevice();
  // 服务端通过 data/push-target.json 读取目标（运行时不依赖 env，便于用户改地址）
  await fsp.writeFile(path.join(dataDir, "push-target.json"), JSON.stringify({ url: dev.url }), "utf-8");
  srv = await startServer({ libraryRoot: lib.root, dataDir });
});

after(async () => {
  if (srv) await srv.stop();
  if (dev) await dev.close();
  if (lib) await cleanup(lib.root);
  if (dataDir) await cleanup(dataDir);
});

test("GET /api/push/status：回报目标、在线状态与文件大小上限", async () => {
  const r = await (await fetch(`${srv.base}/api/push/status`)).json();
  assert.equal(r.reachable, true);
  assert.equal(r.target, dev.url);
  assert.equal(r.fileSizeLimit, 200);
});

test("POST /api/push/send：把书库里的文件原样推送到设备（字段 sfile）", async () => {
  const rel = "历史/万历十五年.txt";
  const res = await postJson(srv.base, "/api/push/send", { rel });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.bytes, await fsp.stat(path.join(lib.root, rel)).then((s) => s.size));
  assert.equal(dev.received.length, 1);
  assert.equal(dev.received[0].field, "sfile");
  assert.equal(dev.received[0].filename, "万历十五年.txt");
  const original = await fsp.readFile(path.join(lib.root, rel));
  assert.ok(dev.received[0].bytes.equals(original), "设备收到的字节必须与书库文件一致");
});

test("POST /api/push/send：缺参/路径非法/文件不存在都给出明确错误", async () => {
  assert.equal((await postJson(srv.base, "/api/push/send", {})).status, 400);
  assert.equal((await postJson(srv.base, "/api/push/send", { rel: "../../etc/passwd" })).status, 403);
  const missing = await postJson(srv.base, "/api/push/send", { rel: "历史/不存在的书.pdf" });
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /文件不存在/);
  assert.equal(dev.received.length, 1, "失败路径不应产生推送");
});

test("GET /api/push/status：设备离线时 reachable=false（不抛错）", async () => {
  const offline = await startFakeDevice();
  await offline.close(); // 立刻关掉，端口不再监听
  const dataDir2 = await tmpDir("ebm-push-api2-");
  await fsp.writeFile(path.join(dataDir2, "push-target.json"), JSON.stringify({ url: offline.url }), "utf-8");
  const srv2 = await startServer({ libraryRoot: lib.root, dataDir: dataDir2 });
  try {
    const r = await (await fetch(`${srv2.base}/api/push/status`)).json();
    assert.equal(r.reachable, false);
    assert.ok(String(r.error || "").length > 0);
    const send = await postJson(srv2.base, "/api/push/send", { rel: "历史/万历十五年.txt" });
    assert.equal(send.status, 502);
    assert.match(String(send.body.error), /未连接/);
  } finally {
    await srv2.stop();
    await cleanup(dataDir2);
  }
});
