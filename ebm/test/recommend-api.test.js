// recommend-api.test.js —— 「待下载确认」接口契约（用 stub recommend.py，全程隔离、不联网、不碰真实管道）
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const path = require("path");
const { makeLibrary, startServer, tmpDir, cleanup, TIERS_FIXTURE } = require("./helper");

let lib, dataDir, dir2, srv, watch;
let srvNoScript;

// post_details 夹具：让待确认条目能补上豆瓣评分（清单文件里没有这个字段）
const META = {
  "23415": { id: 23415, title: "《会思考才会表达》杜斌", douban: "8.4", intro: "测试简介", toc: "第一章 想清楚/001", tags: ["职场"], meta: { 作者: "作者甲", 出版日期: "2026-9-1", 出版社: "机械工业出版社" } },
  "23408": { id: 23408, title: "《存钱心理学》埃玛·爱德华兹", douban: "6.3", intro: "测试简介", meta: { 作者: "作者乙", 出版日期: "2025-7-1" } },
  "23406": { id: 23406, title: "《你的懒惰让我愁肠百结》F.S.菲茨杰拉德", douban: "8.1", intro: "测试简介", meta: { 作者: "作者丙", 出版日期: "2022-4-1" } },
};

async function postJson(base, p, body) {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  lib = await makeLibrary();
  dataDir = await tmpDir("ebm-rec-api-");
  watch = path.join(dataDir, "watch");
  srv = await startServer({
    libraryRoot: lib.root,
    dataDir,
    metaFixture: META,
    tiersFixture: TIERS_FIXTURE,
    withRecommend: true,
  });
  // 脚本缺失场景用第二个实例（不写 stub）
  dir2 = await tmpDir("ebm-rec-api2-");
  srvNoScript = await startServer({
    libraryRoot: lib.root,
    dataDir: dir2,
    metaFixture: META,
    tiersFixture: TIERS_FIXTURE,
  });
});

after(async () => {
  await srv?.stop();
  await srvNoScript?.stop();
  await cleanup(dataDir);
  if (dir2) await cleanup(dir2);
});

test("待确认清单：解析出条目与建议目录/理由/作者/简介，并补上豆瓣评分", async () => {
  const res = await fetch(`${srv.base}/api/recommend/pending?sync=1`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.scriptAvailable, true, "stub recommend.py 应可用");
  assert.equal(d.items.length, 3, "tiers 夹具里 tier2 有 3 本");
  assert.equal(d.synced, true, "带 sync=1 时应刷新清单");
  assert.equal(d.syncOk, true, "刷新应成功");
  assert.equal(d.fileExists, true);
  assert.equal(d.readable, true);
  assert.equal(d.maxDownload, 30, "应回传一键下载的单次上限");
  assert.ok(d.fileBytes > 0, "应回传清单文件体积（供界面显示量级）");
  assert.ok(d.archive && typeof d.archive.total === "number", "应回传历史归档状态");
  const it = d.items.find((x) => x.id === 23415);
  assert.ok(it, "应包含 23415");
  assert.equal(it.title, "《会思考才会表达》杜斌");
  assert.equal(it.folder, "学习");
  assert.equal(it.note, "职场表达工具书，拿不准");
  assert.equal(it.author, "作者甲");
  assert.equal(it.date, "2026-9-1");
  assert.ok(it.intro.includes("测试简介"), "简介应来自 post_details（真实 recommend.py 会把它写进清单）");
  assert.equal(it.douban, "8.4", "豆瓣评分应来自 post_details");
  assert.equal(it.mark, "pending");
  // tier1（已批准）的书不应出现在待确认里
  assert.equal(d.items.some((x) => x.id === 23001), false);
});

