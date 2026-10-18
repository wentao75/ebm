// recommend.ts —— 待下载确认：把「_推荐待确认.md」的勾选搬进界面
//
// 设计（已与用户确认，方案 A：管道脚本零改动）：
//   1. 待确认清单的**唯一来源**仍是 recommend.py 生成的文件（sync 重建、保留手写勾选）
//   2. 界面上的「确认下载 / 不要了」只做两件事：把对应行的方括号字符翻转成 x / -，
//      然后调用 `recommend.py apply` —— 批准→tier1、拒绝→tier3+「用户拒绝」，全部由管道自己的逻辑完成
//   3. 保留原文件的互操作：在 iPhone/Obsidian 上继续手写勾选依然有效
import { execFile, spawn } from "child_process";
import fsp from "fs/promises";
import path from "path";
import { currentJob, release, tryAcquire } from "./jobs";
import { archiveProcessed, archiveStatus, ArchiveStatus } from "./recoArchive";
import { snapshotBeforeReject } from "./recoRestore";

import { REC_FILE as PATHS_REC_FILE, WATCH_DIR } from "./paths";
/** recommend.py 生成的待确认清单（iCloud 根目录，方便手机端勾选） */
export const REC_FILE = PATHS_REC_FILE;
const RECO_SCRIPT = path.join(WATCH_DIR, "recommend.py");
const POST_DETAILS = path.join(WATCH_DIR, "post_details.json");
const PYTHON = "python3";
export const MAX_DECISIONS_PER_RUN = 100;

/** 与管道 recommend.py 完全一致的行正则（改这里务必同步核对） */
export const LINE_RE = /^\s*-\s*\[([ xX\-\u2713\u00d7])\]\s*(\d+)\s+(.*)$/;
const APPROVE_MARKS = new Set(["x", "X", "\u2713"]);
const REJECT_MARKS = new Set(["-", "\u00d7"]);
export const APPROVE_MARK = "x";
export const REJECT_MARK = "-";

export interface PendingItem {
  id: number;
  mark: string;
  label: string;
  /** 条目下的缩进明细（作者·日期、简介） */
  detail: string[];
}

export interface ParsedRecfile {
  pending: PendingItem[];
  processed: string[];
}

export function isApproved(mark: string): boolean {
  return APPROVE_MARKS.has(mark);
}
export function isRejected(mark: string): boolean {
  return REJECT_MARKS.has(mark);
}

/** 解析待确认文件（只认「## 待确认」区里匹配 LINE_RE 的行；表格里的 `[ ]` 不会被误认） */
export function parseRecfile(text: string): ParsedRecfile {
  const pending: PendingItem[] = [];
  const processed: string[] = [];
  let section: "head" | "pending" | "processed" = "head";
  let cur: PendingItem | null = null;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      section = line.includes("已处理") ? "processed" : line.includes("待确认") ? "pending" : "head";
      cur = null;
      continue;
    }
    if (section === "pending") {
      const m = LINE_RE.exec(line);
      if (m) {
        cur = { id: Number(m[2]), mark: m[1], label: m[3].trim(), detail: [] };
        pending.push(cur);
        continue;
      }
      if (cur && /^\s{4,}\S/.test(line)) {
        cur.detail.push(line.trim());
        continue;
      }
      if (!line.trim()) cur = null;
      continue;
    }
    if (section === "processed" && line.trim().startsWith("- ")) processed.push(line);
  }
  return { pending, processed };
}

/** 拆出书名 / 建议归档目录 / 判断理由（格式：`《书名》作者  →  目录　_理由_`） */
export function parseLabel(label: string): { title: string; folder: string; note: string } {
  const text = (label || "").trim();
  const parts = text.split(/\s*→\s*/);
  const title = (parts[0] || "").trim();
  let right = (parts[1] || "").trim();
  let note = "";
  const nm = /[\s\u3000]*_([^_]*)_\s*$/.exec(right);
  if (nm && typeof nm.index === "number") {
    note = nm[1].trim();
    right = right.slice(0, nm.index).trim();
  }
  const folder = right.replace(/[\s\u3000]+$/, "").trim() || "未分类";
  return { title, folder, note };
}

