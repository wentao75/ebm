// device.test.js —— 设备文件管理（讯飞阅读传书页：列清单 / 删除 / 下载）
//
// 用本地假设备复刻真机协议：
//   GET  /             → 传书页（含 common.js 与「传书」字样，供 probeDevice 识别 iflytek 模式）
//   GET  /common.js    → 含 /doupload?...&id=…（上传地址）
//   GET  /fils         → {code:200, data:[{name,size,path,date}]}
//   POST /dodelete     → 表单 fname + path → {code:200,msg:"成功"}
//   GET  /sdcard/<dir>/<name> → 文件本体
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_DATA_DIR = TMP; // 必须在 require 之前（paths.ts 在模块加载时解析）

const { deleteDeviceFile, deviceContentType, deviceFiles, deviceFilesAll, discoverTransferPages, openDeviceFile, probePort, safeSegment, scanPorts } = require("../dist/device.js");

/** 假讯飞传书服务；files 为书架内容，deleted 记录删除调用 */
async function fakeIflytek(files = [], opts = {}) {
  const deleted = [];
  const bodies = opts.bodies || new Map();
  const page = `<!DOCTYPE html><html><body><p>WiFi 传书</p><script src="/common.js"></script></body></html>`;
  const common = `var config = { url : "http://"+location.host+"/doupload?dir=/sdcard/&id=test-uuid" };`;
  const srv = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/config") {
      req.socket.destroy(); // 讯飞传书没有 /config：直接断开
      return;
    }
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (url === "/common.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(common);
      return;
    }
    if (url === "/fils") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: files }));
      return;
    }
    if (url === "/dodelete" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
        deleted.push({ fname: form.get("fname"), path: form.get("path") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 200, msg: "成功" }));
      });
      return;
    }
    if (url.startsWith("/sdcard/")) {
      const key = decodeURIComponent(url);
      const body = bodies.get(key);
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    deleted,
    close: () => new Promise((r) => srv.close(r)),
  };
}

async function setTarget(url) {
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.writeFile(path.join(TMP, "push-target.json"), JSON.stringify({ url }), "utf-8");
}

test("safeSegment：拒绝分隔符、..、空串", () => {
  assert.equal(safeSegment("助推.epub"), true);
  assert.equal(safeSegment("书架"), true);
  assert.equal(safeSegment(""), false);
  assert.equal(safeSegment("../etc/passwd"), false);
  assert.equal(safeSegment("a/b.epub"), false);
  assert.equal(safeSegment("a\\b.epub"), false);
});

test("deviceContentType：按扩展名给 Content-Type", () => {
  assert.equal(deviceContentType("x.pdf"), "application/pdf");
  assert.equal(deviceContentType("x.EPUB"), "application/epub+zip");
  assert.equal(deviceContentType("x.txt"), "text/plain; charset=utf-8");
  assert.equal(deviceContentType("x.bin"), "application/octet-stream");
});

test("deviceFiles：识别讯飞模式，列出书架并标出重复组", async () => {
  const dev = await fakeIflytek([
    { date: 1795747712000, name: "助推.epub", path: "书架", size: 25621233 },
    { date: 1795747675000, name: "博弈论平话.epub", path: "书架", size: 737450 },
    { date: 1795747000000, name: "博弈论平话.epub", path: "书架", size: 737450 },
    { date: 1795746000000, name: "书.epub", path: "书架", size: 100 },
    { date: 1795746000000, name: "书.sdr", path: "书架", size: 10 },
  ]);
  await setTarget(dev.url);
  try {
    const view = await deviceFiles(5000);
    assert.equal(view.ok, true, view.error || "");
    assert.equal(view.reachable, true);
    assert.equal(view.mode, "iflytek");
    assert.equal(view.canDelete, true, "讯飞通道支持删除");
    assert.equal(view.files.length, 4, ".sdr 进度目录不算书");
    assert.equal(view.duplicateGroups.length, 1);
    assert.equal(view.duplicateGroups[0].names.length, 2);
    const dup = view.files.filter((f) => f.duplicate);
    assert.equal(dup.length, 2, "两份同名书都要标记重复");
    assert.equal(view.files.find((f) => f.name === "助推.epub").size, 25621233);
  } finally {
    await dev.close();
  }
});

test("deviceFiles：设备未连接时给出可读错误且 ok=false", async () => {
  await setTarget("http://127.0.0.1:1");
  const view = await deviceFiles(1500);
  assert.equal(view.ok, false);
  assert.equal(view.reachable, false);
  assert.match(view.error || "", /未连接|超时|ECONNREFUSED|断开/);
  assert.deepEqual(view.files, []);
});

test("deleteDeviceFile：按 fname + path 发表单，成功返回 message", async () => {
  const dev = await fakeIflytek([{ date: 1, name: "助推.epub", path: "书架", size: 10 }]);
  await setTarget(dev.url);
  try {
    const r = await deleteDeviceFile("助推.epub", "书架");
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.message, "成功");
    assert.deepEqual(dev.deleted, [{ fname: "助推.epub", path: "书架" }]);
  } finally {
    await dev.close();
  }
});

test("deleteDeviceFile：非法名直接拒绝，不发请求", async () => {
  const dev = await fakeIflytek([]);
  await setTarget(dev.url);
  try {
    const r = await deleteDeviceFile("../../etc/passwd", "书架");
    assert.equal(r.ok, false);
    assert.match(r.error || "", /不合法/);
    assert.equal(dev.deleted.length, 0);
  } finally {
    await dev.close();
  }
});

