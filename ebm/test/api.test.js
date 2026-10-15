// test/api.test.js —— HTTP 契约与稳定性测试（真实进程 + 真实 HTTP，全程隔离在临时目录）
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { makeLibrary, startServer, tmpDir, cleanup, makeBytes, DEFAULT_FILES } = require("./helper");

let lib; // 临时书库
let dataDir; // 临时数据目录
let srv;

before(async () => {
  // 额外 3 本小书：用于验证 book_meta.json 的"0.0 评分""多源未命中""仅雅书来源"三种形态
  lib = await makeLibrary([
    ...DEFAULT_FILES,
    ["批量/测试书001.txt", 200],
    ["批量/测试书002.txt", 200],
    ["批量/测试书003.txt", 200],
  ]);
  dataDir = await tmpDir("ebm-data-");
  srv = await startServer({ libraryRoot: lib.root, dataDir });
});

after(async () => {
  if (srv) await srv.stop();
  await cleanup(dataDir);
  await cleanup(lib.root);
});

const post = (pathname, body) =>
  fetch(srv.base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("健康检查与索引：书库被正确扫描", async () => {
  const res = await fetch(`${srv.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.books, lib.files.length);

  const books = await (await fetch(`${srv.base}/api/books`)).json();
  assert.equal(books.books.length, lib.files.length);
  const one = books.books.find((b) => b.rel.includes("明朝那些事儿"));
  assert.ok(one, "应能索引中文路径书");
  assert.equal(one.ext, "PDF");
  assert.ok(one.title.length > 0);
});

test("分类接口可用", async () => {
  const res = await fetch(`${srv.base}/api/categories`);
  assert.equal(res.status, 200);
  const cats = await res.json();
  assert.ok(Array.isArray(cats));
  assert.ok(cats.some((c) => c.name === "历史" && c.count === 2));
});

test("单本详情接口：列表轻量、详情完整，未知书 404", async () => {
  const books = await (await fetch(`${srv.base}/api/books`)).json();
  const one = books.books.find((b) => b.rel.includes("明朝那些事儿"));
  assert.ok(one, "夹具应命中管道元数据（书名/元数据 join 生效）");
  assert.equal(one.introFull, undefined, "列表接口不应携带 introFull（控制体积）");
  assert.equal(one.toc, undefined, "列表接口不应携带 toc");
  assert.equal(one.meta, undefined, "列表接口不应携带 meta");
  assert.ok(one.intro.length <= 300, "列表简介应截断在 300 字内");
  assert.equal(one.douban, "9.1", "豆瓣评分应保留");

  const res = await fetch(`${srv.base}/api/book?path=${encodeURIComponent(one.rel)}`);
  assert.equal(res.status, 200);
  const book = (await res.json()).book;
  assert.equal(book.rel, one.rel);
  assert.ok(book.introFull.length > 300, `详情应返回完整简介，实际 ${book.introFull?.length} 字`);
  assert.ok(!book.introFull.includes("&ldquo;"), "命名实体应已解码");
  assert.ok(book.introFull.includes("\u201c"), "解码后应出现中文引号");
  assert.ok(book.toc.includes("第一章"), "应返回目录");
  assert.ok(!book.toc.includes("&ldquo;"), "目录里的实体也应解码");
  assert.equal(book.meta["出版社"], "中国海关出版社");
  assert.equal(book.meta["译者"], "测试译者");

  const missing = await fetch(`${srv.base}/api/book?path=${encodeURIComponent("不存在/没有这本书.pdf")}`);
  assert.equal(missing.status, 404);
});

test("书目元数据：消费 book_meta.json（覆盖率提升 + 实体解码 + 0.0 过滤）", async () => {
  const books = (await (await fetch(`${srv.base}/api/books`)).json()).books;
  const rlhf = books.find((b) => b.rel.includes("RLHF"));
  assert.ok(rlhf, "夹具应有 RLHF 这本书");
  assert.ok(rlhf.intro.includes("人类反馈强化学习"), "简介应来自 book_meta.json（摘要接口不返回字节级同名书）");
  assert.ok(!rlhf.intro.includes("&ldquo;"), "HTML 实体应已解码");
  assert.equal(rlhf.douban, "8.7", "豆瓣评分应填入");
  assert.equal(rlhf.publisher, "在线出版");
  assert.equal(rlhf.pubDate, "2024-9");
  assert.deepEqual(rlhf.tags, ["机器学习", "“RLHF”"], "标签应解码（含中文引号）");

  const zero = books.find((b) => b.rel.includes("测试书001"));
  assert.equal(zero.douban, undefined, 'douban "0.0" 应视为无评分');
  assert.equal(zero.author, "某作者", "无作者时应从 book_meta 补");

  const yb = books.find((b) => b.rel.includes("测试书003"));
  assert.ok(yb.intro.includes("雅书来源") && !yb.intro.includes("&ldquo;"), "仅雅书来源也应消费且解码");

  const failed = books.find((b) => b.rel.includes("测试书002"));
  assert.equal(failed.intro, undefined, "enrich_failed 不应产生简介");

  // 列表仍保持轻量：不带 introFull/toc/meta
  assert.equal(rlhf.introFull, undefined, "列表接口不应带 introFull");
  assert.equal(rlhf.toc, undefined, "列表接口不应带 toc");
});

test("单本详情：book_meta 的 meta 字段与来源标记", async () => {
  const rel = encodeURIComponent("IT&技术/The RLHF Book.epub");
  const book = (await (await fetch(`${srv.base}/api/book?path=${rel}`)).json()).book;
  assert.equal(book.metaSource, "douban");
  assert.ok(book.introFull.includes("人类反馈强化学习"));
  assert.equal(book.meta["译者"], "测试译者");
  assert.equal(book.meta["页数"], "312");
  assert.equal(book.meta["原名"], "The RLHF Book: A Guide");
  assert.equal(book.meta["ISBN"], "9780000000001");
  assert.ok(book.meta["作者简介"].includes("资深研究者") && !book.meta["作者简介"].includes("&middot;"));
});

test("元数据状态接口：覆盖率、来源分布与待补清单", async () => {
  const st = await (await fetch(`${srv.base}/api/metadata/status`)).json();
  assert.equal(st.total, 4, "应读到 4 条 book_meta 记录");
  assert.equal(st.withIntro, 2);
  assert.equal(st.bySource.douban, 2);
  assert.equal(st.bySource.yabook, 1);
  assert.equal(st.failed, 1, "enrich_failed 应计入");
  assert.ok(st.metaMtime > 0, "应带 book_meta.json mtime");
  assert.ok(st.missingRels.includes("历史/万历十五年.txt"), "书库里有但元数据缺失的书应进入待补清单");
  assert.equal(st.running, false);
});

test("待补清单：分类正确、已有简介的和已覆盖的不进清单", async () => {
  const d = await (await fetch(`${srv.base}/api/metadata/gaps`)).json();
  assert.ok(d.total > 0, "应有待补条目");
  assert.equal(d.overrides, 0);
  const byRel = Object.fromEntries(d.items.map((g) => [g.rel, g]));
  const near = d.items.find((g) => g.rel.includes("测试书001"));
  assert.equal(near.reason, "near_miss", "73 分应归为『差一点命中』");
  assert.equal(near.score, 73);
  assert.ok(near.candidates.length >= 1, "应带候选标题供人工判断");
  const none = d.items.find((g) => g.rel.includes("测试书002"));
  assert.equal(none.reason, "no_candidate");
  const noEntry = d.items.find((g) => g.rel.includes("万历十五年"));
  assert.equal(noEntry.reason, "no_entry", "不在 book_meta 里的书应标『未登记』");
  assert.equal(byRel["IT&技术/The RLHF Book.epub"], undefined, "已有简介的书不应进待补清单");
  assert.equal(byRel["批量/测试书003.txt"], undefined, "已有简介（仅雅书来源）的书不应进清单");
  // 排序：差一点命中的排在最前
  assert.equal(d.items[0].reason, "near_miss");
});

test("人工覆盖：写入后立即生效、优先级最高，可撤销", async () => {
  const rel = "IT&技术/The RLHF Book.epub";
  const before = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.equal(before.metaSource, "douban", "覆盖前来源是管道补全");

  const put = await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, fields: { intro: "人工确认的简介内容", publisher: "人工出版社", douban: "9.9", tags: "标签甲,标签乙" } }),
  });
  assert.equal(put.status, 200);
  const after = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.equal(after.introFull, "人工确认的简介内容", "人工覆盖必须生效");
  assert.equal(after.publisher, "人工出版社", "人工值覆盖管道值");
  assert.equal(after.douban, "9.9");
  assert.deepEqual(after.tags, ["标签甲", "标签乙"], "逗号分隔的标签应拆开");
  assert.equal(after.metaSource, "manual");

  // 覆盖后该书不再进待补清单
  const gaps = await (await fetch(`${srv.base}/api/metadata/gaps`)).json();
  assert.equal(gaps.overrides, 1);
  assert.equal(gaps.items.some((g) => g.rel === rel), false);

  const del = await fetch(`${srv.base}/api/metadata/override?path=${encodeURIComponent(rel)}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).removed, true);
  const restored = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.equal(restored.metaSource, "douban", "撤销后回到管道补全的数据");
});

