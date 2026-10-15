// test/shelves.test.js —— 书架存储层单元测试（长期稳定性重点：不丢、不坏、不膨胀、不崩）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { tmpDir, cleanup } = require("./helper");
const { ShelfStore, isShelfName, normPage, validRel, MAX_PAGE, MAX_REL_LEN } = require("../dist/shelves.js");

test("书架：空目录读取为空且不报错", async () => {
  const dir = await tmpDir();
  try {
    const store = new ShelfStore({ dir });
    await store.load();
    assert.deepEqual(store.snapshot().items, {});
    assert.equal(store.count(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("书架：标记与取消标记，落盘后可被新实例读回", async () => {
  const dir = await tmpDir();
  try {
    const store = new ShelfStore({ dir });
    await store.load();
    store.set("历史/明朝那些事儿.pdf", "reading", true);
    await store.flushNow();

    const again = new ShelfStore({ dir });
    await again.load();
    assert.equal(again.get("历史/明朝那些事儿.pdf")?.reading, true);

    // 取消后空记录被回收，文件不膨胀
    again.set("历史/明朝那些事儿.pdf", "reading", false);
    await again.flushNow();
    assert.equal(again.get("历史/明朝那些事儿.pdf"), undefined);
    const raw = JSON.parse(await fsp.readFile(path.join(dir, "shelves.json"), "utf-8"));
    assert.deepEqual(raw.items, {});
  } finally {
    await cleanup(dir);
  }
});

test("书架：一本书可同时在多个书架；标读完自动移出在读", async () => {
  const dir = await tmpDir();
  try {
    const store = new ShelfStore({ dir });
    await store.load();
    const rel = "历史/万历十五年.txt";
    store.set(rel, "reading", true);
    store.set(rel, "fav", true);
    assert.deepEqual(
      { reading: store.get(rel).reading, fav: store.get(rel).fav, done: store.get(rel).done },
      { reading: true, fav: true, done: undefined },
    );
    store.set(rel, "done", true);
    const rec = store.get(rel);
    assert.equal(rec.done, true);
    assert.equal(rec.reading, undefined, "标读完后必须自动移出在读");
    assert.equal(rec.fav, true, "喜欢应保留");
  } finally {
    await cleanup(dir);
  }
});

test("书架：阅读进度写入、收敛与持久化", async () => {
  const dir = await tmpDir();
  try {
    const store = new ShelfStore({ dir });
    await store.load();
    const rel = "历史/明朝那些事儿.pdf";
    store.setProgress(rel, 75);
    assert.equal(store.get(rel).page, 75);
    store.setProgress(rel, 0); // 低于下界 → 收敛到 1
    assert.equal(store.get(rel).page, 1);
    store.setProgress(rel, 999999); // 超上界 → 收敛
    assert.equal(store.get(rel).page, MAX_PAGE);
    await store.flushNow();

    const again = new ShelfStore({ dir });
    await again.load();
    assert.equal(again.get(rel).page, MAX_PAGE, "重启后进度必须还在（续读的基础）");
  } finally {
    await cleanup(dir);
  }
});

test("书架：50 条并发写入一条不丢，文件始终是合法 JSON", async () => {
  const dir = await tmpDir();
  try {
    const store = new ShelfStore({ dir });
    await store.load();
    for (let i = 0; i < 50; i++) store.set(`分类${i % 5}/书${i}.pdf`, "fav", true);
    await store.flushNow();
    const raw = JSON.parse(await fsp.readFile(path.join(dir, "shelves.json"), "utf-8"));
    assert.equal(Object.keys(raw.items).length, 50);
    assert.equal(store.count(), 50);
  } finally {
    await cleanup(dir);
  }
});

test("书架：同一本书高频写入不出错且只留一条记录", async () => {
  const dir = await tmpDir();
  try {
    const store = new ShelfStore({ dir });
    await store.load();
    const rel = "历史/万历十五年.txt";
    const writes = 200;
    for (let i = 0; i < writes; i++) store.setProgress(rel, (i % 120) + 1);
    await store.flushNow();
    const raw = JSON.parse(await fsp.readFile(path.join(dir, "shelves.json"), "utf-8"));
    assert.equal(Object.keys(raw.items).length, 1);
    assert.equal(raw.items[rel].page, ((writes - 1) % 120) + 1, "最后一次写入生效");
  } finally {
    await cleanup(dir);
  }
});

test("书架：文件损坏时隔离备份并降级为空，服务照常可用", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "shelves.json");
    await fsp.writeFile(file, "{ 这不是合法 JSON", "utf-8");
    const store = new ShelfStore({ dir });
    await store.load();
    assert.deepEqual(store.snapshot().items, {});
    const entries = await fsp.readdir(dir);
    assert.ok(entries.some((n) => n.includes(".corrupt-")), "损坏文件必须被隔离留档");
    assert.ok(!entries.includes("shelves.json"), "损坏文件应被移走，避免反复解析失败");
    // 降级后仍可正常写入
    store.set("历史/万历十五年.txt", "fav", true);
    await store.flushNow();
    const again = new ShelfStore({ dir });
    await again.load();
    assert.equal(again.get("历史/万历十五年.txt").fav, true);
  } finally {
    await cleanup(dir);
  }
});

test("书架：人工改坏的字段被过滤，不影响其余数据", async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(
      path.join(dir, "shelves.json"),
      JSON.stringify({
        version: 1,
        updated: 1,
        items: {
          "正常/书.pdf": { fav: true, page: 12, ts: 1 },
          "": { fav: true, ts: 1 },
          "坏值/书.pdf": { fav: "yes", page: "abc", ts: 1 },
          "数字页/书.pdf": { page: 7.9, ts: 1 },
        },
      }),
      "utf-8",
    );
    const store = new ShelfStore({ dir });
    await store.load();
    const items = store.snapshot().items;
    assert.ok(items["正常/书.pdf"], "合法记录保留");
    assert.equal(items[""], undefined, "空 rel 被丢弃");
    assert.equal(items["坏值/书.pdf"], undefined, "无任何有效字段的记录被丢弃");
    assert.equal(items["数字页/书.pdf"].page, 7, "页码取整");
  } finally {
    await cleanup(dir);
  }
});

