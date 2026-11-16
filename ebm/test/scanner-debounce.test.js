// scanner-debounce.test.js —— 批量文件变更只触发有限次重扫（防抖 + 最小间隔）
// 背景：2026-11-16 公网 504 排查发现，管道批量归档 497 个文件时 EBM 连续全量重扫，
// 在 iCloud 上每次 stat 都可能触发元数据拉取，加剧 CPU/IO 压力。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

test("批量写入 20 个文件 → 重扫次数远小于文件数（防抖生效）", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ebm-scan-debounce-"));
  process.env.EBM_LIBRARY_ROOT = root; // 必须在 require 之前
  const { LibraryScanner } = require("../dist/scanner.js");
  const scanner = new LibraryScanner();
  let scans = 0;
  scanner.on("updated", () => {
    scans++;
  });
  try {
    await scanner.startWatching();
    const baseline = scans;
    // 快速写入 20 个文件（模拟批量归档）
    await fsp.mkdir(path.join(root, "批量"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      await fsp.writeFile(path.join(root, "批量", `书${String(i).padStart(2, "0")}.txt`), "x".repeat(200));
    }
    // 等待防抖 + 最小间隔窗口（3s 防抖 + 10s 间隔，留足余量）
    await new Promise((r) => setTimeout(r, 16000));
    const rescans = scans - baseline;
    assert.ok(rescans >= 1, `应至少重扫一次，实际 ${rescans}`);
    assert.ok(rescans <= 3, `20 个文件不应触发 20 次重扫，实际 ${rescans} 次`);
    // 文件确实被索引（最终一致）
    assert.ok(scanner.getFiles().length >= 20, `索引数 ${scanner.getFiles().length}`);
  } finally {
    scanner.stop();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