test("已确认待下载队列：列出 tier1 未下载的书，已下载的自动排除", async () => {
  const statePath = path.join(watch, "state.json");
  const good = await fsp.readFile(statePath, "utf-8");
  try {
    await fsp.writeFile(statePath, JSON.stringify({ downloads: [] }, null, 1), "utf-8");
    let d = await (await fetch(`${srv.base}/api/recommend/pending`)).json();
    assert.ok(Array.isArray(d.queued), "响应应带 queued 队列");
    const q = d.queued.find((x) => x.id === 23001);
    assert.ok(q, `tier1 未下载的书应进队列，实际：${JSON.stringify(d.queued)}`);
    assert.equal(q.title, "《已批准的书》");
    assert.equal(q.folder, "学习");
    assert.equal(d.queued.some((x) => x.id === 23406), false, "tier2 的书不应出现在待下载队列");

    // 书已在书库（账本没记账，例如通过界面手动下载）→ 不该再显示为"待下载"
    assert.equal(d.queued.some((x) => x.id === 23002), false, "已在书库的书应从待下载队列移除");
    const inLib = (d.queuedInLibrary || []).find((x) => x.id === 23002);
    assert.ok(inLib, "应单独回报为「已在书库」供界面说明");
    assert.equal(inLib.title, "《万历十五年》黄仁宇");

    // 一旦该书已下载 / 标记失效，就应从队列消失（与管道 candidates() 口径一致）
    await fsp.writeFile(statePath, JSON.stringify({ downloads: [{ id: 23001 }] }, null, 1), "utf-8");
    d = await (await fetch(`${srv.base}/api/recommend/pending`)).json();
    assert.equal(d.queued.some((x) => x.id === 23001), false, "已下载的不应再显示为待下载");
  } finally {
    await fsp.writeFile(statePath, good, "utf-8");
  }
});

test("默认 GET 是纯读取：不调管道脚本、不产生副作用", async () => {
  const recPath = path.join(watch, "_推荐待确认.md");
  // 自证独立：用例自己先把清单准备好（不依赖前一个用例的残留文件）
  const synced = await (await fetch(`${srv.base}/api/recommend/pending?sync=1`)).json();
  assert.equal(synced.synced, true, "前置：sync=1 应刷新清单");
  assert.equal(synced.items.length, 3);
  const before = await fsp.stat(recPath);

  const res = await fetch(`${srv.base}/api/recommend/pending`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.synced, false, "不带 sync=1 时不应执行同步");
  assert.equal(d.syncOk, true, "未请求同步时不应报同步失败");
  assert.equal(d.ok, true);
  assert.equal(d.items.length, 3, "纯读应能解析出清单内容");

  // 证明"纯读"：文件未被重写（mtimeMs 与内容都不变）
  const after = await fsp.stat(recPath);
  assert.equal(after.mtimeMs, before.mtimeMs, "纯读不得重写清单文件");
  assert.equal(after.size, before.size);
});

test("清单文件不完整：纯读报错（只读展示）；decide 会先 sync 自愈再执行", async () => {
  const recPath = path.join(watch, "_推荐待确认.md");
  const tiersPath = path.join(watch, "tiers.json");
  const goodRec = await fsp.readFile(recPath, "utf-8");
  const goodTiers = await fsp.readFile(tiersPath, "utf-8");
  await fsp.writeFile(recPath, "- [x] 23406 被截断的内容（没有章节标记）\n", "utf-8");
  try {
    // ① 纯读：不能把不完整文件当成正常清单
    const res = await fetch(`${srv.base}/api/recommend/pending`);
    const d = await res.json();
    assert.equal(d.ok, false, "不完整文件不应被当成正常清单");
    assert.equal(d.readable, false);
    assert.match(String(d.error), /不完整/);

    // ② decide：先 sync 用 tiers.json 重建清单（自愈），再正常执行
    const decide = await postJson(srv.base, "/api/recommend/decide", { approve: [23406], reject: [] });
    assert.equal(decide.status, 200, `自愈后应正常执行：${JSON.stringify(decide.body).slice(0, 120)}`);
    assert.deepEqual(decide.body.approved, [23406]);
    const tiers = JSON.parse(await fsp.readFile(tiersPath, "utf-8"));
    assert.equal(tiers["23406"].tier, 1, "自愈后决策应正常落盘");
  } finally {
    await fsp.writeFile(recPath, goodRec, "utf-8");
    await fsp.writeFile(tiersPath, goodTiers, "utf-8"); // 还原夹具，避免影响后续用例
  }
});

