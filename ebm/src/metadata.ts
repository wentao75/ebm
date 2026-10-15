// metadata.ts —— 书目元数据补全：状态查询 + 触发管道侧的三个脚本
// 契约与调用方式见 docs/metadata-enrichment.md（管道侧脚本已就绪，本模块不改它们）
//   meta_build.py    登记（L1 雅书详情页匹配，~27 秒，纯本地）
//   meta_enrich.py   补简介（L2 豆瓣 → L3 OpenLibrary → L3b Google Books → L4 arXiv，~5 本/分钟）
//   meta_catalog.py  重建索引（书库索引.md + library.html，< 1 秒）
import { execFile, spawn } from "child_process";
import fsp from "fs/promises";
import path from "path";
import { currentJob, release, tryAcquire } from "./jobs";
import { LIBRARY_ROOT } from "./scanner";

import { WATCH_DIR } from "./paths";
export const BOOK_META_PATH = path.join(WATCH_DIR, "book_meta.json");
const META_CACHE_PATH = path.join(WATCH_DIR, "meta_cache.json");

const PYTHON = "python3";
export const MAX_ENRICH_LIMIT = 200;

type TaskName = "build" | "enrich" | "catalog";

const TASKS: Record<TaskName, { script: string; args: (limit: number) => string[]; label: string }> = {
  build: { script: "meta_build.py", args: () => [], label: "登记书目元数据" },
  enrich: { script: "meta_enrich.py", args: (limit) => ["--source", "all", "--limit", String(limit)], label: "外部源补简介" },
  catalog: { script: "meta_catalog.py", args: () => [], label: "重建书库索引" },
};

export function isTaskName(v: unknown): v is TaskName {
  return v === "build" || v === "enrich" || v === "catalog";
}

export interface MetadataStatus {
  running: boolean;
  /** 外部（非本应用启动）的管道元数据进程正在跑：此时禁止再触发，避免两个 enrich 互相覆盖 book_meta.json */
  externalMeta: boolean;
  runningJob: string | null;
  total: number;
  withIntro: number;
  missing: number;
  bySource: Record<string, number>;
  partial: number;
  failed: number;
  needsReview: number;
  lastRunAt: string | null;
  generatedAt: string | null;
  metaMtime: number;
  catalog: { mdAt: number; htmlAt: number };
  /** 书库里有、但 book_meta.json 里还没有的书（用于"检测到新书"提示） */
  missingRels: string[];
}

interface BookMetaFile {
  generated_at?: string;
  counts?: Record<string, number>;
  enrich?: { ok?: number; fail?: number; at?: string };
  books?: Record<string, Record<string, unknown>>;
}

/** 读取 book_meta.json（不存在/损坏都按空处理，不影响服务） */
export async function readBookMeta(): Promise<BookMetaFile> {
  try {
    return JSON.parse(await fsp.readFile(BOOK_META_PATH, "utf-8")) as BookMetaFile;
  } catch {
    return { books: {} };
  }
}

/**
 * 从 `ps -Ao command` 的输出里判断是否存在**真实运行**的元数据脚本进程。
 *
 * 为什么不用 `pgrep -f`：它会匹配任何"命令行里提到该脚本名"的进程——包括 shell 包装进程、
 * grep/tail 管道、以及调试命令自身，实测造成过误报（把"补简介"按钮一直挡住）。
 * 这里要求该行**以 python 解释器开头**，才算是脚本真的在跑（纯函数，便于单测）。
 */
export function detectMetaProcess(psOutput: string): boolean {
  return psOutput
    .split("\n")
    .some((line) => /^[^\s]*[Pp]ython\S*\s+.*meta_(enrich|build)\.py/.test(line));
}

/**
 * 检测外部元数据进程（每日巡检或另一位会话手动启动的 meta_build/meta_enrich）。
 * docs/metadata-enrichment.md 明确警告：两个 enrich 并发会互相覆盖 book_meta.json。
 */
export function externalMetaRunning(): Promise<boolean> {
  // 测试环境（helper 会设 EBM_EXTERNAL_TASK_GUARD=0）关闭该护栏，避免依赖宿主机进程表
  if (process.env.EBM_EXTERNAL_TASK_GUARD === "0") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-Ao", "command"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && detectMetaProcess(String(stdout)));
    });
  });
}

