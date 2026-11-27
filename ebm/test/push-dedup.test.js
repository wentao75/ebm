// push-dedup.test.js —— 推送前查重 + 推送历史
//
// 假设备同时实现三件事，模拟起点阅读器的传书页：
//   GET  /files  → 设备当前文件清单（含 [号码] 前缀）
//   GET  /config → {"fileSizeLimit": N}
//   POST /upload → 收下文件，登记为 `[<自增号码>]<原文件名>`
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_DATA_DIR = TMP; // 必须在 require 之前（paths.ts 在模块加载时解析数据目录）

const { bookKey, findDeviceDuplicates, pushFile, listDeviceFiles } = require("../dist/push.js");
const { readPushLog } = require("../dist/pushlog.js");

/** 启动假设备；files 为初始清单，上传后按 [1000+n] 前缀追加 */
async function fakeDevice(files = []) {
  const list = [...files];
  const uploads = [];
  let seq = 1000;
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/files") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fileSizeLimit: 200 }));
      return;
    }
    if (req.method === "POST" && req.url === "/upload") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const utf8 = Buffer.concat(chunks).toString("utf8");
        const name = /filename="([^"]+)"/.exec(utf8)?.[1] || "unknown";
        const deviceName = `[${seq++}]${name}`;
        list.push(deviceName);
        uploads.push({ name, deviceName });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ msg: "上传成功" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    list,
    uploads,
    close: () => new Promise((r) => srv.close(r)),
  };
}

async function writeBook(name, content = "x".repeat(64)) {
  await fsp.mkdir(TMP, { recursive: true });
  const p = path.join(TMP, name);
  await fsp.writeFile(p, content);
  return p;
}

async function setTarget(url) {
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.writeFile(path.join(TMP, "push-target.json"), JSON.stringify({ url }), "utf-8");
}

test("bookKey：忽略 [号码] 前缀与站标，保留扩展名区分", () => {
  assert.equal(bookKey("[7399107]《好用的博弈论》镰田雄一郎.pdf"), bookKey("《好用的博弈论》镰田雄一郎.pdf"));
  assert.equal(bookKey("《书》作者【文字版_PDF电子书_雅书】.pdf"), bookKey("《书》作者.pdf"));
  assert.equal(bookKey("Some Book (2nd Ed).EPUB"), bookKey("some book (2nd ed).epub"));
  assert.notEqual(bookKey("《书》作者.pdf"), bookKey("《书》作者.epub"), "同名不同格式不算重复");
  assert.notEqual(bookKey("《书》作者.pdf"), bookKey("《书》作者.sdr"), "进度目录不算同一本书");
});

test("listDeviceFiles 排除 .sdr 进度目录", async () => {
  const dev = await fakeDevice(["[1]A.pdf", "[1]A.sdr", "B.epub"]);
  try {
    const files = await listDeviceFiles(dev.url, 3000);
    assert.deepEqual(files.map((f) => f.name), ["[1]A.pdf", "B.epub"]);
  } finally {
    await dev.close();
  }
});

test("findDeviceDuplicates：按书名键找设备上已有的同名书", async () => {
  const dev = await fakeDevice(["[111]《好画500年》马萧.pdf", "[222]《好画500年》马萧.pdf", "[333]健身食典.epub"]);
  try {
    const hit = await findDeviceDuplicates("《好画500年》马萧.pdf", dev.url, 3000);
    assert.equal(hit.checked, true);
    assert.equal(hit.matches.length, 2);
    const miss = await findDeviceDuplicates("《好画500年》马萧.epub", dev.url, 3000);
    assert.deepEqual(miss.matches, [], "不同格式不应判重");
  } finally {
    await dev.close();
  }
});

test("pushFile：设备已有同名书 → 不发上传，返回 duplicate", async () => {
  const dev = await fakeDevice(["[7399107]《好用的博弈论》镰田雄一郎.pdf"]);
  await setTarget(dev.url);
  const abs = await writeBook("《好用的博弈论》镰田雄一郎.pdf");
  try {
    const r = await pushFile(abs, "《好用的博弈论》镰田雄一郎.pdf", 10_000);
    assert.equal(r.ok, false);
    assert.equal(r.duplicate, true);
    assert.deepEqual(r.existing, ["[7399107]《好用的博弈论》镰田雄一郎.pdf"]);
    assert.equal(dev.uploads.length, 0, "不应真的上传");
  } finally {
    await dev.close();
    await fsp.rm(abs, { force: true });
  }
});