test("openDeviceFile：按 /sdcard/<dir>/<name> 取回文件流", async () => {
  const body = Buffer.from("EPUB-BYTES");
  const dev = await fakeIflytek([], { bodies: new Map([["/sdcard/书架/助推.epub", body]]) });
  await setTarget(dev.url);
  try {
    const r = await openDeviceFile("助推.epub", "书架");
    assert.ok(r, "应拿到流");
    const chunks = [];
    for await (const c of r.stream) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), "EPUB-BYTES");
    assert.equal(r.length, String(body.length));

    const missing = await openDeviceFile("没有这本.epub", "书架");
    assert.equal(missing, null, "设备上没有的文件返回 null");
  } finally {
    await dev.close();
  }
});

test("deviceFilesAll：同时列出多个传书页（当前目标 + 历史地址）", async () => {
  const a = await fakeIflytek([{ date: 2, name: "甲.epub", path: "书架", size: 100 }]);
  const b = await fakeIflytek([{ date: 1, name: "乙.epub", path: "书架", size: 200 }]);
  await setTarget(a.url);
  await fsp.writeFile(
    path.join(TMP, "device-targets.json"),
    JSON.stringify({ targets: [{ url: b.url, label: "第二个传书页" }] }),
    "utf-8",
  );
  try {
    const { groups } = await deviceFilesAll(4000);
    assert.equal(groups.length, 2, "两个地址都要探测");
    assert.deepEqual(groups.map((g) => g.files.map((f) => f.name)), [["甲.epub"], ["乙.epub"]]);
    assert.ok(groups.every((g) => g.ok && g.mode === "iflytek"));
  } finally {
    await a.close();
    await b.close();
    await fsp.rm(path.join(TMP, "device-targets.json"), { force: true });
  }
});

test("deviceFilesAll：离线地址不拖垮其它分组", async () => {
  const a = await fakeIflytek([{ date: 1, name: "甲.epub", path: "书架", size: 1 }]);
  await setTarget(a.url);
  await fsp.writeFile(
    path.join(TMP, "device-targets.json"),
    JSON.stringify({ targets: [{ url: "http://127.0.0.1:1", label: "打不开的地址" }] }),
    "utf-8",
  );
  try {
    const { groups } = await deviceFilesAll(1500);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].ok, true);
    assert.equal(groups[1].ok, false);
  } finally {
    await a.close();
    await fsp.rm(path.join(TMP, "device-targets.json"), { force: true });
  }
});

test("probePort / scanPorts：只认出真正在监听的端口", async () => {
  const dev = await fakeIflytek([{ date: 1, name: "甲.epub", path: "书架", size: 1 }]);
  const port = Number(new URL(dev.url).port);
  try {
    assert.equal(await probePort("127.0.0.1", port, 800), true);
    const dead = port === 65535 ? 65534 : port + 1;
    assert.equal(await probePort("127.0.0.1", dead, 300), false);
    const open = await scanPorts("127.0.0.1", Math.max(1024, port - 2), port + 2, 4, 400);
    assert.deepEqual(open, [port]);
  } finally {
    await dev.close();
  }
});

test("discoverTransferPages：已知端口优先，命中就不再扫端口", async () => {
  const dev = await fakeIflytek([{ date: 1, name: "甲.epub", path: "书架", size: 1 }]);
  const port = Number(new URL(dev.url).port);
  await setTarget("http://192.0.2.1:50006"); // 换个 IP：不让推送目标混进本机的"已知端口"
  await fsp.rm(path.join(TMP, "device-targets.json"), { force: true });
  try {
    const r = await discoverTransferPages({ ip: "127.0.0.1", knownPorts: [port] });
    assert.equal(r.stage, "fast", "已知端口命中应走快速通道");
    assert.equal(r.scanned, 1, "只探了 1 个已知端口，没有扫整段");
    assert.deepEqual(r.openPorts, [port]);
    assert.equal(r.pages[0].mode, "iflytek");
    assert.equal(r.pages[0].url, `http://127.0.0.1:${port}`);

    const saved = JSON.parse(await fsp.readFile(path.join(TMP, "device-targets.json"), "utf-8"));
    assert.equal(saved.targets[0].url, `http://127.0.0.1:${port}`, "发现的地址要自动登记");
  } finally {
    await dev.close();
  }
});

test("discoverTransferPages：已知端口没命中才扫全端口", async () => {
  const dev = await fakeIflytek([{ date: 1, name: "乙.epub", path: "书架", size: 1 }]);
  const port = Number(new URL(dev.url).port);
  await setTarget("http://127.0.0.1:1"); // 推送目标不可达，避免它混进"已知端口"
  await fsp.rm(path.join(TMP, "device-targets.json"), { force: true });
  try {
    const r = await discoverTransferPages({
      ip: "127.0.0.1",
      knownPorts: [], // 不给已知端口 → 必须扫
      from: Math.max(1024, port - 2),
      to: port + 2,
      concurrency: 4,
      timeoutMs: 400,
    });
    assert.equal(r.stage, "full");
    assert.equal(r.scanned, 5);
    assert.deepEqual(r.openPorts, [port]);
    assert.equal(r.pages.length, 1);
    assert.equal(r.pages[0].mode, "iflytek");
  } finally {
    await dev.close();
  }
});

test("discoverTransferPages：deep=true 时即使已知端口命中也会全端口扫", async () => {
  const dev = await fakeIflytek([{ date: 1, name: "丙.epub", path: "书架", size: 1 }]);
  const port = Number(new URL(dev.url).port);
  await fsp.rm(path.join(TMP, "device-targets.json"), { force: true });
  try {
    const r = await discoverTransferPages({
      ip: "127.0.0.1",
      knownPorts: [port],
      deep: true,
      from: Math.max(1024, port - 1),
      to: port + 1,
      concurrency: 3,
      timeoutMs: 400,
    });
    assert.equal(r.stage, "full");
    assert.equal(r.pages.length, 1, "同一个端口不应重复登记");
  } finally {
    await dev.close();
  }
});