test("雅书候选：本地 id 映射也能作为候选（书来自雅书但详情未缓存）", async () => {
  // 注意：测试环境没有管道脚本 → 只验证本地映射这条零网络路径
  const res = await fetch(`${srv.base}/api/metadata/candidates`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel: "批量/测试书002.txt" }),
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(Array.isArray(d.yabook), "响应应带 yabook 候选数组");
  const mapped = d.yabook.find((c) => c.id === 999);
  assert.ok(mapped, `应命中 uncat_match.json 里的映射，实际：${JSON.stringify(d.yabook)}`);
  assert.equal(mapped.from, "map");
  assert.equal(mapped.cached, false, "该帖详情未缓存 → 前端提示需现场抓取");
});

test("人工覆盖：支持清除单个字段（修正污染数据）", async () => {
  const rel = "IT&技术/The RLHF Book.epub";
  await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, fields: { author: "被污染的超长作者简介" } }),
  });
  let book = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.equal(book.author, "被污染的超长作者简介");
  // 清除 author → 回落到文件名/管道解析的作者
  const res = await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, clear: ["author"] }),
  });
  assert.equal(res.status, 200);
  book = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.notEqual(book.author, "被污染的超长作者简介", "清除后不应再是被污染的值");
  await fetch(`${srv.base}/api/metadata/override?path=${encodeURIComponent(rel)}`, { method: "DELETE" });
});