test("pushFile：force 跳过查重，并回读到设备文件名 + 写入推送历史", async () => {
  const dev = await fakeDevice(["[7399107]《好用的博弈论》镰田雄一郎.pdf"]);
  await setTarget(dev.url);
  const abs = await writeBook("《好用的博弈论》镰田雄一郎.pdf");
  try {
    const r = await pushFile(abs, "《好用的博弈论》镰田雄一郎.pdf", 10_000, { force: true });
    assert.equal(r.ok, true, r.error || "应上传成功");
    assert.equal(dev.uploads.length, 1);
    assert.equal(r.deviceName, "[1000]《好用的博弈论》镰田雄一郎.pdf", "应回读到带号码的真实文件名");

    const log = await readPushLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].name, "《好用的博弈论》镰田雄一郎.pdf");
    assert.equal(log[0].deviceName, r.deviceName);
    assert.equal(log[0].ok, true);
  } finally {
    await dev.close();
    await fsp.rm(abs, { force: true });
    await fsp.rm(path.join(TMP, "push-log.json"), { force: true });
  }
});

test("pushFile：设备清单读不到时不阻塞推送（.sdr 之外一律放行）", async () => {
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fileSizeLimit: 200 }));
      return;
    }
    if (req.method === "GET" && req.url === "/files") {
      res.writeHead(500);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/upload") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ msg: "上传成功" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await setTarget(`http://127.0.0.1:${srv.address().port}`);
  const abs = await writeBook("C.pdf");
  try {
    const r = await pushFile(abs, "C.pdf", 10_000);
    assert.equal(r.ok, true, r.error || "清单读不到时应照常上传");
    assert.equal(r.deviceName, undefined, "回读失败时没有设备文件名");
  } finally {
    await new Promise((r) => srv.close(r));
    await fsp.rm(abs, { force: true });
    await fsp.rm(path.join(TMP, "push-log.json"), { force: true });
  }
});

/** 讯飞阅读传书页：/files 直接断开（socket hang up），只有 /fils 返回带体积的清单 */
async function fakeIflytek(files = []) {
  const list = files.map((f) => ({ date: 1795747712000, name: f.name, path: "书架", size: f.size }));
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/fils") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: list }));
      return;
    }
    // 讯飞传书对未知路径直接断开连接（与真机一致）
    req.socket.destroy();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => srv.close(r)),
  };
}

test("讯飞阅读 /fils：清单带体积，且不会因为 /files 断开而失败", async () => {
  const dev = await fakeIflytek([
    { name: "助推.epub", size: 25621233 },
    { name: "博弈论平话.epub", size: 737450 },
  ]);
  try {
    const files = await listDeviceFiles(dev.url, 3000, "iflytek");
    assert.equal(files.length, 2);
    assert.equal(files[0].name, "助推.epub");
    assert.equal(files[0].size, 25621233, "应保留设备侧体积，便于「同名同体积」判断");
    assert.equal(files[0].path, "书架");

    const hit = await findDeviceDuplicates("博弈论平话.epub", dev.url, 3000, "iflytek");
    assert.equal(hit.checked, true);
    assert.deepEqual(hit.matches, ["博弈论平话.epub"]);
    assert.equal(hit.details[0].size, 737450);
  } finally {
    await dev.close();
  }
});

test("讯飞阅读：书架里没有的书不算重复", async () => {
  const dev = await fakeIflytek([{ name: "助推.epub", size: 100 }]);
  try {
    const miss = await findDeviceDuplicates("《好用的博弈论》镰田雄一郎.pdf", dev.url, 3000, "iflytek");
    assert.equal(miss.checked, true);
    assert.deepEqual(miss.matches, []);
  } finally {
    await dev.close();
  }
});