/**
 * 翻转勾选：**只改「## 待确认」区里指定 id 的方括号字符**，其余字节一律不动。
 * 未知 id / 已是目标状态 → 原样返回（幂等）。
 */
export function flipMarks(text: string, d: { approve?: number[]; reject?: number[] }): string {
  const approve = new Set((d.approve || []).map((n) => Number(n)));
  const reject = new Set((d.reject || []).map((n) => Number(n)));
  if (!approve.size && !reject.size) return text;
  const lines = text.split("\n");
  let section: "head" | "pending" | "processed" = "head";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      section = line.includes("已处理") ? "processed" : line.includes("待确认") ? "pending" : "head";
      continue;
    }
    if (section !== "pending") continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const id = Number(m[2]);
    const want = approve.has(id) ? APPROVE_MARK : reject.has(id) ? REJECT_MARK : null;
    if (!want || m[1] === want) continue;
    lines[i] = line.replace(/^(\s*-\s*\[)([^\]])(\])/, (_s, p1: string) => `${p1}${want}]`);
  }
  return lines.join("\n");
}

// ---------- 与管道脚本交互 ----------

/** 串行化对管道脚本的调用：并发 GET → 并发 sync；sync 与 apply 也不能交叉（都写同一个文件） */
let runChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);
  runChain = next.catch(() => undefined);
  return next;
}