test("书架：目录不存在时自动创建；目录只读时写失败但不影响内存态与服务", async () => {
  const base = await tmpDir();
  const nested = path.join(base, "深/层/data");
  try {
    const store = new ShelfStore({ dir: nested });
    await store.load();
    store.set("历史/万历十五年.txt", "reading", true);
    await store.flushNow();
    const raw = JSON.parse(await fsp.readFile(path.join(nested, "shelves.json"), "utf-8"));
    assert.equal(Object.keys(raw.items).length, 1, "深层目录应被自动创建");

    // 只读目录：写入必须失败得安静
    await fsp.chmod(nested, 0o555);
    store.set("历史/明朝那些事儿.pdf", "fav", true);
    await store.flushNow(); // 不应抛错
    assert.equal(store.get("历史/明朝那些事儿.pdf").fav, true, "内存态仍可用");
    await fsp.chmod(nested, 0o755);
    await store.flushNow();
    const raw2 = JSON.parse(await fsp.readFile(path.join(nested, "shelves.json"), "utf-8"));
    assert.equal(Object.keys(raw2.items).length, 2, "恢复可写后应补上");
  } finally {
    await cleanup(base);
  }
});

test("书架：输入校验边界", () => {
  assert.equal(isShelfName("reading"), true);
  assert.equal(isShelfName("done"), true);
  assert.equal(isShelfName("finished"), false);
  assert.equal(isShelfName(null), false);
  assert.equal(validRel("a.pdf"), true);
  assert.equal(validRel(""), false);
  assert.equal(validRel("x".repeat(MAX_REL_LEN + 1)), false);
  assert.equal(validRel(123), false);
  assert.equal(normPage("42"), 42);
  assert.equal(normPage("abc"), null);
  assert.equal(normPage(-5), 1);
  assert.equal(normPage(3.9), 3);
  assert.equal(normPage(Infinity), null);
});