test("待确认列表也看书库：未经批准直接下载（已在书库）的不再要求确认", async () => {
  const d = await (await fetch(`${srv.base}/api/recommend/pending`)).json();
  assert.equal(d.items.some((x) => x.id === 23003), false, "已入库的候选不应继续出现在待确认里");
  const inLib = (d.itemsInLibrary || []).find((x) => x.id === 23003);
  assert.ok(inLib, "应单独回报为已在书库供界面说明");
  assert.equal(inLib.title, "《明朝那些事儿》当年明月");
  assert.ok(d.items.some((x) => x.id === 23415), "正常候选仍应在待确认列表里");
});

test("决策：批准进 tier1、拒绝进 tier3 并记「用户拒绝」，清单同步刷新", async () => {
  const r = await postJson(srv.base, "/api/recommend/decide", { approve: [23415], reject: [23408] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.approved, [23415]);
  assert.deepEqual(r.body.rejected, [23408]);
  assert.equal(r.body.remaining.length, 1, "处理后清单只剩未决策的那本");
  assert.equal(r.body.remaining[0].id, 23406);
  assert.match(r.body.log, /批准下载 1 本/, "应回传真实 recommend.py apply 的日志");

  // tiers.json 由管道的 apply 落盘（我们只翻转勾选 + 调脚本）
  const tiers = JSON.parse(await fsp.readFile(path.join(watch, "tiers.json"), "utf-8"));
  assert.equal(tiers["23415"].tier, 1, "批准的应进 tier1");
  assert.equal(tiers["23408"].tier, 3, "拒绝的应进 tier3");
  assert.equal(tiers["23408"].folder, null);
  assert.match(tiers["23408"].note, /用户拒绝/);
  assert.equal(tiers["23406"].tier, 2, "未决策的不动");

  // 清单文件仍由管道维护（互操作保留）
  const md = await fsp.readFile(path.join(watch, "_推荐待确认.md"), "utf-8");
  assert.match(md, /## 待确认/);
  assert.match(md, /23406/);
  assert.ok(!/^\s*-\s*\[.\]\s*23415/m.test(md.split("## 已处理")[0]), "已处理的书不应留在待确认区");
});

test("推荐详情接口：返回完整简介/目录/元数据，参数非法与缺数据都有明确错误", async () => {
  const ok = await (await fetch(`${srv.base}/api/reco/detail?id=23415`)).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.id, 23415);
  assert.ok(String(ok.intro).length > 0, "应返回简介");
  assert.ok(String(ok.toc || "").length > 0, "应返回目录");
  assert.equal(String(ok.meta?.作者 || ok.author), "作者甲", "应带作者");
  assert.equal(ok.douban, "8.4");

  const bad = await fetch(`${srv.base}/api/reco/detail?id=abc`);
  assert.equal(bad.status, 400);
  const missing = await fetch(`${srv.base}/api/reco/detail?id=999999`);
  assert.equal(missing.status, 502, "缓存里没有且抓取脚本不可用时应 502");
  // 脚本缺失但详情已在缓存里 → 直接读缓存返回 200（不需要抓取脚本）
  const noScriptCached = await fetch(`${srvNoScript.base}/api/reco/detail?id=23415`);
  assert.equal(noScriptCached.status, 200, "详情已缓存时不应依赖抓取脚本");
  const noScriptMissing = await fetch(`${srvNoScript.base}/api/reco/detail?id=999999`);
  assert.equal(noScriptMissing.status, 502, "缓存没有且脚本缺失 → 502 而不是崩");
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200);
});