test("人工覆盖与候选接口：参数校验与脚本缺失时的优雅降级", async () => {
  const badRel = await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel: "", fields: { intro: "x" } }),
  });
  assert.equal(badRel.status, 400);
  const noFields = await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel: "历史/万历十五年.txt", fields: {} }),
  });
  assert.equal(noFields.status, 400, "没有任何字段应 400");
  const unknown = await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel: "不存在/没有.pdf", fields: { intro: "x" } }),
  });
  assert.equal(unknown.status, 404);

  const badId = await fetch(`${srv.base}/api/metadata/adopt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel: "历史/万历十五年.txt", doubanId: "abc; rm -rf" }),
  });
  assert.equal(badId.status, 400, "doubanId 必须为纯数字，防注入");

  // 测试环境的 WATCH_DIR 没有管道脚本 → 候选/采纳应优雅失败而不是崩服务
  const cand = await fetch(`${srv.base}/api/metadata/candidates`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel: "历史/万历十五年.txt" }),
  });
  assert.ok([502, 200].includes(cand.status), `候选接口应优雅降级，实际 ${cand.status}`);
  const adopt = await fetch(`${srv.base}/api/metadata/adopt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel: "历史/万历十五年.txt", doubanId: "1234567" }),
  });
  assert.equal(adopt.status, 502, "脚本缺失时采纳应 502 且有错误信息");
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200, "服务必须仍然健康");
});

test("元数据任务接口：参数校验与脚本缺失时的优雅降级", async () => {
  const bad1 = await fetch(`${srv.base}/api/metadata/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: ["nope"] }),
  });
  assert.equal(bad1.status, 400, "非法 tasks 应 400");
  const bad2 = await fetch(`${srv.base}/api/metadata/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: ["enrich"], limit: 0 }),
  });
  assert.equal(bad2.status, 400, "limit 非正数应 400");
  const bad3 = await fetch(`${srv.base}/api/metadata/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: "enrich" }),
  });
  assert.equal(bad3.status, 400, "tasks 非数组应 400");

  // 测试环境的 WATCH_DIR 里没有管道脚本 → 应流式回报错误且不崩服务
  const res = await fetch(`${srv.base}/api/metadata/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: ["build"], limit: 5 }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("meta_build.py"), `应在日志里指明缺失的脚本，实际：${text.slice(0, 120)}`);
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200, "服务必须仍然健康");
});

