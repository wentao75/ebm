// meta-link-api.test.js —— 元数据体检 / 重新匹配 / 按链接更新（全部离线夹具，不联网）
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { makeLibrary, startServer, tmpDir, cleanup } = require("./helper");

let lib, dataDir, srv, metaFile;

const TARGET_REL = "历史/万历十五年.txt";
const SUSPECT_REL = "历史/明朝那些事儿.pdf";

/** 豆瓣详情页最小夹具（字段与 meta_enrich.douban_subject 的解析规则对齐） */
const DOUBAN_HTML = `<!DOCTYPE html><html><head><title>更壮 更瘦 更强 (豆瓣)</title></head><body>
<div id="wrapper">
  <span property="v:itemreviewed">更壮 更瘦 更强</span>
  <strong><span property="v:average">7.5</span></strong>
  <div id="info">
    <span class="pl"> 作者</span>: <a href="/author/4652639/">Michael Matthews</a><br/>
    <span class="pl"> 出版社:</span> 机械工业出版社丛<br/>
    <span class="pl"> 译者</span>: 凌云<br/>
    <span class="pl"> 出版年:</span> 2017-6<br/>
    <span class="pl"> 页数:</span> 352<br/>
    <span class="pl"> 定价:</span> 68.00元<br/>
    <span class="pl"> 装帧:</span> 精装<br/>
    <span class="pl"> 原作名:</span> Bigger Leaner Stronger<br/>
    <span class="pl"> ISBN:</span> 9787518925094<br/>
  </div>
  <div class="related_info">
    <h2>内容简介</h2>
    <div class="intro"><p>本书针对那些没有系统掌握健身知识的男性健身者，从健身的基本原则、生理学、营养学基础知识入手，帮助读者在十二周内增肌减脂。</p></div>
    <h2>作者简介</h2>
    <div class="intro"><p>Michael Matthews 是畅销健身书作者。</p></div>
  </div>
</div></body></html>`;

/** 搜索 suggest 夹具：返回正确的候选（27107200） */
const SUGGEST_JSON = JSON.stringify([
  { type: "b", id: "27107200", title: "更壮 更瘦 更强", author_name: "Michael Matthews", year: "2017", url: "https://book.douban.com/subject/27107200/" },
]);

async function postJson(base, p, body) {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  lib = await makeLibrary();
  dataDir = await tmpDir("ebm-metalink-api-");
  metaFile = path.join(dataDir, "book_meta.json");
  await fsp.writeFile(
    metaFile,
    JSON.stringify(
      {
        generated_at: "2026-10-28T00:00:00",
        books: {
          [TARGET_REL]: {
            path: TARGET_REL,
            search_title: "更壮  更瘦  更强  身体革命，健身见真我",
            title: "更壮  更瘦  更强  身体革命,健身见真我",
            author: "Michael Matthews",
            sources: { douban: "37367267" },
            douban: "6.3",
            publisher: "国文出版社",
          },
          [SUSPECT_REL]: {
            path: SUSPECT_REL,
            search_title: "明朝那些事儿",
            title: "身体革命", // 故意与文件标题差异很大 → 体检应报出来
            author: "当年明月",
            sources: { douban: "12345678" },
          },
        },
      },
      null,
      1,
    ),
    "utf-8",
  );
  const htmlPath = path.join(dataDir, "douban.html");
  const suggestPath = path.join(dataDir, "suggest.json");
  await fsp.writeFile(htmlPath, DOUBAN_HTML, "utf-8");
  await fsp.writeFile(suggestPath, SUGGEST_JSON, "utf-8");
  srv = await startServer({
    libraryRoot: lib.root,
    dataDir,
    extraEnv: { EBM_BOOK_META: metaFile, EBM_DOUBAN_HTML: htmlPath, EBM_DOUBAN_SUGGEST: suggestPath },
  });
});

after(async () => {
  if (srv) await srv.stop();
  if (lib) await cleanup(lib.root);
  if (dataDir) await cleanup(dataDir);
});

test("GET /api/metadata/audit：报出标题差异大的可疑记录", async () => {
  const r = await (await fetch(`${srv.base}/api/metadata/audit`)).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Array.isArray(r.suspects), "应返回 suspects 数组");
  const hit = r.suspects.find((x) => x.rel === SUSPECT_REL);
  assert.ok(hit, `可疑记录应包含 ${SUSPECT_REL}: ${JSON.stringify(r.suspects)}`);
  assert.ok(hit.similarity < 45, `相似度应很低，实际 ${hit.similarity}`);
  assert.equal(hit.matchedTitle, "身体革命");
});

test("POST /api/metadata/link：按豆瓣链接抓取并写回（标记 pinned）", async () => {
  const r = await postJson(srv.base, "/api/metadata/link", { rel: TARGET_REL, url: "https://book.douban.com/subject/27107200/" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.title, "更壮 更瘦 更强");
  assert.equal(r.body.publisher, "机械工业出版社丛");
  assert.equal(r.body.douban, "7.5");

  const meta = JSON.parse(await fsp.readFile(metaFile, "utf-8"));
  const rec = meta.books[TARGET_REL];
  assert.equal(rec.pinned, true, "用户指定链接的书应标记 pinned（后续 enrich 不覆盖）");
  assert.equal(rec.isbn, "9787518925094");
  assert.equal(rec.original_title, "Bigger Leaner Stronger");
  assert.match(String(rec.intro), /十二周内增肌减脂/);
  assert.equal(rec.sources.douban, "27107200");
  // 未受影响的书保持原样
  assert.equal(meta.books[SUSPECT_REL].title, "身体革命");
});

test("POST /api/metadata/link：非豆瓣链接/缺参给出 400", async () => {
  const bad = await postJson(srv.base, "/api/metadata/link", { rel: TARGET_REL, url: "https://example.com/book/1" });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /豆瓣/);
  const missing = await postJson(srv.base, "/api/metadata/link", { url: "27107200" });
  assert.equal(missing.status, 400);
});

test("POST /api/metadata/rematch：用修复后的匹配器重查（离线 suggest 夹具）", async () => {
  const r = await postJson(srv.base, "/api/metadata/rematch", { rel: TARGET_REL });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.doubanId, "27107200");
  const meta = JSON.parse(await fsp.readFile(metaFile, "utf-8"));
  assert.equal(meta.books[TARGET_REL].sources.douban, "27107200");
  assert.equal(meta.books[TARGET_REL].publisher, "机械工业出版社丛");
});
