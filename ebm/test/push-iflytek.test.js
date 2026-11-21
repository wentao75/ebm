// push-iflytek.test.js —— 讯飞阅读「WiFi 传书」协议（/doupload + 字段 file）
//
// 该 App 的传书页面与原厂传书不同：
//   GET  /            → WiFi 传书页面（内含 common.js 脚本）
//   GET  /js/common.js → config.url = "/doupload?dir=/sdcard/&id=<uuid>"
//   POST /doupload?dir=/sdcard/&id=<uuid> → multipart 字段 file → "ok"
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-push-iflytek-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_DATA_DIR = TMP;

const { probeDevice, pushFile, setPushTarget } = require("../dist/push.js");

const PAGE = `<!DOCTYPE html><html><head><title>WiFi 传书</title>
<script src="/storage/emulated/0/iflytek/iflytek_ainote/root/js/common.js"></script></head>
<body><div id="drag_area">选择文件上传</div></body></html>`;
const COMMON_JS = `var config = { url : "http://"+location.host+"/doupload?dir=/sdcard/&id=65ea1d11-5bcc-41b4-b89e-c43a93472175", fileLimitSize: 300 };`;

async function fakeIflytek({ received } = {}) {
  const rec = received || [];
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && req.url.includes("common.js")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(COMMON_JS);
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/doupload")) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        rec.push({
          url: req.url,
          field: /name="([^"]+)"/.exec(buf.toString("latin1"))?.[1],
          filename: /filename="([^"]+)"/.exec(buf.toString("utf8"))?.[1],
          bytes: buf.length,
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)), rec };
}

test("讯飞阅读传书：能识别设备并上传成功（字段 file）", async () => {
  const dev = await fakeIflytek();
  await fsp.mkdir(TMP, { recursive: true });
  const file = path.join(TMP, "测试书.epub");
  await fsp.writeFile(file, Buffer.from("EPUB-TEST-CONTENT"));
  try {
    await setPushTarget(dev.base);
    const st = await probeDevice();
    assert.equal(st.reachable, true, st.error);
    assert.equal(st.mode, "iflytek");
    assert.match(st.uploadUrl || "", /\/doupload\?dir=\/sdcard\/&id=/);
    const r = await pushFile(file, "测试书.epub");
    assert.equal(r.ok, true, r.error);
    assert.equal(dev.rec.length, 1);
    assert.equal(dev.rec[0].field, "file", "讯飞阅读要求字段名 file");
    assert.equal(dev.rec[0].filename, "测试书.epub");
    assert.ok(dev.rec[0].bytes > 0);
  } finally {
    await dev.close();
    await fsp.rm(TMP, { recursive: true, force: true });
  }
});

test("讯飞阅读传书：页面没打开时给出明确提示", async () => {
  await fsp.mkdir(TMP, { recursive: true });
  const file = path.join(TMP, "x.epub");
  await fsp.writeFile(file, "x");
  try {
    await setPushTarget("http://127.0.0.1:1"); // 必然连不上
    const st = await probeDevice(800);
    assert.equal(st.reachable, false);
    const r = await pushFile(file, "x.epub");
    assert.equal(r.ok, false);
    assert.ok(/设备未连接|传书/.test(r.error || ""), r.error);
  } finally {
    await fsp.rm(TMP, { recursive: true, force: true });
  }
});