async function mtimeOf(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

/** 汇总覆盖率与任务状态，供前端面板显示 */
export async function status(currentRels: string[]): Promise<MetadataStatus> {
  const meta = await readBookMeta();
  const books = meta.books || {};
  const rels = Object.keys(books);
  const bySource: Record<string, number> = {};
  let withIntro = 0;
  let partial = 0;
  let failed = 0;
  let needsReview = 0;
  const known = new Set(rels);
  for (const entry of Object.values(books)) {
    const src = Object.keys((entry.sources as Record<string, unknown>) || {})[0];
    if (src) bySource[src] = (bySource[src] || 0) + 1;
    if (entry.intro) withIntro += 1;
    if (entry.enrich_partial) partial += 1;
    if (entry.enrich_failed) failed += 1;
    if (entry.needs_review) needsReview += 1;
  }
  // 只统计书库里真实存在、但元数据文件里没有的书（压缩包等非书文件不算）
  const missingRels = currentRels.filter((r) => !known.has(r));
  const external = (await externalMetaRunning()) && currentJob() === null;
  return {
    running: currentJob() !== null,
    externalMeta: external,
    runningJob: currentJob(),
    total: rels.length,
    withIntro,
    missing: rels.length - withIntro,
    bySource,
    partial,
    failed,
    needsReview,
    lastRunAt: meta.enrich?.at || null,
    generatedAt: meta.generated_at || null,
    metaMtime: await mtimeOf(BOOK_META_PATH),
    catalog: {
      mdAt: await mtimeOf(path.join(LIBRARY_ROOT, "书库索引.md")),
      htmlAt: await mtimeOf(path.join(LIBRARY_ROOT, "library.html")),
    },
    missingRels,
  };
}

// ---------- 待补清单（哪些书缺信息、为什么缺）----------

export type GapReason = "near_miss" | "low_score" | "no_candidate" | "partial" | "throttled" | "no_entry" | "other";

export interface Gap {
  rel: string;
  title: string;
  author: string;
  reason: GapReason;
  /** 豆瓣最佳候选分数（near_miss/low_score 时有值） */
  score: number | null;
  /** 豆瓣返回的候选标题（用于人工判断是不是同一本书） */
  candidates: string[];
  note: string;
  /** 是否已有人工覆盖 */
  overridden: boolean;
}

let cacheMemo: { mtime: number; data: Record<string, { ok?: boolean; note?: string }> } = { mtime: 0, data: {} };

async function readMetaCache(): Promise<Record<string, { ok?: boolean; note?: string }>> {
  try {
    const st = await fsp.stat(META_CACHE_PATH);
    if (st.mtimeMs === cacheMemo.mtime) return cacheMemo.data;
    const data = JSON.parse(await fsp.readFile(META_CACHE_PATH, "utf-8")) as Record<string, { ok?: boolean; note?: string }>;
    cacheMemo = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return {};
  }
}

/** 从缓存说明里解析失败原因（说明文本由管道 meta_enrich.py 生成） */
export function classifyNote(note: string): { reason: GapReason; score: number | null; candidates: string[] } {
  const m = /候选不匹配\((\d+)分:\s*([^)]*)\)/.exec(note || "");
  if (m) {
    const score = Number(m[1]);
    const candidates = m[2].split("、").map((x) => x.trim()).filter(Boolean);
    return { reason: score >= 70 ? "near_miss" : "low_score", score, candidates };
  }
  if ((note || "").includes("无搜索结果")) return { reason: "no_candidate", score: null, candidates: [] };
  if ((note || "").includes("限流")) return { reason: "throttled", score: null, candidates: [] };
  return { reason: "other", score: null, candidates: [] };
}