function runScript(args: string[], timeoutMs = 90000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [RECO_SCRIPT, ...args], { cwd: WATCH_DIR });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, out: `${out}\n[timeout]` });
    }, timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (s: string) => (out += s));
    child.stderr.on("data", (s: string) => (out += s));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `[spawn error] ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });
}

async function scriptExists(): Promise<boolean> {
  try {
    await fsp.access(RECO_SCRIPT);
    return true;
  } catch {
    return false;
  }
}

/**
 * iCloud「仅云端」占位文件：size>0 但本地块数为 0。
 * 这种文件直接读取会失败（常见 [Errno 11] Resource deadlock avoided）。
 */
export async function isDataless(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.size > 0 && st.blocks === 0;
  } catch {
    return false;
  }
}

/**
 * 触发 iCloud 取回（macOS: `brctl download`）并等待真正落盘。
 * 清单放在 iCloud 便于手机端勾选，但 iCloud 优化存储会把它驱逐成"仅云端" →
 * 应用必须能自愈，否则每次都要人工点一下。
 */
export async function materialize(p: string, timeoutMs = 20000): Promise<boolean> {
  if (!(await isDataless(p))) return true;
  await new Promise<void>((resolve) => {
    execFile("/usr/bin/brctl", ["download", p], { timeout: 10_000 }, () => resolve());
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isDataless(p))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !(await isDataless(p));
}

/** 读取失败时的说明（区分"文件不存在/脚本缺失/iCloud 未下载"） */
export function readFailureHint(o: { exists: boolean; dataless: boolean; scriptAvailable: boolean; file: string }): string {
  if (!o.exists) {
    return o.scriptAvailable ? "清单文件还不存在（可点「刷新」让巡检重建）" : "管道 recommend.py 不可用，且清单文件不存在";
  }
  if (o.dataless) {
    return `清单在 iCloud 中仅为占位、尚未下载到本机，自动取回失败：${o.file}（可在 Finder 右键「立即下载」或「保留已下载的项目」后重试）`;
  }
  return `清单文件读取失败：${o.file}`;
}

async function readText(): Promise<string | null> {
  try {
    return await fsp.readFile(REC_FILE, "utf-8");
  } catch {
    // 最常见的失败原因：被 iCloud 驱逐成"仅云端" → 先取回，再读一次
    if (await materialize(REC_FILE)) {
      try {
        return await fsp.readFile(REC_FILE, "utf-8");
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function writeText(text: string): Promise<void> {
  await fsp.mkdir(path.dirname(REC_FILE), { recursive: true });
  const tmp = `${REC_FILE}.tmp`;
  await fsp.writeFile(tmp, text, "utf-8");
  await fsp.rename(tmp, REC_FILE);
}

/** post_details.json 摘要（按 mtime 缓存）：补豆瓣评分等清单里没有的字段 */
let detailMemo: { mtime: number; data: Record<string, { douban?: string; title?: string; meta?: Record<string, string> }> } = {
  mtime: 0,
  data: {},
};
async function details(): Promise<typeof detailMemo.data> {
  try {
    const st = await fsp.stat(POST_DETAILS);
    if (st.mtimeMs !== detailMemo.mtime) {
      detailMemo = {
        mtime: st.mtimeMs,
        data: JSON.parse(await fsp.readFile(POST_DETAILS, "utf-8")) as typeof detailMemo.data,
      };
    }
  } catch {
    /* 文件不存在则保持空 */
  }
  return detailMemo.data;
}

export interface PendingView {
  id: number;
  mark: "pending" | "approve" | "reject";
  title: string;
  folder: string;
  note: string;
  author: string;
  date: string;
  intro: string;
  douban?: string;
}

/** 豆瓣 "0.0"/空 都表示"抓不到评分"，按无评分处理（与索引器一致） */
export function normalizeDouban(v: unknown): string | undefined {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? String(v).trim() : undefined;
}

export function toView(item: PendingItem, detail?: { douban?: string }): PendingView {
  const { title, folder, note } = parseLabel(item.label);
  // 明细第一行通常是「作者 · 日期」，其余是简介
  let author = "";
  let date = "";
  const detailLines = [...item.detail];
  if (detailLines.length && detailLines[0].includes("·")) {
    const [a, d] = detailLines.shift()!.split("·").map((x) => x.trim());
    author = a || "";
    date = d || "";
  }
  const intro = detailLines.join(" ").slice(0, 400);
  return {
    id: item.id,
    mark: isApproved(item.mark) ? "approve" : isRejected(item.mark) ? "reject" : "pending",
    title,
    folder,
    note,
    author,
    date,
    intro,
    douban: normalizeDouban(detail?.douban),
  };
}

/**
 * 书名归一化（与管道 download_books.py 的 norm_key 同思路，另外去掉扩展名）：
 * 去括注/扩展名/空白与常见标点，小写。用于判断"这本书是不是已经在书库里了"。
 */
export function normTitleKey(s: string): string {
  return String(s || "")
    .replace(/\.[A-Za-z0-9]{1,6}$/, "")
    .replace(/[\[\(（【][^\]\)）】]*[\]\)）】]/g, "")
    .replace(/[\s_\-—–·,，。:：;；!！?？"'“”《》()（）\[\]]/g, "")
    .toLowerCase();
}

/**
 * 队列条目是否已存在于书库（书名归一化后：完全相等，或较短一方 ≥6 字且互相包含）。
 * 返回命中的书库 rel，未命中返回 null。
 */
export function matchInLibrary(title: string, library: Array<{ rel: string; key: string }>): string | null {
  const key = normTitleKey(title);
  if (!key) return null;
  for (const lib of library) {
    if (lib.key === key) return lib.rel;
  }
  // 其次：一方是另一方的前缀/后缀（覆盖"队列书名带作者、文件名不带作者"的情形）
  for (const lib of library) {
    const [shorter, longer] = key.length <= lib.key.length ? [key, lib.key] : [lib.key, key];
    if (shorter.length >= 5 && (longer.startsWith(shorter) || longer.endsWith(shorter))) return lib.rel;
  }
  // 最后：较长一方（≥8 字）包含另一方（书名前后缀与标点差异较大时）
  for (const lib of library) {
    const [shorter, longer] = key.length <= lib.key.length ? [key, lib.key] : [lib.key, key];
    if (shorter.length >= 8 && longer.includes(shorter)) return lib.rel;
  }
  return null;
}

export interface QueuedView {
  id: number;
  title: string;
  folder: string;
  note: string;
  douban?: string;
}

/** 书名：优先 tiers.title，其次详情标题去掉管道标记 */
function cleanTitle(v: { title?: string } | undefined, id: number): string {
  const raw = String(v?.title || "").replace(/【[^】]*】/g, "").trim();
  return raw || `(待补书名 ${id})`;
}

/**
 * 「已确认待下载」= tier1 且尚未下载、未失效的书（用户确认后、次日巡检下载前的队列）。
 * 口径与管道 recommend.py 的 candidates() 一致（tier=1、不在 state.downloads / unavailable）。
 */
export interface QueuedResult {
  /** 真正还在排队（尚未下载）的 */
  items: QueuedView[];
  /** 已经在书库里的（账本没记到，但书确实已入库 —— 手动下载后的情况） */
  inLibrary: QueuedView[];
}

export async function readQueued(
  library: Array<{ rel: string; key: string }> = [],
): Promise<QueuedResult> {
  const [tiersRaw, stateRaw] = await Promise.all([
    fsp.readFile(path.join(WATCH_DIR, "tiers.json"), "utf-8").catch(() => "{}"),
    fsp.readFile(path.join(WATCH_DIR, "state.json"), "utf-8").catch(() => "{}"),
  ]);
  let tiers: Record<string, { tier?: number; folder?: string | null; note?: string; title?: string }> = {};
  let state: { downloads?: Array<{ id?: number }>; unavailable?: number[] } = {};
  try {
    tiers = JSON.parse(tiersRaw) as typeof tiers;
  } catch {
    /* 数据文件异常时按空处理 */
  }
  try {
    state = JSON.parse(stateRaw) as typeof state;
  } catch {
    /* ignore */
  }
  const have = new Set((state.downloads || []).map((d) => Number(d.id)).filter((n) => Number.isFinite(n)));
  const unavail = new Set((state.unavailable || []).map((n) => Number(n)));
  const det = await details();
  const items: QueuedView[] = [];
  const inLibrary: QueuedView[] = [];
  for (const [k, v] of Object.entries(tiers)) {
    if (!v || typeof v !== "object" || v.tier !== 1) continue;
    const id = Number(k);
    if (!Number.isFinite(id) || have.has(id) || unavail.has(id)) continue;
    const d = det[String(id)];
    const view: QueuedView = {
      id,
      title: cleanTitle({ title: v.title || d?.title }, id),
      folder: v.folder || "未分类",
      note: v.note || "",
      douban: normalizeDouban(d?.douban),
    };
    // 账本（state.downloads）只由每日流程记账；手动下载不会写它 →
    // 因此还要看书库：书已在库里，就不该继续显示成"待下载"
    if (library.length && matchInLibrary(view.title, library)) inLibrary.push(view);
    else items.push(view);
  }
  const byIdDesc = (a: QueuedView, b: QueuedView): number => b.id - a.id;
  return { items: items.sort(byIdDesc), inLibrary: inLibrary.sort(byIdDesc) };
}

export interface PendingResult {
  ok: boolean;
  error?: string;
  /** recommend.py 是否可用（不可用时前端只读展示） */
  scriptAvailable: boolean;
  /** 清单文件是否存在 / 是否读得出来（区分"真没有待确认"和"读失败"） */
  fileExists: boolean;
  readable: boolean;
  /** 本次是否执行过管道 sync / sync 是否成功 */
  synced: boolean;
  syncOk: boolean;
  /** 因"有任务在执行中"跳过了刷新（此时展示的可能是上一次的结果） */
  syncSkipped: boolean;
  /** 清单文件体积（字节） */
  fileBytes: number;
  /** 清单是否被 iCloud 驱逐成"仅云端"（取回失败时为 true） */
  fileDataless?: boolean;
  /** 历史归档状态（管道只保留最近 200 条已处理，旧的会被归档到这里） */
  archive: ArchiveStatus;
  file: string;
  items: PendingView[];
  /** 账本没记到、但书已在书库的候选（直接从「推荐浏览」下载而未批准的情形）——不再让用户重复确认 */
  itemsInLibrary: PendingView[];
  processedCount: number;
}

/** 文件缺失章节标记 → 视为不完整（sync 被中途杀掉时可能写坏） */
function looksIncomplete(text: string): boolean {
  // 任何正常清单都至少有一个 `## 待确认`/`## 已处理` 章节标记；空文件（sync 写首行前被杀）也算不完整
  return !/^##\s/m.test(text);
}