test("恢复为待定：拒绝前快照 → 恢复后 tier/folder/理由精确还原，并重回待确认", async () => {
  const tiersPath = path.join(watch, "tiers.json");
  // 前置：23408 在上一个用例里被拒绝过（tier3 + folder 置空 + 追加「用户拒绝」）
  const rejected = JSON.parse(await fsp.readFile(tiersPath, "utf-8"))["23408"];
  assert.equal(rejected.tier, 3, "前置：23408 应处于已拒绝状态");
  assert.equal(rejected.folder, null);
  assert.match(String(rejected.note), /用户拒绝/);

  const res = await postJson(srv.base, "/api/reco/restore", { ids: [23408] });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 160));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.restored.length, 1);
  assert.equal(res.body.restored[0].fromSnapshot, true, "应能按拒绝前的快照还原");
  assert.ok(res.body.backup && res.body.backup.includes("tiers-backup"), "应写出 tiers.json 备份");

  const back = JSON.parse(await fsp.readFile(tiersPath, "utf-8"))["23408"];
  assert.equal(back.tier, 2, "应恢复为待定");
  assert.equal(back.folder, "经济&投资", "应还原原建议目录");
  assert.ok(!String(back.note).includes("用户拒绝"), "应清掉拒绝标记");

  // 恢复后应重新出现在「待确认」清单里（EBM 恢复了 tiers 后让管道重建清单）
  const pending = await (await fetch(`${srv.base}/api/recommend/pending?sync=1`)).json();
  assert.ok(pending.items.some((x) => x.id === 23408), `恢复的书应重回待确认：${pending.items.map((x) => x.id).join(",")}`);
});

test("恢复为待定：非拒绝状态/不存在/参数非法都拒绝且不改数据", async () => {
  const tiersPath = path.join(watch, "tiers.json");
  const before = await fsp.readFile(tiersPath, "utf-8");
  const notRejected = await postJson(srv.base, "/api/reco/restore", { ids: [23001] });
  assert.equal(notRejected.status, 400);
  assert.match(String(notRejected.body.error), /没有可恢复/);
  const bad = await postJson(srv.base, "/api/reco/restore", { ids: "23408" });
  assert.equal(bad.status, 400);
  const empty = await postJson(srv.base, "/api/reco/restore", { ids: [] });
  assert.equal(empty.status, 400);
  assert.equal(await fsp.readFile(tiersPath, "utf-8"), before, "失败路径不得改动 tiers.json");

  const st = await (await fetch(`${srv.base}/api/reco/restore/status`)).json();
  assert.ok(typeof st.snapshots === "number" && st.backupDir.includes("tiers-backup"));
});

test("清单历史会按月归档（管道只保留最近 200 条，旧的不能丢）", async () => {
  // 前置用例已产生决策 → 清单「已处理」区应有记录
  const d = await (await fetch(`${srv.base}/api/recommend/pending?sync=1`)).json();
  assert.ok(d.archive.total >= 1, `应归档已处理记录，实际 ${d.archive.total}`);
  assert.ok(d.archive.months.length >= 1);
  const dir = d.archive.dir;
  const files = await fsp.readdir(dir);
  assert.ok(files.some((f) => /^reco-archive-\d{4}-\d{2}\.md$/.test(f)), `归档文件应存在：${files.join(",")}`);
  const text = await fsp.readFile(path.join(dir, files.find((f) => f.endsWith(".md"))), "utf-8");
  assert.match(text, /^# 推荐决策归档 · \d{4}-\d{2}/, "归档文件应带可读标题（保持 Markdown 可查看）");
  // 幂等：再同步一次不应重复追加
  const again = await (await fetch(`${srv.base}/api/recommend/pending?sync=1`)).json();
  assert.equal(again.archive.total, d.archive.total, "重复刷新不应重复归档");
});

test("归档查询接口：月份列表、条目字段与关键词过滤", async () => {
  const all = await (await fetch(`${srv.base}/api/reco/archive?limit=100`)).json();
  assert.ok(all.total >= 1, "应有归档记录");
  assert.ok(Array.isArray(all.months) && all.months.length >= 1);
  const e = all.items[0];
  assert.ok(e.date && e.id && typeof e.action === "string", `条目字段应完整：${JSON.stringify(e)}`);
  assert.ok(["approve", "reject"].includes(e.action));
  assert.ok(e.title.length > 0, "应解析出书名");

  const hit = await (await fetch(`${srv.base}/api/reco/archive?q=${encodeURIComponent("存钱")}`)).json();
  assert.ok(hit.matched >= 1, "按书名关键词应能搜到");
  assert.ok(hit.items.every((x) => `${x.title}${x.note}${x.folder}${x.id}`.includes("存钱") || `${x.title}${x.note}${x.folder}${x.id}`.includes("23408")));

  const miss = await (await fetch(`${srv.base}/api/reco/archive?q=${encodeURIComponent("绝不存在的关键词xyz")}`)).json();
  assert.equal(miss.matched, 0);
  assert.deepEqual(miss.items, []);
});

test("决策参数校验：未知 id、空决策、同时批准拒绝同一本都被拒绝", async () => {
  const unknown = await postJson(srv.base, "/api/recommend/decide", { approve: [99999], reject: [] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /不在待确认清单/);

  const empty = await postJson(srv.base, "/api/recommend/decide", { approve: [], reject: [] });
  assert.equal(empty.status, 400);

  const both = await postJson(srv.base, "/api/recommend/decide", { approve: [23406], reject: [23406] });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /不能既批准又拒绝/);

  const noBody = await postJson(srv.base, "/api/recommend/decide", { nope: 1 });
  assert.equal(noBody.status, 400);

  // 以上都不应改动数据
  const tiers = JSON.parse(await fsp.readFile(path.join(watch, "tiers.json"), "utf-8"));
  assert.equal(tiers["23406"].tier, 2);
});

test("管道脚本缺失时：清单接口明确说明、决策返回 502 而不是崩", async () => {
  const res = await fetch(`${srvNoScript.base}/api/recommend/pending`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.scriptAvailable, false);
  assert.match(String(d.error), /recommend\.py 不可用/);
  assert.deepEqual(d.items, []);

  const r = await postJson(srvNoScript.base, "/api/recommend/decide", { approve: [23415], reject: [] });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /未找到管道脚本/);
  assert.equal((await fetch(`${srvNoScript.base}/api/health`)).status, 200, "服务必须仍然健康");
});