/** 汇总待补清单：只列书库里真实存在、且当前没有简介的书 */
export async function gaps(currentRels: string[], overriddenRels: Set<string>): Promise<Gap[]> {
  const meta = await readBookMeta();
  const books = meta.books || {};
  const cache = await readMetaCache();
  const out: Gap[] = [];
  for (const rel of currentRels) {
    const entry = books[rel] as Record<string, unknown> | undefined;
    if (entry?.intro) continue; // 已有简介，不需要补
    const base = path.basename(rel).replace(/\.[^.]+$/, "");
    const title = (typeof entry?.title === "string" && entry.title) || base;
    const author = (typeof entry?.author === "string" && entry.author) || "";
    if (overriddenRels.has(rel)) continue; // 已被人工覆盖，等索引刷新即可
    if (!entry) {
      out.push({ rel, title, author, reason: "no_entry", score: null, candidates: [], note: "尚未登记进书目元数据", overridden: false });
      continue;
    }
    if (entry.enrich_partial) {
      out.push({ rel, title, author, reason: "partial", score: null, candidates: [], note: "只补到作者/年份，各源都没有摘要", overridden: false });
      continue;
    }
    // 按缓存键（层:书名|作者|arxivID）取说明；键不匹配则退回按标题前缀扫描
    let note = String(cache[`douban:${title}|${author}|`]?.note || "");
    if (!note) {
      const prefix = "douban:";
      const needle = title.slice(0, 8);
      for (const [k, v] of Object.entries(cache)) {
        if (k.startsWith(prefix) && needle && k.includes(needle)) {
          note = String(v?.note || "");
          break;
        }
      }
    }
    const { reason, score, candidates } = classifyNote(note);
    out.push({ rel, title, author, reason, score, candidates, note: note || "（无缓存记录）", overridden: false });
  }
  const order: Record<GapReason, number> = { near_miss: 0, no_candidate: 1, low_score: 2, partial: 3, throttled: 4, no_entry: 5, other: 6 };
  out.sort((a, b) => order[a.reason] - order[b.reason] || (b.score || 0) - (a.score || 0) || a.title.localeCompare(b.title, "zh-Hans-CN"));
  return out;
}

// ---------- 豆瓣候选查询 / 采纳（复用管道自己的匹配逻辑，不修改其文件）----------

function runPython(code: string, args: string[], timeoutMs = 90000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ["-c", code, ...args], { cwd: WATCH_DIR });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, out: out + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", (d: string) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `[spawn error] ${err.message}` });
    });
    child.on("close", (code2) => {
      clearTimeout(timer);
      resolve({ ok: code2 === 0, out });
    });
  });
}

/** 让管道用它的候选队列 + 打分，返回最佳候选（供人工确认是否同一本书） */
const CANDIDATES_PY = `
import json, sys
import meta_enrich as ME
title, author = sys.argv[1], sys.argv[2]
cands = []
for q in ME.search_queries(title):
    try:
        cands += ME.douban_search(q) or []
    except Exception:
        pass
    if len(cands) >= 8:
        break
best, score, auth = ME.douban_pick(cands, title, author)
print(json.dumps({"best": best, "score": score, "auth": bool(auth),
                  "top": [{"id": c.get("id"), "title": c.get("title"), "author": c.get("author"), "year": c.get("year")} for c in cands[:6]]},
                 ensure_ascii=False))
`;

export interface DoubanCandidate {
  id: string;
  title: string;
  author?: string;
  year?: string;
}

export async function doubanCandidates(title: string, author: string): Promise<{
  ok: boolean;
  best: DoubanCandidate | null;
  score: number;
  auth: boolean;
  top: DoubanCandidate[];
  log: string;
}> {
  const r = await runPython(CANDIDATES_PY, [title, author]);
  if (!r.ok) return { ok: false, best: null, score: 0, auth: false, top: [], log: r.out.slice(-400) };
  try {
    const data = JSON.parse(r.out.trim().split("\n").pop() || "{}");
    return { ok: true, best: data.best || null, score: Number(data.score) || 0, auth: !!data.auth, top: data.top || [], log: "" };
  } catch (err) {
    return { ok: false, best: null, score: 0, auth: false, top: [], log: `解析失败: ${String(err)}` };
  }
}

// ---------- 雅书（L1）候选与采纳：本地匹配，零网络 ----------