test("书架：空态、标记、取消、跨请求一致", async () => {
  const empty = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.deepEqual(empty.items, {});

  const rel = "历史/万历十五年.txt";
  const marked = await post("/api/shelves", { rel, shelf: "reading", value: true });
  assert.equal(marked.status, 200);
  const markedBody = await marked.json();
  assert.equal(markedBody.ok, true);
  assert.equal(markedBody.record.reading, true);

  const after = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.equal(after.items[rel].reading, true);

  await post("/api/shelves", { rel, shelf: "reading", value: false });
  const cleared = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.equal(cleared.items[rel], undefined, "取消后记录应被回收");
});

test("书架：参数非法一律 400，且不影响服务存活", async () => {
  const cases = [
    [{ shelf: "reading", value: true }, "缺 rel"],
    [{ rel: "", shelf: "reading" }, "空 rel"],
    [{ rel: "x".repeat(600), shelf: "reading" }, "超长 rel"],
    [{ rel: "历史/万历十五年.txt", shelf: "finished" }, "非法书架名"],
    [{ rel: 123, shelf: "reading" }, "rel 非字符串"],
  ];
  for (const [body, label] of cases) {
    const res = await post("/api/shelves", body);
    assert.equal(res.status, 400, `${label} 应返回 400`);
  }
  const bad = await post("/api/shelves", "{不是 JSON");
  assert.equal(bad.status, 400, "坏 JSON 应返回 400 而非 500");
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200, "服务必须仍然健康");
});

test("阅读进度：写入、读取、越界收敛、非法值 400", async () => {
  const rel = "历史/明朝那些事儿.pdf";
  const ok = await post("/api/shelves/progress", { rel, page: 75 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).record.page, 75);

  const clamped = await post("/api/shelves/progress", { rel, page: -3 });
  assert.equal((await clamped.json()).record.page, 1, "下界收敛到 1");

  for (const page of ["abc", null, {}]) {
    const res = await post("/api/shelves/progress", { rel, page });
    assert.equal(res.status, 400, `page=${JSON.stringify(page)} 应 400`);
  }
  const state = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.equal(state.items[rel].page, 1);
});

