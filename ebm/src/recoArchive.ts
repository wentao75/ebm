// recoArchive.ts —— 把「_推荐待确认.md」的已处理历史按月归档到 EBM 自己的数据目录
//
// 为什么需要：管道 recommend.py 的 sync() 重建清单时只保留**最近 200 条**已处理记录
// （`lines += processed[-200:]`），第 201 条起会被静默丢弃。实测文件因此是有界的
// （200 条已处理 ≈17KB + 待确认区，稳态 20~50KB），但**历史会丢**。
//
// 这个模块在每次刷新清单（sync 之前）把当前「已处理」区的条目按**条目自身日期**分月
// 追加到 `data/reco-archive/reco-archive-YYYY-MM.md`：
//   - 主清单始终 ≤200 条已处理 → 文件有界、加载快、手机端也好翻
//   - 历史永不丢失，且仍是 Markdown（随时人工查看，符合原有使用习惯）
//   - 只写 EBM 自己的数据目录，**不碰管道文件**
import fsp from "fs/promises";
import path from "path";

const DATA_DIR = process.env.EBM_DATA_DIR || path.resolve(__dirname, "..", "data");
export const ARCHIVE_DIR = path.join(DATA_DIR, "reco-archive");

/** 已处理条目的标准行：`- [x] 2026-10-12  23408  《书名》…  → 已批` */
const PROC_LINE = /^\s*-\s*\[([ xX\-\u2713\u00d7])\]\s*(\d{4})-(\d{2})-(\d{2})\s+(.*)$/;

/** 取出「## 已处理」区里的条目行（原样，不重排） */
export function extractProcessed(text: string): string[] {
  const idx = text.indexOf("## 已处理");
  if (idx < 0) return [];
  return text
    .slice(idx)
    .split("\n")
    .filter((l) => PROC_LINE.test(l.trim()))
    .map((l) => l.trim());
}

/** 条目所属月份（取自条目内日期）；解析不到归入 unknown */
export function monthOf(line: string): string {
  const m = PROC_LINE.exec(line.trim());
  return m ? `${m[2]}-${m[3]}` : "unknown";
}

interface MonthState {
  mtimeMs: number;
  seen: Set<string>;
}

const monthMemo = new Map<string, MonthState>();

function archivePath(month: string): string {
  return path.join(ARCHIVE_DIR, `reco-archive-${month}.md`);
}

async function loadSeen(month: string): Promise<Set<string>> {
  const file = archivePath(month);
  let mtimeMs = 0;
  try {
    mtimeMs = (await fsp.stat(file)).mtimeMs;
  } catch {
    monthMemo.set(month, { mtimeMs: 0, seen: new Set() });
    return new Set();
  }
  const memo = monthMemo.get(month);
  if (memo && memo.mtimeMs === mtimeMs) return memo.seen;
  const seen = new Set<string>();
  try {
    const text = await fsp.readFile(file, "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (PROC_LINE.test(t)) seen.add(t);
    }
  } catch {
    /* 读不到就按空处理（下次重新归档，append 去重仍靠 seen） */
  }
  monthMemo.set(month, { mtimeMs, seen });
  return seen;
}

export interface ArchiveResult {
  /** 本次新归档的条数 */
  archived: number;
  /** 本次涉及的月份 */
  months: string[];
  /** 该文件里已处理条目总数（未归档前的原始数量） */
  processed: number;
}

/**
 * 把清单里的「已处理」条目归档（按条目日期分月、按行内容去重、只追加）。
 * 幂等：同一批条目重复调用不会重复写入。
 */
export async function archiveProcessed(text: string): Promise<ArchiveResult> {
  const lines = extractProcessed(text);
  if (!lines.length) return { archived: 0, months: [], processed: 0 };
  const byMonth = new Map<string, string[]>();
  for (const line of lines) {
    const m = monthOf(line);
    const arr = byMonth.get(m) || [];
    arr.push(line);
    byMonth.set(m, arr);
  }
  let archived = 0;
  const touched: string[] = [];
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
  for (const [month, arr] of byMonth) {
    const seen = await loadSeen(month);
    const fresh = arr.filter((l) => !seen.has(l));
    if (!fresh.length) continue;
    const file = archivePath(month);
    let exists = true;
    try {
      await fsp.access(file);
    } catch {
      exists = false;
    }
    const head = exists
      ? ""
      : `# 推荐决策归档 · ${month}\n\n_自动归档（主清单「已处理」区超过管道保留上限时，旧记录会追加到这里）_\n\n`;
    await fsp.appendFile(file, `${head}${fresh.join("\n")}\n`, "utf-8");
    for (const l of fresh) seen.add(l);
    const st = await fsp.stat(file);
    monthMemo.set(month, { mtimeMs: st.mtimeMs, seen });
    archived += fresh.length;
    touched.push(month);
  }
  return { archived, months: touched, processed: lines.length };
}

export interface ArchiveStatus {
  /** 已归档的总条数 */
  total: number;
  /** 有归档的月份（升序） */
  months: string[];
  /** 最近一次归档的文件时间 */
  lastAt: number;
  dir: string;
}