/** 用管道自己的打分函数在 post_details.json 里找雅书候选（含"够分却没配上"的书） */
const YABOOK_CAND_PY = `
import json, sys
sys.path.insert(0, ".")
import book_meta as BM
title = sys.argv[1]
pd = json.load(open("post_details.json"))
det = list(pd.values()) if isinstance(pd, dict) else pd
nt = BM.normalize(title)
out = []
for d in det:
    meta = d.get("meta") or {}
    t = meta.get("书名") or d.get("title") or ""
    s = max(BM.score_match(nt, BM.normalize(t)), BM.score_match(nt, BM.normalize(d.get("title") or "")))
    if s >= 55:
        out.append({"id": d.get("id"), "title": t, "score": s,
                    "author": meta.get("作者") or d.get("author") or "",
                    "introLen": len(d.get("intro") or ""), "hasToc": bool(d.get("toc")),
                    "tags": (d.get("tags") or [])[:5]})
out.sort(key=lambda x: -x["score"])
print(json.dumps(out[:6], ensure_ascii=False))
`;

export interface YabookCandidate {
  id: number;
  title: string;
  /** 标题相似分；来自本地 id 映射时为 null（下载时记录的权威 id，不是靠相似度猜的） */
  score: number | null;
  author?: string;
  introLen: number;
  hasToc: boolean;
  tags?: string[];
  /** 详情是否已在 post_details.json 缓存（否则采纳时现场抓取，约 2~5 秒） */
  cached: boolean;
  /** 候选来源：score=标题相似度 / map=本地 id 映射 */
  from: "score" | "map";
}

const POST_DETAILS_PATH = path.join(WATCH_DIR, "post_details.json");
const FETCH_DETAILS_SCRIPT = path.join(WATCH_DIR, "fetch_details.py");

/** 本地"文件名 → 雅书帖 id"映射（下载时记录的权威 id，比相似度匹配可靠） */
const YABOOK_MAP_PY = `
import json, os, re, sys
target = sys.argv[1]
base = os.path.splitext(os.path.basename(target))[0]
def norm(s):
    # 去掉成对括号内的标记（【文字版_PDF电子书_雅书】等），只留中英文数字做比较
    s = s or ""
    for a, b in (("【", "】"), ("[", "]"), ("（", "）"), ("(", ")")):
        i, j = s.find(a), s.find(b)
        if i >= 0 and j > i:
            s = s[:i] + s[j + 1:]
    s = re.sub(r"\\.[A-Za-z0-9]{2,5}$", "", s)
    return "".join(ch for ch in s.lower() if ch.isalnum() or "\\u4e00" <= ch <= "\\u9fff")
nb = norm(base)
out = []
def push(i, f):
    if i: out.append({"id": int(i), "file": f or ""})
try:
    for x in json.load(open("uncat_match.json")):
        if norm(x.get("file", "")) == nb: push(x.get("id"), x.get("file"))
except Exception: pass
try:
    for d in (json.load(open("state.json")).get("downloads") or []):
        if norm(d.get("file", "")) == nb: push(d.get("id"), d.get("file"))
except Exception: pass
seen, uniq = set(), []
for x in out:
    if x["id"] in seen: continue
    seen.add(x["id"]); uniq.append(x)
print(json.dumps(uniq[:5], ensure_ascii=False))
`;

/** post_details.json 的摘要（按 mtime 缓存）：已缓存的 id、简介字数、是否有目录 */
let yabookMemo: { mtime: number; ids: Set<number>; introLen: Map<number, number>; hasToc: Set<number> } = {
  mtime: 0, ids: new Set(), introLen: new Map(), hasToc: new Set(),
};

async function loadYabookMemo(force = false): Promise<typeof yabookMemo> {
  try {
    const st = await fsp.stat(POST_DETAILS_PATH);
    if (!force && st.mtimeMs === yabookMemo.mtime) return yabookMemo;
    const data = JSON.parse(await fsp.readFile(POST_DETAILS_PATH, "utf-8")) as Record<string, Record<string, unknown>>;
    const ids = new Set<number>();
    const introLen = new Map<number, number>();
    const hasToc = new Set<number>();
    for (const [k, v] of Object.entries(data)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      ids.add(id);
      introLen.set(id, String(v.intro || "").length);
      if (v.toc) hasToc.add(id);
    }
    yabookMemo = { mtime: st.mtimeMs, ids, introLen, hasToc };
  } catch {
    /* 文件不存在则保持空 */
  }
  return yabookMemo;
}

/**
 * 雅书（L1）候选：① 标题相似度命中 post_details.json ② 本地 id 映射（下载记录）
 * 两者互补——②能覆盖"书确实来自雅书、但详情从未缓存"的情况（用户实际遇到的场景）。
 */
