// push.test.js —— 「发送到阅读器」：探测设备、流式 multipart 推送、错误路径
//
// 用本地假设备（http server）模拟讯飞起点阅读器的两个接口：
//   GET  /config → {"fileSizeLimit": N}
//   POST /upload → multipart 字段 sfile → {"msg":"上传成功"}
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-push-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_DATA_DIR = TMP; // 必须在 require 之前（paths.ts 在模块加载时解析数据目录）

const { probeDevice, pushFile, pushTarget, DEFAULT_TARGET } = require("../dist/push.js");

/** 启动假设备；limit 为 /config 返回的 MB 上限，status 控制 /upload 响应码 */
async function fakeDevice({ limit = 200, status = 200, respond = '{"msg":"上传成功"}' } = {}) {
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
        const text = buf.toString("latin1");
        const field = /name="([^"]+)"/.exec(text)?.[1];
        // 文件名可能是 UTF-8 字节：从原始 Buffer 中按 UTF-8 再取一次
        const utf8 = buf.toString("utf8");
        const filename = /filename="([^"]+)"/.exec(utf8)?.[1];
        // 取出文件内容（分片头之后的字节到结尾边界之前）
        const headEnd = buf.indexOf("\r\n\r\n");
        const tailStart = buf.lastIndexOf("\r\n--");
        received.push({ field, filename, bytes: buf.subarray(headEnd + 4, tailStart) });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(respond);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((r) => srv.close(r)),
  };
}

async function writeTemp(name, content) {
  await fsp.mkdir(TMP, { recursive: true });
  const p = path.join(TMP, name);
  await fsp.writeFile(p, content);
  return p;
}

test("推送目标优先级：env > data/push-target.json > 默认地址", async () => {
  delete process.env.EBM_PUSH_TARGET;
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.rm(path.join(TMP, "push-target.json"), { force: true });
  assert.equal(await pushTarget(), DEFAULT_TARGET, "未配置时用默认地址");

  await fsp.writeFile(path.join(TMP, "push-target.json"), JSON.stringify({ url: "http://127.0.0.1:9/" }), "utf-8");
  assert.equal(await pushTarget(), "http://127.0.0.1:9", "配置文件生效且去掉尾部斜杠");

  process.env.EBM_PUSH_TARGET = "http://127.0.0.1:1234";
  assert.equal(await pushTarget(), "http://127.0.0.1:1234", "env 优先于配置文件");
  delete process.env.EBM_PUSH_TARGET;
});

test("probeDevice：在线时读到文件大小上限，离线时给出错误", async () => {
  const dev = await fakeDevice({ limit: 200 });
  process.env.EBM_PUSH_TARGET = dev.url;
  const ok = await probeDevice();
  assert.equal(ok.reachable, true);
  assert.equal(ok.fileSizeLimit, 200);
  assert.equal(ok.target, dev.url);
  await dev.close();

  // 关掉后应判为离线（端口已关闭）
  const bad = await probeDevice(1500);
  assert.equal(bad.reachable, false);
  assert.ok(String(bad.error || "").length > 0, "离线要带错误原因");
  delete process.env.EBM_PUSH_TARGET;
});

test("pushFile：按设备页面约定，multipart 字段 sfile + 原始文件名 + 字节一致", async () => {
  const dev = await fakeDevice();
  process.env.EBM_PUSH_TARGET = dev.url;
  const body = Buffer.from("这是一个假的电子书内容\n《测试书》某人\n" + "x".repeat(5000));
  const file = await writeTemp("测试书.epub", body);

  const r = await pushFile(file, "测试书.epub");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bytes, body.length);
  assert.equal(r.message, "上传成功");
  assert.equal(dev.received.length, 1);

  const got = dev.received[0];
  assert.equal(got.field, "sfile", "字段名必须是 sfile（设备页面 JS 写死的）");
  assert.equal(got.filename, "测试书.epub", "UTF-8 中文文件名要原样送达");
  assert.ok(got.bytes.equals(body), "推送的字节必须与文件完全一致");
  await dev.close();
  delete process.env.EBM_PUSH_TARGET;
});

test("pushFile：超过设备上限时拒绝推送（不发请求）", async () => {
  const dev = await fakeDevice({ limit: 1 }); // 上限 1MB
  process.env.EBM_PUSH_TARGET = dev.url;
  const big = Buffer.alloc(2 * 1024 * 1024, 7);
  const file = await writeTemp("大书.pdf", big);
  const r = await pushFile(file, "大书.pdf");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /超过阅读器上限 1MB/);
  assert.equal(dev.received.length, 0, "超限时不应真正上传");
  await dev.close();
  delete process.env.EBM_PUSH_TARGET;
});

test("pushFile：设备返回非 200 时报错并带设备原文", async () => {
  const dev = await fakeDevice({ status: 500, respond: '{"msg":"磁盘已满"}' });
  process.env.EBM_PUSH_TARGET = dev.url;
  const file = await writeTemp("书.epub", Buffer.from("x".repeat(100)));
  const r = await pushFile(file, "书.epub");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /HTTP 500/);
  assert.match(String(r.error), /磁盘已满/);
  await dev.close();
  delete process.env.EBM_PUSH_TARGET;
});

test("pushFile：文件不存在 / 空文件直接拒绝", async () => {
  process.env.EBM_PUSH_TARGET = "http://127.0.0.1:9";
  const missing = await pushFile(path.join(TMP, "不存在.epub"), "不存在.epub");
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /找不到文件/);

  const empty = await writeTemp("空.epub", Buffer.alloc(0));
  const r = await pushFile(empty, "空.epub");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /文件为空/);
  delete process.env.EBM_PUSH_TARGET;
});