/** 归档目录现状（供界面显示"历史已有备份"） */
export async function archiveStatus(): Promise<ArchiveStatus> {
  const out: ArchiveStatus = { total: 0, months: [], lastAt: 0, dir: ARCHIVE_DIR };
  let files: string[] = [];
  try {
    files = (await fsp.readdir(ARCHIVE_DIR)).filter((f) => /^reco-archive-.*\.md$/.test(f));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const month = f.replace(/^reco-archive-/, "").replace(/\.md$/, "");
    try {
      const text = await fsp.readFile(path.join(ARCHIVE_DIR, f), "utf-8");
      const n = text.split("\n").filter((l) => PROC_LINE.test(l.trim())).length;
      out.total += n;
      if (n > 0) out.months.push(month);
      const st = await fsp.stat(path.join(ARCHIVE_DIR, f));
      out.lastAt = Math.max(out.lastAt, st.mtimeMs);
    } catch {
      /* 单个文件读失败不影响整体 */
    }
  }
  return out;
}

// ---------- 归档条目的结构化解析（供界面查看与搜索）----------

export interface ArchiveEntry {
  /** 决策日期 YYYY-MM-DD */
  date: string;
  /** approve=批准下载 / reject=不要了 */
  action: "approve" | "reject";
  id: number;
  title: string;
  folder: string;
  note: string;
  /** 落在哪个月份的归档文件 */
  month: string;
}

/**
 * 解析一条归档行。形如：
 * `- [x] 2026-10-12  23408  《存钱心理学》埃玛·爱德华兹  →  经济&投资　_理由…_  → 已批`
 */
export function parseArchiveLine(line: string, month: string): ArchiveEntry | null {
  const m = PROC_LINE.exec(line.trim());
  if (!m) return null;
  // 只认 [x]（批准）与 [-]（拒绝）；[ ]（未勾选）不是历史记录，不能当成"拒绝"
  const isApprove = /[xX\u2713]/.test(m[1]);
  const isReject = /[-\u00d7]/.test(m[1]);
  if (!isApprove && !isReject) return null;
  const action: "approve" | "reject" = isApprove ? "approve" : "reject";
  const date = `${m[2]}-${m[3]}-${m[4]}`;
  // m[5] = `23408  《书名》…  → 目录　_理由_  → 已批`（PROC_LINE 的第 5 个捕获组）
  const idMatch = /^(\d+)\s+(.*)$/.exec((m[5] || "").trim());
  if (!idMatch) return null;
  const id = Number(idMatch[1]);
  let label = idMatch[2];
  // 去掉结尾的动作说明（`→ 已批` / `→ 已拒绝`）
  label = label.replace(/\s*→\s*(已批|已批准下载|已拒绝)\s*$/, "").trim();
  const parts = label.split(/\s*→\s*/);
  const title = (parts[0] || "").trim();
  let right = (parts[1] || "").trim();
  let note = "";
  const nm = /[\s\u3000]*_([^_]*)_\s*$/.exec(right);
  if (nm && typeof nm.index === "number") {
    note = nm[1].trim();
    right = right.slice(0, nm.index).trim();
  }
  const folder = right.replace(/[\s\u3000]+$/, "").trim();
  return { date, action, id, title, folder, note, month };
}

export interface ArchiveQuery {
  month?: string;
  q?: string;
  limit?: number;
}

export interface ArchiveQueryResult {
  months: Array<{ month: string; count: number }>;
  items: ArchiveEntry[];
  total: number;
  matched: number;
  truncated: boolean;
}

/** 按月份/关键词查询归档（只读；月份 = "all" 或 YYYY-MM） */
export async function queryArchive(opts: ArchiveQuery = {}): Promise<ArchiveQueryResult> {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
  const month = (opts.month || "all").trim();
  const q = (opts.q || "").trim().toLowerCase();
  let files: string[] = [];
  try {
    files = (await fsp.readdir(ARCHIVE_DIR)).filter((f) => /^reco-archive-.*\.md$/.test(f)).sort();
  } catch {
    return { months: [], items: [], total: 0, matched: 0, truncated: false };
  }
  const months: Array<{ month: string; count: number }> = [];
  const all: ArchiveEntry[] = [];
  for (const f of files) {
    const m = f.replace(/^reco-archive-/, "").replace(/\.md$/, "");
    let text = "";
    try {
      text = await fsp.readFile(path.join(ARCHIVE_DIR, f), "utf-8");
    } catch {
      continue;
    }
    const entries: ArchiveEntry[] = [];
    for (const line of text.split("\n")) {
      const e = parseArchiveLine(line, m);
      if (e) entries.push(e);
    }
    if (entries.length) months.push({ month: m, count: entries.length });
    if (month === "all" || month === m) all.push(...entries);
  }
  // 新的在前
  all.sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
  const filtered = q
    ? all.filter((e) =>
        `${e.title} ${e.folder} ${e.note} ${e.id}`.toLowerCase().includes(q))
    : all;
  return {
    months,
    items: filtered.slice(0, limit),
    total: all.length,
    matched: filtered.length,
    truncated: filtered.length > limit,
  };
}
