// recoRestore.test.js —— 「恢复为待定」：拒绝前快照 + 精确还原（EBM 唯一写 tiers.json 的路径）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `ebm-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const WATCH = path.join(TMP, "watch");
process.env.EBM_DATA_DIR = path.join(TMP, "data");
process.env.EBM_WATCH_DIR = WATCH;

const { stripRejectNote, isRejected, snapshotBeforeReject, restoreRejected, restoreStatus } = require("../dist/recoRestore.js");

const TIERS = {
  "23415": { tier: 2, folder: "学习", note: "职场表达工具书，拿不准", title: "《会思考才会表达》杜斌", cat: "知识" },
  "22859": { tier: 3, folder: null, note: "占星相位 汤普金斯 豆瓣8.9 | 用户拒绝", title: "《顺逆皆宜的人生》" },
  "23001": { tier: 1, folder: "学习", note: "已批准待下载", title: "《已批准的书》" },
};

async function writeTiers(t) {
  await fsp.mkdir(WATCH, { recursive: true });
  await fsp.writeFile(path.join(WATCH, "tiers.json"), JSON.stringify(t, null, 1), "utf-8");
}
async function readTiers() {
  return JSON.parse(await fsp.readFile(path.join(WATCH, "tiers.json"), "utf-8"));
}

test("备注处理：去掉管道追加的「用户拒绝」，保留原有理由", () => {
  assert.equal(stripRejectNote("消费心理学科普 | 用户拒绝"), "消费心理学科普");
  assert.equal(stripRejectNote("用户拒绝"), "");
  assert.equal(stripRejectNote("A | 用户拒绝 | B"), "A | B");
  assert.equal(stripRejectNote(undefined), "");
});

test("拒绝判定：tier3 或备注带拒绝标记都算", () => {
  assert.equal(isRejected({ tier: 3 }), true);
  assert.equal(isRejected({ tier: 2, note: "x | 用户拒绝" }), true);
  assert.equal(isRejected({ tier: 2, note: "正常" }), false);
  assert.equal(isRejected(undefined), false);
});

test("快照 + 恢复：folder/note 精确还原，其它字段与其它条目不受影响", async () => {
  await writeTiers(TIERS);
  // 快照 23415（它将被拒绝）
  const n = await snapshotBeforeReject([23415], { 23415: "《会思考才会表达》杜斌" });
  assert.equal(n, 1);
  const st = await restoreStatus();
  assert.equal(st.snapshots, 1);

  // 模拟管道 apply 的拒绝语义：tier=3、folder 置空、note 追加 " | 用户拒绝"
  const after = await readTiers();
  after["23415"] = { ...after["23415"], tier: 3, folder: null, note: "职场表达工具书，拿不准 | 用户拒绝" };
  await writeTiers(after);

  const r = await restoreRejected([23415]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored.length, 1);
  assert.equal(r.restored[0].fromSnapshot, true);
  const back = await readTiers();
  assert.equal(back["23415"].tier, 2, "应恢复为待定");
  assert.equal(back["23415"].folder, "学习", "应按快照还原原目录");
  assert.equal(back["23415"].note, "职场表达工具书，拿不准", "应去掉拒绝标记并还原原理由");
  assert.equal(back["23415"].cat, "知识", "其它字段不得改动");
  assert.deepEqual(back["22859"], TIERS["22859"], "未涉及的条目不得改动");
  assert.deepEqual(back["23001"], TIERS["23001"]);
  assert.ok(r.backup && r.backup.includes("tiers-backup"), `应写出备份：${r.backup}`);
  const backups = await fsp.readdir(path.dirname(r.backup));
  assert.ok(backups.length >= 1, "备份目录应有文件");
});

test("没有快照时也能恢复（仅清除拒绝标记）", async () => {
  await writeTiers({ "22859": { tier: 3, folder: null, note: "占星相位 豆瓣8.9 | 用户拒绝" } });
  const r = await restoreRejected([22859]);
  assert.equal(r.ok, true);
  assert.equal(r.restored[0].fromSnapshot, false);
  const back = await readTiers();
  assert.equal(back["22859"].tier, 2);
  assert.equal(back["22859"].note, "占星相位 豆瓣8.9", "应清掉拒绝标记");
});

test("校验：非拒绝状态 / 不存在 / 空数组都被拒绝且不改数据", async () => {
  await writeTiers(TIERS);
  const before = JSON.stringify(await readTiers());
  const notRejected = await restoreRejected([23001]);
  assert.equal(notRejected.ok, false);
  assert.match(String(notRejected.error), /没有可恢复/);
  assert.equal(notRejected.skipped[0].id, 23001);

  const missing = await restoreRejected([999999]);
  assert.equal(missing.ok, false);

  const empty = await restoreRejected([]);
  assert.equal(empty.ok, false);

  const tooMany = await restoreRejected(Array.from({ length: 51 }, (_, i) => i + 1));
  assert.equal(tooMany.ok, false);
  assert.match(String(tooMany.error), /最多恢复 50/);

  assert.equal(JSON.stringify(await readTiers()), before, "以上失败路径都不得改动 tiers.json");
});

test("恢复后再次拒绝→再恢复，仍然能拿回原目录（快照可重复写入）", async () => {
  await writeTiers({ "23415": { tier: 2, folder: "学习", note: "原始理由" } });
  await snapshotBeforeReject([23415], {});
  const t = await readTiers();
  t["23415"] = { tier: 3, folder: null, note: "原始理由 | 用户拒绝" };
  await writeTiers(t);
  const first = await restoreRejected([23415]);
  assert.equal(first.ok, true);
  assert.equal((await readTiers())["23415"].folder, "学习");

  const again = await readTiers();
  again["23415"] = { tier: 3, folder: null, note: "原始理由 | 用户拒绝 | 用户拒绝" };
  await writeTiers(again);
  const second = await restoreRejected([23415]);
  assert.equal(second.ok, true, "重复拒绝后仍应能恢复");
  const final = await readTiers();
  assert.equal(final["23415"].tier, 2);
  assert.equal(final["23415"].note, "原始理由", "重复的拒绝标记都应被清掉");
});