test("并发保护：下载任务在跑时决策 409 且不改数据；锁释放后可正常决策", async () => {
  const tiersPath = path.join(watch, "tiers.json");
  const goFile = path.join(watch, "go");
  // 下载 stub 等哨兵文件才结束：不靠固定 sleep，而是等"锁已被占用"这个可观测信号
  await fsp.writeFile(
    path.join(watch, "download_books.py"),
    `import os, time, sys
for _ in range(600):
    if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "go")):
        break
    time.sleep(0.05)
print("stub download done")
`,
    "utf-8",
  );
  await fsp.writeFile(path.join(watch, "move_to_icloud.py"), "print('stub move done')\n", "utf-8");

  const dl = fetch(`${srv.base}/api/pipeline/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [23406] }),
  });

  // 轮询直到观察到 409（锁已被下载占用），最多 10 秒；这本身也是可观测信号
  let busy = { status: 0, body: {} };
  for (let i = 0; i < 50; i += 1) {
    busy = await postJson(srv.base, "/api/recommend/decide", { approve: [23406], reject: [] });
    if (busy.status === 409) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(busy.status, 409, "有任务在跑时决策必须 409");
  assert.match(String(busy.body.error), /已有任务在执行中/);

  // 409 分支不得改动任何数据
  const tiersDuring = JSON.parse(await fsp.readFile(tiersPath, "utf-8"));
  assert.equal(tiersDuring["23406"].tier, 2, "409 时不得改动 tiers.json");

  // 放行下载任务，锁释放后决策应恢复正常
  await fsp.writeFile(goFile, "go", "utf-8");
  const res = await dl;
  await res.text();
  await fsp.rm(goFile, { force: true });

  let ok = { status: 0, body: {} };
  for (let i = 0; i < 50; i += 1) {
    ok = await postJson(srv.base, "/api/recommend/decide", { approve: [23406], reject: [] });
    if (ok.status === 200) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(ok.status, 200, `锁释放后应能正常决策：${JSON.stringify(ok.body).slice(0, 120)}`);
  const tiersAfter = JSON.parse(await fsp.readFile(tiersPath, "utf-8"));
  assert.equal(tiersAfter["23406"].tier, 1, "锁释放后的决策应正常落盘");
});