/**
 * 读取待确认清单。
 * 默认**纯读取**（GET 不应有副作用）；`syncFirst=true`（界面进入/刷新时）才先让管道 sync 重建清单。
 */
export async function readPending(
  syncFirst = false,
  library: Array<{ rel: string; key: string }> = [],
): Promise<PendingResult> {
  const file = REC_FILE;
  const available = await scriptExists();
  let synced = false;
  let syncOk = !syncFirst; // 没要求同步时视为"无需同步"
  let syncLog = "";
  let syncSkipped = false;
  if (syncFirst && available) {
    // 同步会 spawn 脚本，而它内部的 ensure_details 可能抓详情并重写 post_details.json，
    // 因此必须与下载/元数据任务互斥；锁被占用时**跳过刷新**（只读返回，而不是报错）
    if (tryAcquire("recommend")) {
      try {
        // 关键顺序：先归档**sync 之前**的历史（sync 会只保留最近 200 条）
        const before = await readText();
        if (before) {
          try {
            await archiveProcessed(before);
          } catch (err) {
            console.error("[ebm] 推荐历史归档失败（不影响清单使用）:", err);
          }
        }
        const r = await serialized(() => runScript(["sync"], 150000));
        synced = true;
        syncOk = r.ok;
        syncLog = r.out;
      } finally {
        release();
      }
    } else {
      syncSkipped = true;
    }
  }
  let exists = true;
  try {
    await fsp.access(file);
  } catch {
    exists = false;
  }
  const text = await readText();
  let fileBytes = 0;
  try {
    fileBytes = (await fsp.stat(file)).size;
  } catch {
    /* 文件不存在时保持 0 */
  }
  const archive = await archiveStatus();
  const base = { scriptAvailable: available, file, fileExists: exists, synced, syncOk, syncSkipped, fileBytes, archive };
  if (text === null) {
    return {
      ...base,
      ok: false,
      readable: false,
      items: [],
      itemsInLibrary: [],
      processedCount: 0,
      fileDataless: await isDataless(file),
      error: readFailureHint({ exists, dataless: await isDataless(file), scriptAvailable: available, file }),
    };
  }
  if (looksIncomplete(text)) {
    return {
      ...base,
      ok: false,
      readable: false,
      items: [],
      itemsInLibrary: [],
      processedCount: 0,
      error: "清单文件似乎不完整（缺少章节标记），已按只读展示；请点「刷新」让管道重建",
    };
  }
  const parsed = parseRecfile(text);
  const det = await details();
  return {
    ...base,
    ok: true,
    readable: true,
    ...(() => {
      // 与 T1 队列同口径：管道 candidates() 只看 state.downloads 账本，而手动下载不写账本
      // → 已入库的候选不应继续要求用户确认
      const views = parsed.pending.map((it) => toView(it, det[String(it.id)]));
      const pendingItems: PendingView[] = [];
      const itemsInLibrary: PendingView[] = [];
      for (const v of views) {
        if (library.length && matchInLibrary(v.title, library)) itemsInLibrary.push(v);
        else pendingItems.push(v);
      }
      return { items: pendingItems, itemsInLibrary };
    })(),
    processedCount: parsed.processed.length,
    error: syncSkipped
      ? "有任务在执行中，本次未刷新清单（显示的可能是上一次的结果）"
      : syncOk
        ? undefined
        : `清单未刷新成功：${syncLog.trim().split("\n").slice(-1)[0] || "sync 失败"}`.slice(0, 200),
  };
}

