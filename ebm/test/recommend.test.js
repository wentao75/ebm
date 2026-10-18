// recommend.test.js —— 「待下载确认」解析与勾选翻转（纯函数，夹具取自真实 _推荐待确认.md 结构）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { parseRecfile, parseLabel, flipMarks, LINE_RE, normalizeDouban, toView, normTitleKey, matchInLibrary, readFailureHint } = require("../dist/recommend.js");

// 真实文件结构的精简夹具（含表头里的 `[ ]` 干扰项、月份分组、明细行、已处理区）
const FIXTURE = [
  "# 📥 雅书 · 推荐待确认",
  "",
  "| 标记 | 含义 | 效果 |",
  "|---|---|---|",
  "| `[ ]` | 还想再想想 | 保持不动 |",
  "| `[x]` | **确认下载** | 下次巡检自动下载 |",
  "| `[-]` | 不要了 | 不再推荐 |",
  "",
  "## 待确认",
  "",
  "### 2026-10（2 本）",
  "",
  "- [ ] 23415 《会思考才会表达》杜斌  →  学习　_职场表达工具书，拿不准_",
  "      杜斌 · 2026-8-1",
  "      杜斌博士依托10余年高校教学经验，凝练成《会思考才会表达》…",
  "",
  "- [x] 23408 《存钱心理学》埃玛·爱德华兹  →  经济&投资　_消费心理学_",
  "      [澳]埃玛·爱德华兹 · 2025-7-1",
  "",
  "## 已处理",
  "",
  "- [-] 2026-10-03  22859  《顺逆皆宜的人生》苏·汤普金斯  → 已拒绝",
  "",
].join("\n");

test("解析：待确认条目（含勾选状态、明细行、简介）", () => {
  const r = parseRecfile(FIXTURE);
  assert.equal(r.pending.length, 2);
  const first = r.pending[0];
  assert.equal(first.id, 23415);
  assert.equal(first.mark, " ");
  assert.equal(first.label, "《会思考才会表达》杜斌  →  学习　_职场表达工具书，拿不准_");
  assert.equal(first.detail.length, 2, "应带上作者/日期与简介两行明细");
  assert.match(first.detail[0], /杜斌 · 2026-8-1/);
  assert.equal(r.pending[1].mark, "x", "已勾选状态要读出来");
  assert.equal(r.pending[1].id, 23408);
});

test("解析：已处理区与表头不混进待确认", () => {
  const r = parseRecfile(FIXTURE);
  assert.equal(r.processed.length, 1);
  assert.match(r.processed[0], /22859/);
  assert.ok(!r.pending.some((p) => p.id === 22859), "已处理的 id 不应出现在待确认");
});

test("解析：行正则与管道 recommend.py 保持一致", () => {
  // 管道里的正则：^\s*-\s*\[([ xX\-✓×])\]\s*(\d+)\s+(.*)$
  const m = LINE_RE.exec("- [x] 23408 《存钱心理学》…  →  经济&投资");
  assert.ok(m, "应能匹配标准条目行");
  assert.equal(m[1], "x");
  assert.equal(m[2], "23408");
  // 表格行不应被当成条目
  assert.equal(LINE_RE.exec("| `[ ]` | 还想再想想 | 保持不动 |"), null);
});

test("标签解析：拆出书名、建议目录、判断理由", () => {
  const p = parseLabel("《会思考才会表达》杜斌  →  学习　_职场表达工具书，拿不准_");
  assert.equal(p.title, "《会思考才会表达》杜斌");
  assert.equal(p.folder, "学习");
  assert.equal(p.note, "职场表达工具书，拿不准");
  const q = parseLabel("《存钱心理学》埃玛·爱德华兹  →  经济&投资　_消费/金钱心理学科普_");
  assert.equal(q.folder, "经济&投资");
  assert.equal(q.note, "消费/金钱心理学科普");
  // 没有理由也能解析
  const r = parseLabel("《某书》某人  →  未分类");
  assert.equal(r.folder, "未分类");
  assert.equal(r.note, "");
});

test("翻转勾选：只改待确认区里指定 id 的方括号字符", () => {
  const out = flipMarks(FIXTURE, { approve: [23415], reject: [] });
  assert.match(out, /- \[x\] 23415 《会思考才会表达》/, "批准应写成 [x]");
  assert.match(out, /- \[x\] 23408 《存钱心理学》/, "未指定的条目保持原样");
  assert.match(out, /- \[-\] 2026-10-03  22859/, "已处理区不能被改动");
  assert.match(out, /\| `\[ \]` \| 还想再想想 \| 保持不动 \|/, "表头里的 [ ] 不能被改动");

  const out2 = flipMarks(FIXTURE, { approve: [], reject: [23408, 23415] });
  assert.match(out2, /- \[-\] 23408 /);
  assert.match(out2, /- \[-\] 23415 /);
});

