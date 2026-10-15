// recoArchive.test.js —— 推荐历史归档（按月分片、去重、幂等、只追加）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_DATA_DIR = TMP; // 必须在 require 之前设置（模块在加载时解析数据目录）

const { extractProcessed, monthOf, archiveProcessed, archiveStatus, ARCHIVE_DIR, parseArchiveLine, queryArchive } = require("../dist/recoArchive.js");

const FIXTURE = [
  "# 📥 雅书 · 推荐待确认",
  "",
  "## 待确认",
  "",
  "- [ ] 23415 《会思考才会表达》杜斌  →  学习　_职场表达_",
  "      作者甲 · 2026-9-1",
  "",
  "## 已处理",
  "",
  "- [-] 2026-10-03  22859  《顺逆皆宜的人生》苏·汤普金斯  → 已拒绝",
  "- [x] 2026-10-12  23408  《存钱心理学》埃玛·爱德华兹  → 已批",
  "- [-] 2026-09-28  22801  《上月的书》某人  → 已拒绝",
  "",
].join("\n");

test("提取已处理条目：只取「## 已处理」区，不含待确认条目与表头", () => {
  const lines = extractProcessed(FIXTURE);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("22859"));
  assert.ok(!lines.some((l) => l.includes("23415")), "待确认区的条目不应被当作历史");
  assert.equal(extractProcessed("没有章节标记的文本").length, 0, "无「已处理」区时返回空");
});

test("月份取自条目自身日期（跨月分片）", () => {
  assert.equal(monthOf("- [-] 2026-10-03  22859  《某书》  → 已拒绝"), "2026-10");
  assert.equal(monthOf("- [x] 2026-09-28  22801  《上月的书》  → 已批"), "2026-09");
  assert.equal(monthOf("乱七八糟的行"), "unknown");
});

test("归档：按月分片写入 Markdown、重复调用幂等、只追加", async () => {
  const first = await archiveProcessed(FIXTURE);
  assert.equal(first.archived, 3, "首次应归档 3 条");
  assert.equal(first.processed, 3);
  assert.deepEqual(first.months.sort(), ["2026-09", "2026-10"], "应分成两个月份文件");

  const oct = await fsp.readFile(path.join(ARCHIVE_DIR, "reco-archive-2026-10.md"), "utf-8");
  const sep = await fsp.readFile(path.join(ARCHIVE_DIR, "reco-archive-2026-09.md"), "utf-8");
  assert.match(oct, /^# 推荐决策归档 · 2026-10/, "应有可读的标题");
  assert.ok(oct.includes("22859") && oct.includes("23408"));
  assert.ok(!oct.includes("22801"), "9 月的条目不应写进 10 月文件");
  assert.ok(sep.includes("22801"));

  // 幂等：同一批再跑一次不重复写
  const second = await archiveProcessed(FIXTURE);
  assert.equal(second.archived, 0, "重复归档不应产生新记录");
  const oct2 = await fsp.readFile(path.join(ARCHIVE_DIR, "reco-archive-2026-10.md"), "utf-8");
  assert.equal(oct2, oct, "文件内容不应变化（只追加、去重）");

  // 新增一条才追加一条
  const more = FIXTURE + "- [x] 2026-10-13  23500  《另一本》某人  → 已批\n";
  const third = await archiveProcessed(more);
  assert.equal(third.archived, 1);
  const oct3 = await fsp.readFile(path.join(ARCHIVE_DIR, "reco-archive-2026-10.md"), "utf-8");
  assert.ok(oct3.startsWith(oct), "只应在末尾追加，不改动已有内容");
  assert.ok(oct3.includes("23500"));
});

test("归档状态：总条数、月份列表与目录", async () => {
  const st = await archiveStatus();
  assert.equal(st.total, 4, "3 条 + 追加的 1 条");
  assert.deepEqual(st.months.sort(), ["2026-09", "2026-10"]);
  assert.equal(st.dir, ARCHIVE_DIR);
  assert.ok(st.lastAt > 0);
});

test("清单为空/无历史时不产生任何文件", async () => {
  const dir = path.join(os.tmpdir(), `ebm-archive-empty-${Date.now()}`);
  process.env.EBM_DATA_DIR = dir;
  delete require.cache[require.resolve("../dist/recoArchive.js")];
  const mod = require("../dist/recoArchive.js");
  const r = await mod.archiveProcessed("## 待确认\n\n- [ ] 1 《某书》某人  → 学习\n");
  assert.equal(r.archived, 0);
  const st = await mod.archiveStatus();
  assert.equal(st.total, 0);
  process.env.EBM_DATA_DIR = TMP;
});

test("归档行解析：日期/动作/ID/书名/目录/理由（曾因捕获组写错而恒为 null）", () => {
  const approve = parseArchiveLine("- [x] 2026-10-12  23408  《存钱心理学》埃玛·爱德华兹  →  经济&投资　_消费心理学科普_  → 已批", "2026-10");
  assert.ok(approve, "批准行必须能解析");
  assert.equal(approve.date, "2026-10-12");
  assert.equal(approve.action, "approve");
  assert.equal(approve.id, 23408);
  assert.equal(approve.title, "《存钱心理学》埃玛·爱德华兹");
  assert.equal(approve.folder, "经济&投资");
  assert.equal(approve.note, "消费心理学科普");
  assert.equal(approve.month, "2026-10");

  const reject = parseArchiveLine("- [-] 2026-10-03  22859  《顺逆皆宜的人生》苏·汤普金斯  → 已拒绝", "2026-10");
  assert.ok(reject);
  assert.equal(reject.action, "reject");
  assert.equal(reject.title, "《顺逆皆宜的人生》苏·汤普金斯");
  assert.equal(reject.folder, "", "没有目录时留空而不是塞进书名");

  assert.equal(parseArchiveLine("- [ ] 2026-10-12 23415 《待确认的书》  → 学习", "2026-10"), null, "待确认行不应被当成历史");
  assert.equal(parseArchiveLine("随便一行文字", "2026-10"), null);
});

test("归档查询：月份列表、关键词过滤、新→旧排序", async () => {
  const all = await queryArchive({ limit: 100 });
  assert.ok(all.total >= 4, `应能读到已归档条目，实际 ${all.total}`);
  assert.deepEqual(all.months.map((m) => m.month).sort(), ["2026-09", "2026-10"]);
  const sorted = all.items.map((e) => e.date);
  const desc = [...sorted].sort().reverse();
  assert.deepEqual(sorted, desc, "应按日期新→旧");

  const byQ = await queryArchive({ q: "存钱" });
  assert.equal(byQ.matched, 1);
  assert.equal(byQ.items[0].id, 23408);

  const byMonth = await queryArchive({ month: "2026-09" });
  assert.equal(byMonth.total, 1, "只看 9 月应只剩那一条");
  assert.equal(byMonth.items[0].id, 22801);

  const limited = await queryArchive({ limit: 2 });
  assert.equal(limited.items.length, 2);
  assert.equal(limited.truncated, true, "被 limit 截断时应标记");
});