test("文件下载：Range 分段、全量、越界范围", async () => {
  const rel = "历史/明朝那些事儿.pdf";
  const size = lib.files.find(([r]) => r === rel)[1];
  const url = `${srv.base}/api/file?path=${encodeURIComponent(rel)}&disp=inline`;

  const full = await fetch(url);
  assert.equal(full.status, 200);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  assert.equal(fullBuf.length, size);
  assert.ok(fullBuf.subarray(0, 5).toString() === "%PDF-", "内容应与磁盘一致");

  const part = await fetch(url, { headers: { Range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  const tail = await fetch(url, { headers: { Range: `bytes=${size - 10}-` } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);

  const over = await fetch(url, { headers: { Range: `bytes=${size + 10}-${size + 20}` } });
  assert.equal(over.status, 416);
});

test("文件下载：路径穿越与不存在的文件都被拒绝", async () => {
  for (const bad of ["../../../etc/passwd", "/etc/passwd", "历史/../../../../etc/hosts", "不存在/没有这本书.pdf"]) {
    const res = await fetch(`${srv.base}/api/file?path=${encodeURIComponent(bad)}`);
    assert.ok([403, 404].includes(res.status), `${bad} 应被拒绝，实际 ${res.status}`);
  }
});

test("封面接口：不因异常文件返回 5xx（策略 A 与容错）", async () => {
  const res = await fetch(`${srv.base}/api/cover?path=${encodeURIComponent("历史/明朝那些事儿.pdf")}`);
  assert.ok([200, 404].includes(res.status), `应 200 或 404，实际 ${res.status}`);
});

test("OPDS 与静态页面可用", async () => {
  const opds = await fetch(`${srv.base}/opds`);
  assert.equal(opds.status, 200);
  assert.match(opds.headers.get("content-type") || "", /xml/);
  assert.match(await opds.text(), /<feed/);

  for (const p of ["/", "/read"]) {
    assert.equal((await fetch(srv.base + p)).status, 200, `${p} 应可访问`);
  }
});

test("管道数据缺失时降级为 500 JSON 而不是崩溃", async () => {
  const res = await fetch(`${srv.base}/api/recommendations`);
  assert.ok([200, 500].includes(res.status));
  assert.match(res.headers.get("content-type") || "", /json/);
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200, "服务必须仍然健康");
});

test("并发读 100 次与并发写 30 次都不出错", async () => {
  const reads = await Promise.all(Array.from({ length: 100 }, () => fetch(`${srv.base}/api/shelves`)));
  assert.ok(reads.every((r) => r.status === 200), "并发读必须全 200");

  const rel = "IT&技术/The RLHF Book.epub";
  const writes = await Promise.all(
    Array.from({ length: 30 }, (_, i) => post("/api/shelves/progress", { rel, page: i + 1 })),
  );
  assert.ok(writes.every((r) => r.status === 200), "并发写必须全 200");
  const state = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.ok(state.items[rel].page >= 1 && state.items[rel].page <= 30);
});

test("重启后书架与进度仍在（长期使用最关键的一条）", async () => {
  const rel = "历史/万历十五年.txt";
  await post("/api/shelves", { rel, shelf: "fav", value: true });
  await post("/api/shelves", { rel, shelf: "done", value: true });
  await post("/api/shelves/progress", { rel, page: 42 });

  await srv.stop();
  srv = await startServer({ libraryRoot: lib.root, dataDir, port: srv.port });

  const state = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.equal(state.items[rel].fav, true, "重启后喜欢仍在");
  assert.equal(state.items[rel].done, true, "重启后读完仍在");
  assert.equal(state.items[rel].page, 42, "重启后进度仍在");
});

test("数据文件被外部写坏后，重启仍可用并自动隔离损坏文件", async () => {
  await srv.stop();
  await fsp.writeFile(path.join(dataDir, "shelves.json"), "{{{ 坏掉了", "utf-8");
  srv = await startServer({ libraryRoot: lib.root, dataDir, port: srv.port });

  assert.equal((await fetch(`${srv.base}/api/shelves`)).status, 200);
  const state = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.deepEqual(state.items, {}, "损坏后降级为空");
  const files = await fsp.readdir(dataDir);
  assert.ok(files.some((f) => f.includes(".corrupt-")), "损坏文件应被隔离留档");

  // 坏文件之后仍能正常写入
  const res = await post("/api/shelves", { rel: "历史/明朝那些事儿.pdf", shelf: "reading", value: true });
  assert.equal(res.status, 200);
});

test("异常请求体不导致 5xx", async () => {
  const weird = [
    await fetch(`${srv.base}/api/shelves`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" }),
    await post("/api/shelves", { rel: null, shelf: null }),
    await fetch(`${srv.base}/api/shelves/progress`, { method: "POST", body: "not json" }),
    await fetch(`${srv.base}/api/shelves`, { method: "POST", headers: { "content-type": "application/json" }, body: "[]" }),
  ];
  for (const res of weird) {
    assert.ok(res.status < 500, `应 4xx 而非 ${res.status}`);
  }
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200);
});

test("书库新增文件后能被自动索引（fs.watch 长期可用性）", async () => {
  const rel = "新分类/新书.pdf";
  const abs = path.join(lib.root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, makeBytes(rel, 2048));

  let found = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const books = await (await fetch(`${srv.base}/api/books`)).json();
    if (books.books.some((b) => b.rel === rel)) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(found, "新增文件应在 15 秒内出现在索引里");
});

// ---------- 书名/文件名编辑（放最后：会留下书架/覆盖记录，避免影响前面对空态的断言）----------
test("书名/文件名编辑：清理建议接口（含占用检测与未知书 404）", async () => {
  const rel = "IT&技术/The RLHF Book.epub";
  const d = await (await fetch(`${srv.base}/api/book/rename/suggest?path=${encodeURIComponent(rel)}`)).json();
  assert.equal(d.ok, true);
  assert.equal(d.current, "The RLHF Book.epub");
  assert.equal(typeof d.title, "string");
  assert.ok(Array.isArray(d.rules) && Array.isArray(d.notes));
  const miss = await fetch(`${srv.base}/api/book/rename/suggest?path=${encodeURIComponent("不存在/没有.pdf")}`);
  assert.equal(miss.status, 404);
});

test("改名不丢信息：元数据/书架/进度/人工覆盖全部跟随，且可撤销", async () => {
  const rel = "批量/测试书003.txt"; // book_meta 夹具里这本书有简介（仅雅书来源）
  const newName = "测试书003-校订版.txt";
  const newRel = "批量/测试书003-校订版.txt";

  // 前置：书架标记 + 阅读进度 + 人工覆盖（三样都要能迁移）
  await fetch(`${srv.base}/api/shelves`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, shelf: "fav", value: true }),
  });
  await fetch(`${srv.base}/api/shelves/progress`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, page: 42 }),
  });
  await fetch(`${srv.base}/api/metadata/override`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, fields: { isbn: "9780000000099" } }),
  });
  const before = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.ok(before.intro, "前置条件：这本书应有简介（来自 book_meta 夹具）");

  // 执行改名
  const res = await fetch(`${srv.base}/api/book/rename`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, newName }),
  });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.newRel, newRel);
  assert.equal(r.migrated.shelf, true, "书架记录应迁移");
  assert.equal(r.migrated.override, true, "人工覆盖应迁移");

  // 物理文件确实改了吗
  const files = await fsp.readdir(path.join(lib.root, "批量"));
  assert.ok(files.includes(newName), `新文件名应存在：${files.filter((f) => f.includes("测试书003")).join(",")}`);
  assert.ok(!files.includes("测试书003.txt"), "旧文件名不应存在");

  // 关键：改名后元数据不能丢（路径别名跟随）
  const after = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(newRel)}`)).json()).book;
  assert.equal(after.intro, before.intro, "改名后简介必须还在（别名跟随）");
  assert.equal(after.metaSource, before.metaSource, "元数据来源不变");
  assert.equal(after.meta?.ISBN, "9780000000099", "人工覆盖也要跟随新路径");

  // 书架与进度跟着走
  const shel = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.equal(shel.items[rel], undefined, "旧 rel 的书架记录应已移除");
  assert.equal(shel.items[newRel]?.fav, true, "新 rel 应继承收藏");
  assert.equal(shel.items[newRel]?.page, 42, "阅读进度应继承");

  // 撤销：文件与数据都还原
  const undoRes = await fetch(`${srv.base}/api/book/rename/undo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel: newRel }),
  });
  assert.equal(undoRes.status, 200);
  const filesBack = await fsp.readdir(path.join(lib.root, "批量"));
  assert.ok(filesBack.includes("测试书003.txt"), "撤销后应恢复原名");
  const restored = (await (await fetch(`${srv.base}/api/book?path=${encodeURIComponent(rel)}`)).json()).book;
  assert.equal(restored.intro, before.intro, "撤销后元数据仍在");
  const shel2 = await (await fetch(`${srv.base}/api/shelves`)).json();
  assert.equal(shel2.items[rel]?.page, 42, "撤销后进度应回到新键");
  await fetch(`${srv.base}/api/metadata/override?path=${encodeURIComponent(rel)}`, { method: "DELETE" });
});