test("翻转勾选：幂等、未知 id 不产生任何变化、整篇其余字节不变", () => {
  const once = flipMarks(FIXTURE, { approve: [23415] });
  const twice = flipMarks(once, { approve: [23415] });
  assert.equal(twice, once, "重复勾选同一状态应幂等");

  const noop = flipMarks(FIXTURE, { approve: [99999], reject: [88888] });
  assert.equal(noop, FIXTURE, "未知 id 不应改动文件");

  // 除方括号里的字符外，其余内容必须逐字节一致
  const strip = (t) => t.replace(/^(\s*-\s*\[)([^\]])(\].*)$/gm, "$1_$3");
  assert.equal(strip(once), strip(FIXTURE));
});

test("豆瓣评分：0.0 与空值视为无评分，有效分保留", () => {
  assert.equal(normalizeDouban("0.0"), undefined, "0.0 是管道的「抓不到」哨兵值");
  assert.equal(normalizeDouban(""), undefined);
  assert.equal(normalizeDouban(undefined), undefined);
  assert.equal(normalizeDouban("8.1"), "8.1");
  assert.equal(normalizeDouban(7.5), "7.5");
  // 走完整视图映射也应该把 0.0 丢掉
  const v = toView({ id: 1, mark: " ", label: "《甲》乙  →  学习　_理由_", detail: ["作者甲 · 2026-1-1", "简介"] }, { douban: "0.0" });
  assert.equal(v.douban, undefined);
  assert.equal(v.folder, "学习");
  assert.equal(v.author, "作者甲");
});

test("书名归一化：去扩展名/括注/标记/标点，与管道 norm_key 同思路", () => {
  assert.equal(normTitleKey("《故事里的心理学》钟颖.pdf"), "故事里的心理学钟颖");
  assert.equal(normTitleKey("《存钱心理学》埃玛·爱德华兹【文字版_PDF电子书_雅书】.pdf"), "存钱心理学埃玛爱德华兹");
  assert.equal(normTitleKey("The RLHF Book.epub"), "therlhfbook", "只接收文件名（调用方传 basename）");
  assert.equal(normTitleKey("《万历十五年》黄仁宇"), "万历十五年黄仁宇", "队列书名带作者时保留作者，靠匹配规则兜住");
  assert.equal(normTitleKey(""), "");
});

test("队列与书库匹配：精确/前后缀/长包含都算命中，短标题不误判", () => {
  const lib = [
    { rel: "心理学/《故事里的心理学》钟颖.pdf", key: normTitleKey("《故事里的心理学》钟颖.pdf") },
    { rel: "历史/万历十五年.txt", key: normTitleKey("万历十五年.txt") },
    { rel: "IT&技术/The RLHF Book.epub", key: normTitleKey("The RLHF Book.epub") },
  ];
  assert.equal(matchInLibrary("《故事里的心理学》钟颖", lib), "心理学/《故事里的心理学》钟颖.pdf", "完全一致");
  assert.equal(matchInLibrary("《万历十五年》黄仁宇", lib), "历史/万历十五年.txt", "队列名带作者、文件名不带 → 前缀命中");
  assert.equal(matchInLibrary("The RLHF Book", lib), "IT&技术/The RLHF Book.epub");
  assert.equal(matchInLibrary("《完全无关的书名》某人", lib), null, "无关书名不得误判");
  assert.equal(matchInLibrary("《万历》", lib), null, "过短的书名不参与模糊匹配");
  assert.equal(matchInLibrary("", lib), null);
});

test("清单读取失败的提示要区分「不存在 / 脚本缺失 / iCloud 未下载」", () => {
  const file = "/x/_推荐待确认.md";
  assert.match(readFailureHint({ exists: true, dataless: true, scriptAvailable: true, file }), /iCloud.*占位.*自动取回失败/);
  assert.match(readFailureHint({ exists: true, dataless: false, scriptAvailable: true, file }), /读取失败/);
  assert.match(readFailureHint({ exists: false, dataless: false, scriptAvailable: true, file }), /还不存在/);
  assert.match(readFailureHint({ exists: false, dataless: false, scriptAvailable: false, file }), /recommend\.py 不可用/);
});
