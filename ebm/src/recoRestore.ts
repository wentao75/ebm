// recoRestore.ts —— 「恢复为待定」：把误拒绝的书从 tier3 还原回 tier2
//
// ⚠ 这是 EBM 唯一的**写管道数据**（tiers.json）的地方（用户 2026-10-12 明确同意该权衡）。
// 安全设计：
//   1. 拒绝时先快照原记录（tier/folder/note）到 EBM 自己的 data/reco-restore.json —— 因为
//      管道 apply() 拒绝时会把 folder 置空并追加 " | 用户拒绝"，不快照就找不回原目录
//   2. 只改指定 id 的 tier/folder/note 三个字段，其余字段与其它条目原样保留
//   3. **原子写**（tmp + rename）并留时间戳备份（data/tiers-backup/，保留最近 5 份）
//   4. 与推荐脚本 / 下载管道共用全局互斥锁，杜绝并发写
import fsp from "fs/promises";
import path from "path";
import { currentJob, release, tryAcquire } from "./jobs";

import { WATCH_DIR } from "./paths";
const DATA_DIR = process.env.EBM_DATA_DIR || path.resolve(__dirname, "..", "data");
const TIERS_FILE = path.join(WATCH_DIR, "tiers.json");
const STORE_FILE = path.join(DATA_DIR, "reco-restore.json");
const BACKUP_DIR = path.join(DATA_DIR, "tiers-backup");
const BACKUP_KEEP = 5;

export interface TiersRecord {
  tier?: number;
  folder?: string | null;
  note?: string;
  [k: string]: unknown;
}

export interface RestoreSnapshot {
  tier: number;
  folder: string | null;
  note: string;
  /** 快照时间 */
  at: number;
  title?: string;
}

interface StoreFile {
  version: number;
  updated: number;
  items: Record<string, RestoreSnapshot>;
  history: Array<{ id: number; action: "snapshot" | "restore"; at: number; detail?: string }>;
}

/** 去掉管道拒绝时追加的 " | 用户拒绝"（以及可能的裸 "用户拒绝"） */
export function stripRejectNote(note: unknown): string {
  return String(note ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s && s !== "用户拒绝")
    .join(" | ");
}

/** 是否被判为"不要了"（tier3 或 备注里有拒绝标记） */
export function isRejected(v: TiersRecord | undefined): boolean {
  if (!v || typeof v !== "object") return false;
  if (Number(v.tier) === 3) return true;
  const note = String(v.note ?? "");
  return note.includes("用户拒绝") || note.includes("已拒绝");
}

let store: StoreFile = { version: 1, updated: 0, items: {}, history: [] };
let loaded = false;

async function loadStore(): Promise<StoreFile> {
  if (loaded) return store;
  try {
    const d = JSON.parse(await fsp.readFile(STORE_FILE, "utf-8")) as StoreFile;
    store = {
      version: 1,
      updated: Number(d.updated) || 0,
      items: d.items && typeof d.items === "object" ? d.items : {},
      history: Array.isArray(d.history) ? d.history.slice(-500) : [],
    };
  } catch {
    store = { version: 1, updated: 0, items: {}, history: [] };
  }
  loaded = true;
  return store;
}

async function flushStore(): Promise<void> {
  store.updated = Date.now();
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 1), "utf-8");
  await fsp.rename(tmp, STORE_FILE);
}

async function readTiers(): Promise<Record<string, TiersRecord>> {
  try {
    return JSON.parse(await fsp.readFile(TIERS_FILE, "utf-8")) as Record<string, TiersRecord>;
  } catch {
    return {};
  }
}