test("改名：非法名与占用名被拒绝，扩展名一律沿用原文件", async () => {
  const rel = "批量/测试书001.txt";
  const bad = async (newName) =>
    (await fetch(`${srv.base}/api/book/rename`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel, newName }),
    })).status;
  assert.equal(await bad("子目录/书名.txt"), 400, "含路径分隔符应 400");
  assert.equal(await bad(""), 400, "空名应 400");
  assert.equal(await bad("测试书002.txt"), 400, "同目录已存在应 400");
  assert.equal(await bad("测试书002"), 400, "补上扩展名后同名也应 400");
  assert.equal(await bad(".."), 400);

  // 不写扩展名 → 自动补原扩展名；写了别的扩展名 → 强制回原扩展名
  const ok1 = await fetch(`${srv.base}/api/book/rename`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, newName: "测试书001-校订版" }),
  });
  const r1 = await ok1.json();
  assert.equal(ok1.status, 200, `改名失败原因：${JSON.stringify(r1)}`);
  assert.ok(r1.newRel.endsWith(".txt"), `应补上原扩展名，实际 ${r1.newRel}`);
  await fetch(`${srv.base}/api/book/rename/undo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel: r1.newRel }),
  });

  const wrongExt = await fetch(`${srv.base}/api/book/rename`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel, newName: "测试书001-改.pdf" }),
  });
  assert.equal(wrongExt.status, 200);
  const r2 = await wrongExt.json();
  assert.equal(r2.extForced, true, "改错扩展名时应强制沿用原扩展名");
  assert.ok(r2.newRel.endsWith(".txt"), `应保留 .txt，实际 ${r2.newRel}`);
  await fetch(`${srv.base}/api/book/rename/undo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rel: r2.newRel }),
  });
});
