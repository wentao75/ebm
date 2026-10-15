// rename.test.js —— 文件名清理规则 / 名称校验 / 重命名计划 / 路径别名链
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

process.env.EBM_DATA_DIR = path.join(os.tmpdir(), `ebm-rename-${Date.now()}`);
const { suggestFileName, validateName, PathAliasStore } = require("../dist/rename.js");

// 真实书库里的噪声样本（都取自实测）
const CASES = [
  ["2018-05《健身笔记：如何成为一个身材有料的人》[yabook.org].pdf", "《健身笔记：如何成为一个身材有料的人》.pdf"],
  ["2018-07故事课（套装2册）[yabook.org].pdf", "故事课（套装2册）.pdf"],
  ["《妙想奇谭：中国古代奇幻百科》赵运涛【文字版_PDF电子书_雅书】.pdf", "《妙想奇谭：中国古代奇幻百科》赵运涛.pdf"],
  ["《安全边际》塞斯•卡拉曼.文字版电子书[PDF].pdf", "《安全边际》塞斯•卡拉曼.pdf"],
  ["世界名著（全10册）文字版电子书[PDF]+下载地址.epub", "世界名著（全10册）.epub"],
  ["[TOEFL词汇词根%2B联想记忆法（乱序版）].俞敏洪.扫描版.pdf", "[TOEFL词汇词根+联想记忆法（乱序版）].俞敏洪.pdf"],
  ["深度工作+-+[美]+卡尔·纽波特.pdf", "深度工作 - [美] 卡尔·纽波特.pdf"],
  ["[V版]水的答案知多少+水的第四相：不只是固态、液态和气态 +(美)杰拉德·波拉克 化学工业 2015.9.pdf",
    "水的答案知多少+水的第四相：不只是固态、液态和气态 +(美)杰拉德·波拉克 化学工业 2015.9.pdf"],
  ["Excel公式 函数与图表应用大全 Office办公无忧 恒盛杰资讯 .pdf", "Excel公式 函数与图表应用大全 Office办公无忧 恒盛杰资讯.pdf"],
  // 用户实测报告：文件名只去掉 [V版]，**下划线必须保留**（书名才归一化为空格）
  ["[V版]中华成语典故全鉴 典藏版_杨敬敬_中国纺织_2016.10.pdf",
    "中华成语典故全鉴 典藏版_杨敬敬_中国纺织_2016.10.pdf"],
];

test("文件名清理：站点标记/URL编码/+号噪声/日期前缀都被清理", () => {
  for (const [input, expected] of CASES) {
    const r = suggestFileName(input);
    assert.equal(r.suggested, expected, `输入：${input}`);
    assert.ok(r.rules.length > 0, `应有规则命中：${input}`);
  }
});

test("文件名清理：含糊内容只提示、不自动改（副本序号 / 下划线 / 英文段落）", () => {
  const copy = suggestFileName("Quantitative+Trading+Strategies (1).pdf");
  assert.equal(copy.suggested, "Quantitative+Trading+Strategies (1).pdf", "副本序号不得自动改");
  assert.ok(copy.notes.some((n) => n.includes("副本序号")), "应给出副本提示");

  const under = suggestFileName("Agentic_Design_Patterns.pdf");
  assert.equal(under.suggested, "Agentic_Design_Patterns.pdf", "英文下划线文件名不应被动");
  assert.ok(under.notes.some((n) => n.includes("下划线")), "应给出下划线提示");
});

test("文件名清理：幂等（对建议结果再跑一次不再变化）", () => {
  for (const [input] of CASES) {
    const once = suggestFileName(input).suggested;
    const twice = suggestFileName(once).suggested;
    assert.equal(twice, once, `不幂等：${input} → ${once} → ${twice}`);
  }
});

test("文件名清理：扩展名必须原样保留", () => {
  for (const [input] of CASES) {
    const ext = path.extname(input);
    assert.ok(suggestFileName(input).suggested.endsWith(ext), `扩展名被改：${input}`);
  }
});