async function backupTiers(): Promise<string> {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const dst = path.join(BACKUP_DIR, `tiers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fsp.copyFile(TIERS_FILE, dst);
  const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.startsWith("tiers-")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
    await fsp.rm(path.join(BACKUP_DIR, old), { force: true });
  }
  return dst;
}

async function writeTiers(tiers: Record<string, TiersRecord>): Promise<void> {
  const tmp = `${TIERS_FILE}.ebm-tmp`;
  await fsp.writeFile(tmp, JSON.stringify(tiers, null, 1), "utf-8");
  await fsp.rename(tmp, TIERS_FILE);
}

/**
 * 拒绝前快照：记录这些 id 当前的 tier/folder/note（供以后"恢复为待定"精确还原）。
 * 在调用管道 `recommend.py apply` **之前**调用。
 */
export async function snapshotBeforeReject(
  ids: number[],
  titles: Record<number, string> = {},
): Promise<number> {
  if (!ids.length) return 0;
  const s = await loadStore();
  const tiers = await readTiers();
  let n = 0;
  for (const id of ids) {
    const rec = tiers[String(id)];
    if (!rec || typeof rec !== "object") continue;
    s.items[String(id)] = {
      tier: Number(rec.tier) || 2,
      folder: (rec.folder as string | null) ?? null,
      note: String(rec.note ?? ""),
      at: Date.now(),
      title: titles[id],
    };
    s.history.push({ id, action: "snapshot", at: Date.now(), detail: `folder=${rec.folder ?? "-"}` });
    n += 1;
  }
  await flushStore();
  return n;
}

export interface RestoreResult {
  ok: boolean;
  error?: string;
  busy?: boolean;
  restored: Array<{ id: number; folder: string | null; note: string; fromSnapshot: boolean }>;
  skipped: Array<{ id: number; reason: string }>;
  backup: string | null;
}

/**
 * 把被拒绝的书恢复为「待定」（tier=2）。
 * 优先用拒绝前的快照还原 folder/note；没有快照（例如在界面外拒绝的）则只清掉拒绝标记。
 */
export async function restoreRejected(idsRaw: unknown): Promise<RestoreResult> {
  const ids = [...new Set((Array.isArray(idsRaw) ? idsRaw : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  const empty: RestoreResult = { ok: false, restored: [], skipped: [], backup: null };
  if (!ids.length) return { ...empty, error: "没有指定要恢复的书" };
  if (ids.length > 50) return { ...empty, error: "单次最多恢复 50 本" };
  if (!tryAcquire("recommend")) {
    return { ...empty, busy: true, error: `已有任务在执行中（${currentJob()}），请稍候` };
  }
  try {
    const s = await loadStore();
    const tiers = await readTiers();
    const restored: RestoreResult["restored"] = [];
    const skipped: RestoreResult["skipped"] = [];
    for (const id of ids) {
      const rec = tiers[String(id)];
      if (!rec || typeof rec !== "object") {
        skipped.push({ id, reason: "tiers.json 里没有这条记录" });
        continue;
      }
      if (!isRejected(rec)) {
        skipped.push({ id, reason: `当前不是「不要了」状态（tier=${rec.tier ?? "-"}）` });
        continue;
      }
      const snap = s.items[String(id)];
      const prevNote = String(rec.note ?? "");
      rec.tier = 2;
      if (rec.folder === null || rec.folder === undefined || rec.folder === "") {
        rec.folder = snap?.folder ?? rec.folder ?? null;
      }
      rec.note = stripRejectNote(snap?.note ?? prevNote);
      tiers[String(id)] = rec;
      restored.push({ id, folder: (rec.folder as string | null) ?? null, note: String(rec.note), fromSnapshot: !!snap });
      s.history.push({ id, action: "restore", at: Date.now(), detail: snap ? "按快照还原" : "无快照，仅清除拒绝标记" });
      delete s.items[String(id)];
    }
    if (!restored.length) {
      return { ...empty, error: `没有可恢复的条目：${skipped.map((x) => `${x.id}（${x.reason}）`).join("；")}`, skipped };
    }
    const backup = await backupTiers();
    await writeTiers(tiers);
    await flushStore();
    return { ok: true, restored, skipped, backup };
  } catch (err) {
    return { ...empty, error: `恢复失败：${String(err)}` };
  } finally {
    release();
  }
}

export interface RestoreStatus {
  /** 有快照（可精确还原目录/理由）的条数 */
  snapshots: number;
  history: Array<{ id: number; action: "snapshot" | "restore"; at: number; detail?: string }>;
  backupDir: string;
}

export async function restoreStatus(): Promise<RestoreStatus> {
  const s = await loadStore();
  return { snapshots: Object.keys(s.items).length, history: s.history.slice(-20), backupDir: BACKUP_DIR };
}