export interface DecideResult {
  ok: boolean;
  error?: string;
  busy?: boolean;
  /** 管道脚本缺失（路由映射 502） */
  scriptMissing?: boolean;
  approved: number[];
  rejected: number[];
  log: string;
  remaining: PendingView[];
}

function cleanIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * 应用决策：翻转清单里的勾选 → 调 `recommend.py apply` → 批准进 T1、拒绝进 T3。
 * 全程持有全局任务锁（与下载/元数据任务互斥），避免并发写 tiers.json。
 */
export async function decide(
  approveRaw: unknown,
  rejectRaw: unknown,
  library: Array<{ rel: string; key: string }> = [],
): Promise<DecideResult> {
  const approve = cleanIds(approveRaw);
  const reject = cleanIds(rejectRaw);
  const empty: DecideResult = { ok: false, approved: [], rejected: [], log: "", remaining: [] };
  if (!approve.length && !reject.length) {
    return { ...empty, error: "没有需要处理的决策" };
  }
  const overlap = approve.filter((id) => reject.includes(id));
  if (overlap.length) return { ...empty, error: `同一本书不能既批准又拒绝：${overlap.join(",")}` };
  if (approve.length + reject.length > MAX_DECISIONS_PER_RUN) {
    return { ...empty, error: `单次最多 ${MAX_DECISIONS_PER_RUN} 本` };
  }
  if (!(await scriptExists())) {
    return { ...empty, scriptMissing: true, error: `未找到管道脚本 ${RECO_SCRIPT}` };
  }
  if (!tryAcquire("recommend")) {
    return { ...empty, busy: true, error: `已有任务在执行中（${currentJob()}），请稍候` };
  }
  try {
    // 1) 先 sync：确保清单与 tiers.json 一致（同时保留手写勾选）；失败即中止，绝不改数据
    const sync = await serialized(() => runScript(["sync"], 150000));
    if (!sync.ok) {
      return { ...empty, error: `清单刷新失败（recommend.py sync 未成功），未改动任何数据：${sync.out.trim().slice(-120)}` };
    }
    const text = await readText();
    if (text === null) return { ...empty, error: `待确认文件不可读：${REC_FILE}` };
    if (looksIncomplete(text)) return { ...empty, error: "清单文件不完整（可能上一次 sync 被中断），已中止本次决策；请点「刷新」后重试" };
    const parsed = parseRecfile(text);
    const known = new Set(parsed.pending.map((p) => p.id));
    const unknown = [...approve, ...reject].filter((id) => !known.has(id));
    if (unknown.length) {
      return { ...empty, error: `这些书已不在待确认清单里（可能已被处理或下载）：${unknown.join(",")}` };
    }
    // 2) 拒绝前先快照（管道 apply 会把 folder 置空并追加"用户拒绝"，不快照就找不回原目录）
    if (reject.length) {
      try {
        const titles: Record<number, string> = {};
        for (const it of parsed.pending) titles[it.id] = parseLabel(it.label).title;
        await snapshotBeforeReject(reject, titles);
      } catch (err) {
        console.error("[ebm] 拒绝快照失败（不影响决策，但之后只能恢复为无目录状态）:", err);
      }
    }
    // 3) 翻转勾选并落盘
    await writeText(flipMarks(text, { approve, reject }));
    // 4) 交给管道自己的 apply（批准→tier1，拒绝→tier3 + 记「用户拒绝」；内部会再 sync 一次）
    const applied = await serialized(() => runScript(["apply"], 150000));
    const after = await readPending(false, library);
    return {
      ok: applied.ok,
      error: applied.ok ? undefined : `recommend.py apply 失败：${applied.out.trim().slice(-200)}`,
      approved: approve,
      rejected: reject,
      log: applied.out.trim(),
      remaining: after.items, // 与列表同口径（已入库的候选不算"待你决定"）
    };
  } catch (err) {
    return { ...empty, error: String(err) };
  } finally {
    release();
  }
}