export async function yabookCandidates(
  title: string,
  rel: string,
): Promise<{ ok: boolean; items: YabookCandidate[] }> {
  const [byScore, byMap, memo] = await Promise.all([
    runPython(YABOOK_CAND_PY, [title]),
    runPython(YABOOK_MAP_PY, [rel]),
    loadYabookMemo(),
  ]);
  let items: YabookCandidate[] = [];
  if (byScore.ok) {
    try {
      const arr = JSON.parse(byScore.out.trim().split("\n").pop() || "[]") as Array<Partial<YabookCandidate>>;
      items = (Array.isArray(arr) ? arr : []).map((x) => ({
        id: Number(x.id), title: String(x.title || ""), score: x.score ?? null,
        author: x.author || "", introLen: Number(x.introLen) || 0, hasToc: !!x.hasToc,
        tags: x.tags || [], cached: true, from: "score" as const,
      }));
    } catch {
      /* ignore */
    }
  }
  if (byMap.ok) {
    try {
      const arr = JSON.parse(byMap.out.trim().split("\n").pop() || "[]") as Array<{ id: number; file: string }>;
      for (const m of Array.isArray(arr) ? arr : []) {
        if (items.some((x) => x.id === Number(m.id))) continue;
        items.push({
          id: Number(m.id), title: String(m.file || ""), score: null, author: "",
          introLen: 0, hasToc: false, cached: false, from: "map",
        });
      }
    } catch {
      /* ignore */
    }
  }
  if (!byScore.ok && !byMap.ok) return { ok: false, items: [] };
  // 用缓存实况校正：已缓存的补简介字数/目录标记，未缓存的标 cached=false（采纳时现场抓取）
  items = items.map((x) => ({
    ...x,
    cached: memo.ids.has(x.id),
    introLen: memo.introLen.get(x.id) ?? x.introLen,
    hasToc: memo.hasToc.has(x.id) || x.hasToc,
  }));
  return { ok: true, items: items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) };
}

/** 串行化现场抓取，避免并发写坏 post_details.json */
let fetchChain: Promise<void> = Promise.resolve();

/**
 * 确保雅书帖详情已缓存：未缓存时现场抓取（用管道自带 fetch_details.py <id>，
 * 与其缓存读改写逻辑保持一致，抓到的详情还会成为 L1 层的长期资产）。
 */
export async function ensureYabookDetail(id: string): Promise<Record<string, unknown> | null> {
  if (!/^[0-9]{1,10}$/.test(id)) return null;
  const cached = await yabookSubject(id);
  if (cached) return cached;
  try {
    await fsp.access(FETCH_DETAILS_SCRIPT);
  } catch {
    return null;
  }
  fetchChain = fetchChain.then(
    () =>
      new Promise<void>((done) => {
        const child = spawn(PYTHON, [FETCH_DETAILS_SCRIPT, id], { cwd: WATCH_DIR });
        let out = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
        const finish = () => {
          clearTimeout(timer);
          const last = out.trim().split("\n").slice(-1)[0];
          if (last) console.log(`[ebm] fetch_details.py ${id}: ${last.slice(0, 120)}`);
          done();
        };
        child.stdout.on("data", (d) => (out += String(d)));
        child.stderr.on("data", (d) => (out += String(d)));
        child.on("close", finish);
        child.on("error", finish);
      }),
  );
  await fetchChain;
  await loadYabookMemo(true); // 缓存已更新，强制重读
  return yabookSubject(id);
}

/** 按雅书帖 id 取缓存的详情，并映射为覆盖字段（简介/目录/标签/出版社/年份/页数/译者等） */
const YABOOK_DETAIL_PY = `
import json, sys
pd = json.load(open("post_details.json"))
if isinstance(pd, list):
    det = {str(d.get("id")): d for d in pd}
else:
    det = {str(k): v for k, v in pd.items()}
d = det.get(sys.argv[1])
if not d:
    print("{}")
else:
    meta = d.get("meta") or {}
    a = (meta.get("作者") or d.get("author") or "").strip()
    # 管道解析偶尔把"作者简介"整段塞进 author（实测 345 字），按长度分流
    bio = meta.get("作者简介") or (a if len(a) > 40 else "")
    author = "" if len(a) > 40 else a
    print(json.dumps({
        "title": meta.get("书名") or d.get("title") or "",
        "author": author,
        "author_bio": bio,
        "intro": d.get("intro") or "",
        "toc": d.get("toc") or "",
        "tags": d.get("tags") or [],
        "publisher": meta.get("出版社") or "",
        "year": meta.get("出版日期") or "",
        "pages": str(meta.get("页数") or ""),
        "translator": meta.get("译者") or "",
        "douban": d.get("douban") or "",
    }, ensure_ascii=False))
`;