test("两条规则必须不同：文件名保留下划线，书名还原为空格", () => {
  const r = suggestFileName("[V版]中华成语典故全鉴 典藏版_杨敬敬_中国纺织_2016.10.pdf");
  assert.equal(r.suggested, "中华成语典故全鉴 典藏版_杨敬敬_中国纺织_2016.10.pdf", "文件名里的下划线不能被处理");
  assert.ok(r.suggested.includes("_"), "文件名应保留下划线");
  assert.equal(r.title, "中华成语典故全鉴 典藏版 杨敬敬 中国纺织 2016.10", "书名应把下划线还原为空格");
  assert.ok(!r.title.includes("_"), "书名不应含下划线");
  assert.ok(r.notes.some((n) => n.includes("下划线")), "应提示下划线保持不变");

  // 英文文件名同理：文件名不动，书名去下划线
  const en = suggestFileName("Agentic_Design_Patterns.pdf");
  assert.equal(en.suggested, "Agentic_Design_Patterns.pdf");
  assert.equal(en.title, "Agentic Design Patterns");
});

test("建议书名：保留空格，不出现 _ 或连接符式 -", () => {
  assert.equal(suggestFileName("Agentic_Design_Patterns.pdf").title, "Agentic Design Patterns", "下划线应还原为空格");
  assert.equal(suggestFileName("旅行摄影大师班+.+英+科尼什.扫描版[PDF]+下载地址.txt").title, "旅行摄影大师班");
  assert.equal(suggestFileName("深度工作+-+[美]+卡尔·纽波特.pdf").title, "深度工作");
  // 词内连字符不能被动（COVID-19 这类）
  assert.equal(suggestFileName("COVID-19 and the World.pdf").title, "COVID-19 and the World");
  assert.equal(
    suggestFileName("[V版]中华成语典故全鉴 典藏版_杨敬敬_中国纺织_2016.10.pdf").title,
    "中华成语典故全鉴 典藏版 杨敬敬 中国纺织 2016.10",
    "中文书名里的下划线应还原为空格",
  );
  for (const [, name] of CASES) {
    const t = suggestFileName(name).title;
    assert.ok(!t.includes("_"), `书名不应含下划线：${t}`);
    assert.ok(!/\s-\s/.test(t), `书名不应含连接符式 -：${t}`);
  }
});

test("建议书名：与列表解析一致（《…》取内层、A - B 取 A）", () => {
  assert.equal(suggestFileName("2018-05《健身笔记：如何成为一个身材有料的人》[yabook.org].pdf").title, "健身笔记：如何成为一个身材有料的人");
  assert.equal(suggestFileName("深度工作+-+[美]+卡尔·纽波特.pdf").title, "深度工作");
});

test("文件名校验：空名/路径分隔符/占位符/超长都被拒绝", () => {
  assert.ok(validateName("") !== null);
  assert.ok(validateName("   ") !== null);
  assert.ok(validateName("a/b.pdf") !== null);
  assert.ok(validateName("a\\b.pdf") !== null);
  assert.ok(validateName("..") !== null);
  assert.ok(validateName("x".repeat(300)) !== null);
  assert.equal(validateName("正常书名.pdf"), null);
});

test("路径别名：跟随 A→B→C 多级链，解析到最原始的名字", async () => {
  const file = path.join(process.env.EBM_DATA_DIR, "aliases.json");
  const store = new PathAliasStore(file);
  await store.load();
  store.add("B/书.pdf", "A/书.pdf");
  store.add("C/书.pdf", "B/书.pdf");
  assert.equal(store.resolve("C/书.pdf"), "A/书.pdf", "多级链应解析到最原始 rel");
  assert.equal(store.resolve("B/书.pdf"), "A/书.pdf");
  assert.equal(store.resolve("A/书.pdf"), "A/书.pdf", "最原始的名字保持不变");
  await store.flushNow();
  const reloaded = new PathAliasStore(file);
  await reloaded.load();
  assert.equal(reloaded.resolve("C/书.pdf"), "A/书.pdf", "别名应落盘并可重新载入");
  await fsp.rm(file, { force: true });
});
