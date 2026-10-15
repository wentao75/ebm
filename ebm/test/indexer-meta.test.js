// indexer-meta.test.js —— 雅书元数据映射：清单(id→文件)优先、模糊书名兜底、下载后无需重启
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_WATCH_DIR = TMP; // 必须在 require 之前

const { LibraryIndex, cleanSourceText } = require("../dist/indexer.js");

/** 造一个书库文件条目 */
function fileOf(rel, size = 1024) {
  return {
    rel,
    abs: `/library/${rel}`,
    name: path.basename(rel),
    ext: path.extname(rel).toLowerCase(),
    category: rel.split("/")[0],
    size,
    mtimeMs: Date.now(),
    dataless: false,
  };
}

async function writePostDetails(details) {
  await fsp.writeFile(path.join(TMP, "post_details.json"), JSON.stringify(details), "utf-8");
}
async function writeManifest(rows) {
  await fsp.writeFile(path.join(TMP, "download_manifest_result.json"), JSON.stringify(rows), "utf-8");
}

test("序号清单映射：书名完全对不上时，也能按 id→文件 精确拿到网站的简介/目录/元数据", async () => {
  await fsp.mkdir(TMP, { recursive: true });
  // 帖子标题与书库文件名毫无关系（模拟站点标题与本地改名差异很大）
  await writePostDetails({
    // 帖子标题规范化后与库内文件名不同
    "23421": {
      id: 23421,
      title: "《本站帖子里的书名》(站点写法)【文字版_PDF电子书_雅书】",
      intro: "这是网站上的完整简介：本书……（足够长的一段介绍文字，用于验证映射是否生效）",
      toc: "第一章 起点/001\n第二章 展开/027",
      douban: "8.7",
      tags: ["心理学"],
      meta: { 书名: "《完全不同的书名》", 作者: "钟某", 出版社: "上海人民出版社", 译者: "某人", 页数: "308" },
    },
  });
  // 清单把 id 映射到"下载时的文件名"（带管道标记）；库里已被清理规则改名
  await writeManifest([
    {
      id: 23421,
      status: "OK",
      file: "/x/yabook_watch/staging/《故事里的心理学》钟颖【文字版_PDF电子书_雅书】.pdf",
    },
  ]);

  const idx = new LibraryIndex();
  await idx.build([fileOf("心理学/《故事里的心理学》钟颖.pdf")]);
  const entry = idx.entries[0]; // build() 产出的是新的条目对象（不是传入的输入对象）

  assert.equal(entry.sourceId, 23421, "应通过清单映射认领到雅书帖子");
  assert.ok(String(entry.intro || "").includes("网站上的完整简介"), `简介应来自该帖子：${entry.intro}`);
  assert.ok(String(entry.toc || "").includes("第一章"), "目录也应带进来");
  assert.equal(entry.douban, "8.7");
  assert.equal(entry.meta?.["出版社"], "上海人民出版社");
  assert.equal(entry.meta?.["译者"], "某人");
  assert.equal(entry.meta?.["页数"], "308");
});

test("没有清单时仍按书名模糊匹配（老路径不能坏）", async () => {
  await fsp.rm(path.join(TMP, "download_manifest_result.json"), { force: true });
  await writePostDetails({
    "1": {
      id: 1,
      title: "《万历十五年》黄仁宇【文字版_PDF电子书_雅书】",
      intro: "模糊匹配拿到的简介",
      meta: { 作者: "黄仁宇", 出版社: "中华书局" },
    },
  });
  const idx = new LibraryIndex();
  await idx.build([fileOf("历史/《万历十五年》黄仁宇.pdf")]);
  const entry = idx.entries[0];
  assert.equal(entry.sourceId, 1, "应按归一化书名匹配到帖子");
  assert.ok(String(entry.intro || "").includes("模糊匹配"));
});

test("下载后无需重启：新写入的清单/详情会在下一次重建索引时生效", async () => {
  await writePostDetails({}); // 先空
  await fsp.rm(path.join(TMP, "download_manifest_result.json"), { force: true });
  const idx = new LibraryIndex();
  await idx.build([fileOf("科普/《新下载的书》某人.pdf")]);
  assert.equal(idx.entries[0].sourceId, undefined, "起初没有元数据");

  // 模拟：手动下载完成 → 管道写出清单与详情（服务进程不重启）
  await writePostDetails({
    "24000": { id: 24000, title: "《新下载的书》某人【文字版_PDF电子书_雅书】", intro: "下载后才有的简介" },
  });
  await writeManifest([{ id: 24000, status: "OK", file: "/x/staging/《新下载的书》某人【文字版_PDF电子书_雅书】.pdf" }]);

  await idx.build([fileOf("科普/《新下载的书》某人.pdf")]);
  const after = idx.entries[0];
  assert.equal(after.sourceId, 24000, "重建索引时应重读管道文件，无需重启服务");
  assert.ok(String(after.intro || "").includes("下载后才有的简介"));
});

test("清理折叠态残留：(展开全部)/结尾省略号/游离引号都不应出现在界面文本里", () => {
  assert.equal(
    cleanSourceText("……一张知识的巨网，读者在不觉间即可学会使用统计学思维解决问题。\n ...\n(展开全部)"),
    "……一张知识的巨网，读者在不觉间即可学会使用统计学思维解决问题。",
  );
  assert.equal(cleanSourceText("正文结束。“"), "正文结束。");
  assert.equal(cleanSourceText("正文（收起）"), "正文");
  assert.equal(cleanSourceText("正常简介，结尾是完整句子。"), "正常简介，结尾是完整句子。", "正常文本不得被改动");
});

test("索引时即清理：来源里的折叠痕迹不会进入书库数据", async () => {
  await writePostDetails({
    "9": { id: 9, title: "《某书》某人【文字版_PDF电子书_雅书】", intro: "真正的简介正文。\n ...\n(展开全部)" },
  });
  const idx = new LibraryIndex();
  await idx.build([fileOf("心理/《某书》某人.pdf")]);
  const e = idx.entries[0];
  assert.ok(!String(e.intro).includes("展开全部"), `简介不应含折叠痕迹：${e.intro}`);
  assert.equal(e.intro, "真正的简介正文。");
});