export async function yabookSubject(id: string): Promise<Record<string, unknown> | null> {
  if (!/^[0-9]{1,10}$/.test(id)) return null;
  const r = await runPython(YABOOK_DETAIL_PY, [id]);
  if (!r.ok) return null;
  try {
    const rec = JSON.parse(r.out.trim().split("\n").pop() || "{}") as Record<string, unknown>;
    return Object.keys(rec).length ? rec : null;
  } catch {
    return null;
  }
}

/** 按豆瓣条目 id 取详情（管道已调好限速与解析） */
const SUBJECT_PY = `
import json, sys
import meta_enrich as ME
print(json.dumps(ME.douban_subject(sys.argv[1]) or {}, ensure_ascii=False))
`;

export async function doubanSubject(id: string): Promise<Record<string, unknown> | null> {
  if (!/^[0-9]{4,12}$/.test(id)) return null;
  const r = await runPython(SUBJECT_PY, [id]);
  if (!r.ok) return null;
  try {
    const rec = JSON.parse(r.out.trim().split("\n").pop() || "{}") as Record<string, unknown>;
    return Object.keys(rec).length ? rec : null;
  } catch {
    return null;
  }
}

function runScript(
  script: string,
  args: string[],
  onChunk: (s: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const abs = path.join(WATCH_DIR, script);
    const child = spawn(PYTHON, [abs, ...args], { cwd: WATCH_DIR });
    onChunk(`$ python3 ${script}${args.length ? " " + args.join(" ") : ""}\n`);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => onChunk(d));
    child.stderr.on("data", (d: string) => onChunk(d));
    child.on("close", (code) => {
      onChunk(`\n[exit ${code ?? "null"}] ${script}\n`);
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      onChunk(`[spawn error] ${err.message}\n`);
      resolve(1);
    });
  });
}

export interface MetadataRunResult {
  ok: boolean;
  log: string;
}

/**
 * 串行执行元数据任务（共享互斥锁，与下载管道互斥）。
 * 一次请求内多个任务顺序执行；任一任务失败仍继续后面的（先 diff 日志再决定）。
 */
export async function runMetadata(
  tasks: TaskName[],
  limit: number,
  onChunk: (s: string) => void,
): Promise<MetadataRunResult> {
  const name = `metadata:${tasks.join("+")}`;
  if (!tryAcquire(name)) {
    return { ok: false, log: `已有任务在执行中（${currentJob()}），请稍候` };
  }
  const lim = Math.min(MAX_ENRICH_LIMIT, Math.max(1, Math.floor(limit) || 80));
  let log = "";
  const collect = (s: string) => {
    log += s;
    onChunk(s);
  };
  try {
    // 脚本存在性预检（管道未就位时给出明确错误）
    for (const t of tasks) {
      try {
        await fsp.access(path.join(WATCH_DIR, TASKS[t].script));
      } catch {
        collect(`[error] 未找到 ${TASKS[t].script}（${WATCH_DIR}）\n`);
        return { ok: false, log };
      }
    }
    collect(`[info] 任务：${tasks.map((t) => TASKS[t].label).join(" → ")}${tasks.includes("enrich") ? `（最多 ${lim} 本）` : ""}\n`);
    for (const t of tasks) {
      collect(`\n── ${TASKS[t].label}（${TASKS[t].script}）──\n`);
      const code = await runScript(TASKS[t].script, TASKS[t].args(lim), collect);
      if (code !== 0) collect(`[warn] ${TASKS[t].script} 退出码 ${code}，继续后续任务\n`);
    }
    return { ok: true, log };
  } finally {
    release();
  }
}
