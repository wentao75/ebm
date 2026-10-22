// server.ts —— ebm 入口：Hono 路由（设计文档四）
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { cachedCover, eagerGenerate, requestCover } from "./covers";
import { isDataless, quickReady, requestMaterialize, statusOf } from "./materialize";
import { LibraryIndex, safeResolve } from "./indexer";
import {
  contentTypeForAcquisition,
  contentTypeForFeed,
  mimeOf,
  opdsAcquisition,
  opdsRoot,
  opensearchXml,
} from "./opds";
import { currentJob, isBusy } from "./jobs";
import { doubanCandidates, doubanSubject, ensureYabookDetail, externalMetaRunning, gaps as metadataGaps, isTaskName, MAX_ENRICH_LIMIT, runMetadata, status as metadataStatus, yabookCandidates } from "./metadata";
import { overrides, sanitizeOverride } from "./overrides";
import { isRunning, MAX_IDS_PER_RUN, runPipeline } from "./pipeline";
import { decide as decideRecommend, mainTitleKey, matchInLibrary, normTitleKey, normalizeDouban, readPending as readPendingRecommend, readQueued } from "./recommend";
import { queryArchive } from "./recoArchive";
import { restoreRejected, restoreStatus } from "./recoRestore";
import { pathAliases, performRename, planRename, RenameLog, suggestFileName, undoRename } from "./rename";
import { BookFile, LIBRARY_ROOT, LibraryScanner } from "./scanner";
import { isShelfName, normPage, ShelfStore, validRel } from "./shelves";

const PORT = parseInt(process.env.EBM_PORT || "6722", 10);
const HOST = process.env.EBM_HOST || "0.0.0.0";
const WEB_ROOT = "./src/web";
import { WATCH_DIR } from "./paths";

const scanner = new LibraryScanner();
const index = new LibraryIndex();
const shelves = new ShelfStore();

const app = new Hono();

// ---------- JSON 工具 ----------
const json = (c: import("hono").Context, data: unknown, status = 200) => c.json(data, status as 200);

function categoriesOf(entries: typeof index.entries) {
  const map = new Map<string, number>();
  for (const e of entries) map.set(e.category, (map.get(e.category) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

// ---------- 基础 API ----------
app.get("/api/health", (c) => json(c, { ok: true, root: LIBRARY_ROOT, books: index.entries.length }));

app.get("/api/books", (c) => json(c, { updated: Date.now(), books: index.summaries() }));

// ---------- 书名 / 文件名编辑（v1.7.3）----------
const renameLog = new RenameLog();
const renameDeps = () => ({
  migrateShelf: (o: string, n: string) => {
    shelves.migrate(o, n);
  },
  migrateOverride: (o: string, n: string) => {
    overrides.migrate(o, n);
  },
  flush: () => Promise.all([shelves.flushNow(), overrides.flushNow()]).then(() => undefined),
});

// 清理建议（纯本地、零风险）：建议文件名 + 命中的规则 + 提示
app.get("/api/book/rename/suggest", async (c) => {
  const rel = decodeURIComponent(c.req.query("path") || "");
  const book = index.find(rel);
  if (!book) return json(c, { error: "书不在索引中" }, 404);
  const name = rel.split("/").pop() || rel;
  const sug = suggestFileName(name);
  // 建议名与原名相同就不用报"占用/同名"错误，前端显式提示"没有可清理的内容"即可
  const plan = sug.suggested === name ? { ok: true } : await planRename(rel, sug.suggested);
  const blocked = sug.suggested === name ? null : plan.ok ? null : (plan as { error?: string }).error || null;
  return json(c, { ok: true, rel, ...sug, blocked });
});

// 执行重命名：物理改名 + 迁移书架/覆盖 + 记路径别名（改名不丢元数据）+ 记日志（可回滚）
app.post("/api/book/rename", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown; newName?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  const book = index.find(body.rel);
  if (!book) return json(c, { error: "书不在索引中" }, 404);
  const name = typeof body.newName === "string" && body.newName.trim()
    ? body.newName
    : suggestFileName(body.rel.split("/").pop() || body.rel).suggested;
  const result = await performRename(body.rel, name, renameDeps(), renameLog);
  if (!result.ok) return json(c, { error: result.error, extForced: result.extForced }, 400);
  await scanner.scan();
  await index.build(scanner.getFiles());
  return json(c, { ...result, ok: true });
});

// 撤销最近一次重命名（文件与数据一并还原）
app.post("/api/book/rename/undo", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  const result = await undoRename(body.rel, renameDeps(), renameLog);
  if (!result.ok) return json(c, { error: result.error }, 400);
  await scanner.scan();
  await index.build(scanner.getFiles());
  return json(c, { ...result, ok: true });
});

// 能否撤销（前端据此决定按钮状态）
app.get("/api/book/rename/history", async (c) => {
  const rel = decodeURIComponent(c.req.query("path") || "");
  const entry = await renameLog.lastFor(rel);
  return json(c, { ok: true, undoable: !!entry, last: entry });
});

// 单本详情：完整简介 / 目录 / meta（体积大，按需拉取，不进列表）
app.get("/api/book", (c) => {
  const rel = decodeURIComponent(c.req.query("path") || "");
  const book = index.find(rel);
  if (!book) return json(c, { error: "未找到该书" }, 404);
  return json(c, { book });
});

app.get("/api/categories", (c) => json(c, categoriesOf(index.entries)));

app.get("/api/search", (c) => {
  const q = c.req.query("q") || "";
  return json(c, { q, books: index.search(q) });
});

app.get("/api/recent", (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10) || 30, 100);
  const books = [...index.entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  return json(c, { books });
});

// ---------- 书架（在读/喜欢/读完）与阅读进度 ----------
app.get("/api/shelves", (c) => json(c, shelves.snapshot()));

app.post("/api/shelves", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { rel?: unknown; shelf?: unknown; value?: unknown }
    | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  if (!isShelfName(body.shelf)) return json(c, { error: "shelf 非法（reading|fav|done）" }, 400);
  const record = shelves.set(body.rel, body.shelf, body.value !== false);
  return json(c, { ok: true, record });
});

app.post("/api/shelves/progress", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown; page?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  const page = normPage(body.page);
  if (page == null) return json(c, { error: "page 非法" }, 400);
  const record = shelves.setProgress(body.rel, page);
  return json(c, { ok: true, record });
});

// ---------- 文件下载/预览（Range + 白名单 + Content-Disposition）----------
const ASCII_FALLBACK = (name: string) =>
  name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "book";

function rfc5987(name: string): string {
  return encodeURIComponent(name)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

app.get("/api/file", async (c) => {
  const rel = c.req.query("path") || "";
  const disp = c.req.query("disp") === "inline" ? "inline" : "attachment";
  const abs = safeResolve(rel);
  if (!abs) return c.text("非法路径", 403);
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
    if (!st.isFile()) return c.text("不存在", 404);
  } catch {
    return c.text("文件不存在（可能 iCloud 未下载或已被移动）", 404);
  }
  // —— iCloud dataless 兜底（策略 A）：数据在云端 → 触发取回并返回 202 ——
  if (isDataless(st)) {
    const status = requestMaterialize(abs);
    return c.json(
      { materializing: true, status, rel, title: path.basename(abs), hint: "数据在 iCloud 云端，取回后自动重试（首次打开需等待）" },
      202,
    );
  }
  const name = path.basename(abs);
  const type = mimeOf(path.extname(name).toLowerCase());
  const baseHeaders: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "content-disposition": `${disp}; filename="${ASCII_FALLBACK(name)}"; filename*=UTF-8''${rfc5987(name)}`,
    "cache-control": "no-cache",
  };
  const range = c.req.header("range");
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1] && m[2]) {
        // suffix range: bytes=-N
        start = Math.max(0, st.size - parseInt(m[2], 10));
        end = st.size - 1;
      }
      if (start >= st.size || start > end) {
        return c.newResponse(null, {
          status: 416,
          headers: { "content-range": `bytes */${st.size}` },
        });
      }
      end = Math.min(end, st.size - 1);
      const node = fs.createReadStream(abs, { start, end });
      node.on("error", () => node.destroy()); // 读失败（如被系统再驱逐）时断流而非崩溃
      return c.newResponse(Readable.toWeb(node) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-range": `bytes ${start}-${end}/${st.size}`,
          "content-length": String(end - start + 1),
        },
      });
    }
  }
  const node = fs.createReadStream(abs);
  node.on("error", () => node.destroy());
  return c.newResponse(Readable.toWeb(node) as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(st.size) },
  });
});

// ---------- iCloud 取回探针（前端轮询：dataless 文件就绪检测）----------
app.get("/api/materialized", async (c) => {
  const rel = c.req.query("path") || "";
  const abs = safeResolve(rel);
  if (!abs) return c.text("非法路径", 403);
  try {
    const ready = await quickReady(abs);
    if (!ready) requestMaterialize(abs); // 未就绪则确保取回任务在跑
    return json(c, { ready, status: ready ? "ready" : statusOf(abs) || "materializing", rel });
  } catch {
    return json(c, { ready: false, status: "failed", rel });
  }
});

// ---------- 封面（PDF 首页 / EPUB 内嵌图；云端书 404 → 前端占位，绝不触发取回）----------
app.get("/api/cover", async (c) => {
  const rel = c.req.query("path") || "";
  const abs = safeResolve(rel);
  if (!abs) return c.text("非法路径", 403);
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
    if (!st.isFile()) return c.text("不存在", 404);
  } catch {
    return c.text("不存在", 404);
  }
  const mtimeMs = st.mtimeMs;
  const toBytes = (b: Buffer): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(b.byteLength));
    out.set(b);
    return out;
  };
  // 快路径：缓存命中直接出图（曾打开过、后来又被系统驱逐的书也有封面）
  const hit = await cachedCover(rel, mtimeMs);
  if (hit) {
    return c.newResponse(toBytes(hit.buf), {
      headers: { "content-type": hit.type, "cache-control": "public, max-age=604800, immutable" },
    });
  }
  // 策略 A 红线：dataless 不生成、不探针、不取回
  if (isDataless(st)) return c.text("no cover (cloud book)", 404);
  const ext = path.extname(abs).replace(".", "").toUpperCase();
  if (ext !== "PDF" && ext !== "EPUB") return c.text("no cover for this format", 404);
  const result = await requestCover({ rel, mtimeMs, abs, ext });
  if (!result) return c.text("cover generation failed", 404);
  return c.newResponse(toBytes(result.buf), {
    headers: { "content-type": result.type, "cache-control": "public, max-age=604800, immutable" },
  });
});

// ---------- 推荐清单（tier2/3 网页化，设计文档四-8）----------
interface RecoItem {
  id: number;
  tier: number;
  title: string;
  author: string;
  douban?: string;
  folder: string;
  note: string;
  intro: string;
  category?: string;
  downloaded: boolean;
}

async function buildRecommendations(): Promise<RecoItem[]> {
  const [tiersRaw, detailsRaw, stateRaw] = await Promise.all([
    fsp.readFile(path.join(WATCH_DIR, "tiers.json"), "utf-8").catch(() => "{}"),
    fsp.readFile(path.join(WATCH_DIR, "post_details.json"), "utf-8").catch(() => "{}"),
    fsp.readFile(path.join(WATCH_DIR, "state.json"), "utf-8").catch(() => "{}"),
  ]);
  const tiers = JSON.parse(tiersRaw) as Record<string, { tier?: number; folder?: string; note?: string }>;
  const details = JSON.parse(detailsRaw) as Record<string, any>;
  const state = JSON.parse(stateRaw) as { downloads?: Array<{ id?: number }> };
  const downloadedIds = new Set((state.downloads || []).map((d) => d.id).filter(Boolean));
  const items: RecoItem[] = [];
  for (const [pid, t] of Object.entries(tiers)) {
    if (!t || (t.tier !== 2 && t.tier !== 3)) continue;
    const d = details[pid] || {};
    const rawTitle: string = d.title || "";
    const title = rawTitle.replace(/【[^】]*】/g, "").trim();
    const authorMatch = rawTitle.match(/^《[^》]+》\s*(.+?)\s*【/);
    items.push({
      id: Number(pid),
      tier: t.tier!,
      title: title || String(pid),
      author: (d.meta && d.meta["作者"]) || (authorMatch ? authorMatch[1] : ""),
      douban: d.douban || undefined,
      folder: t.folder || "未分类",
      note: t.note || "",
      intro: typeof d.intro === "string" ? d.intro.slice(0, 200) : "",
      category: d.category,
      downloaded: downloadedIds.has(Number(pid)),
    });
  }
  items.sort((a, b) => a.tier - b.tier || (parseFloat(b.douban || "0") - parseFloat(a.douban || "0")) || b.id - a.id);
  return items;
}

// ---------- 书目元数据补全（见 docs/metadata-enrichment.md）----------
// 状态：覆盖率、来源分布、任务状态、缺元数据的书（用于"检测到新书"提示）
app.get("/api/metadata/status", async (c) => {
  try {
    return json(c, await metadataStatus(index.entries.map((e) => e.rel)));
  } catch (err) {
    return json(c, { error: String(err) }, 500);
  }
});

// 触发补全任务：流式日志（与一键下载同构，共用互斥锁）
app.post("/api/metadata/run", async (c) => {
  // 先做参数校验（400），再检查互斥/外部进程（409）——保证错误码语义稳定
  const body = (await c.req.json().catch(() => null)) as { tasks?: unknown; limit?: unknown } | null;
  const raw = body?.tasks;
  if (raw !== undefined && !Array.isArray(raw)) return c.text("tasks 须为数组（build|enrich|catalog）", 400);
  const tasks = Array.isArray(raw) ? raw.filter(isTaskName) : (["build", "enrich", "catalog"] as const).slice();
  if (!tasks.length) return c.text("tasks 非法（可选 build|enrich|catalog）", 400);
  const limit = Number(body?.limit ?? 80);
  if (!Number.isFinite(limit) || limit < 1) return c.text(`limit 须为正整数（上限 ${MAX_ENRICH_LIMIT}）`, 400);
  if (isBusy()) return c.text(`已有任务在执行中（${currentJob()}），请稍候`, 409);
  // 外部进程（每日巡检/其它会话）正在补全时禁止并发：两个 enrich 会互相覆盖 book_meta.json
  if (await externalMetaRunning()) {
    return c.text("检测到后台已有元数据补全进程在运行（会与本应用互相覆盖），请等它结束后再试", 409);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* 客户端断开 */
        }
      };
      try {
        const result = await runMetadata(tasks, limit, push);
        push(`\n[result] ${result.ok ? "完成，正在刷新书库…" : "失败"}\n`);
      } catch (err) {
        push(`\n[error] ${String(err)}\n`);
      } finally {
        controller.close();
        // 元数据写盘后重扫重建，让新简介立刻出现在书库/详情页
        try {
          await scanner.scan();
          await index.build(scanner.getFiles());
          push("");
        } catch {
          /* ignore */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});

// 待补清单：哪些书缺简介、原因是什么（原因来自管道缓存说明）
app.get("/api/metadata/gaps", async (c) => {
  try {
    const items = await metadataGaps(index.entries.map((e) => e.rel), new Set(Object.keys(overrides.snapshot().items)));
    const byReason: Record<string, number> = {};
    for (const g of items) byReason[g.reason] = (byReason[g.reason] || 0) + 1;
    return json(c, { total: items.length, byReason, overrides: overrides.count(), items });
  } catch (err) {
    return json(c, { error: String(err) }, 500);
  }
});

// 查豆瓣候选（复用管道匹配逻辑）：给人工确认提供候选 id / 分数
app.post("/api/metadata/candidates", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  const book = index.find(body.rel);
  if (!book) return json(c, { error: "书不在索引中" }, 404);
  // 雅书候选是本地匹配（零网络）；豆瓣候选需要联网
  const yb = await yabookCandidates(book.title, String(body.rel));
  const db = await doubanCandidates(book.title, book.author || "");
  if (!db.ok && !yb.ok) {
    return json(c, { error: "候选查询失败（管道脚本或网络不可用）", log: db.log }, 502);
  }
  return json(c, { ...db, ok: true, yabook: yb.items });
});

// 采纳雅书（L1）候选：本地详情 → 写入人工覆盖（含"一帖已配给另一本重复书"的情况）
app.post("/api/metadata/adopt-yabook", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown; yabookId?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  if (!index.find(body.rel)) return json(c, { error: "书不在索引中" }, 404);
  const id = String(body.yabookId ?? "");
  if (!/^[0-9]{1,10}$/.test(id)) return json(c, { error: "yabookId 非法" }, 400);
  // 未缓存的帖现场抓取（约 2~5 秒），抓到的详情同时成为 L1 层的长期资产
  const rec = await ensureYabookDetail(id);
  if (!rec) return json(c, { error: "雅书详情抓取失败（帖子不存在或网络不可用）" }, 502);
  const patch = sanitizeOverride({
    // 注意：不覆盖书名——雅书帖标题带【文字版_PDF电子书_雅书】等标记，会污染书库显示
    author: rec.author, intro: rec.intro, toc: rec.toc, tags: rec.tags,
    publisher: rec.publisher, year: rec.year, pages: rec.pages, translator: rec.translator,
    douban: rec.douban, source: "yabook-adopt",
    note: `人工确认采纳雅书帖 ${id}${rec.title ? `（${String(rec.title).slice(0, 30)}）` : ""}`,
  });
  if (!patch) return json(c, { error: "雅书详情为空" }, 502);
  const saved = overrides.set(body.rel, patch);
  await overrides.flushNow();
  await index.build(scanner.getFiles());
  return json(c, { ok: true, override: saved });
});

// 采纳豆瓣候选 → 写入人工覆盖（ebm 自己的文件，不动管道数据）
app.post("/api/metadata/adopt", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown; doubanId?: unknown; score?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  const book = index.find(body.rel);
  if (!book) return json(c, { error: "书不在索引中" }, 404);
  const id = String(body.doubanId ?? "");
  if (!/^[0-9]{4,12}$/.test(id)) return json(c, { error: "doubanId 非法" }, 400);
  const rec = await doubanSubject(id);
  if (!rec) return json(c, { error: "豆瓣详情抓取失败（限流或条目不可用）" }, 502);
  const patch = sanitizeOverride({
    title: rec.title, author: rec.author, intro: rec.intro, publisher: rec.publisher,
    year: rec.year, pages: rec.pages, translator: rec.translator, douban: rec.douban,
    isbn: rec.isbn, author_bio: rec.author_bio,
    tags: Array.isArray(rec.tags) ? rec.tags : undefined,
    source: "douban-adopt",
    note: `人工确认采纳豆瓣条目 ${id}${rec.title ? `（${rec.title}）` : ""}${body.score ? ` · 匹配分 ${body.score}` : ""}`,
  });
  if (!patch) return json(c, { error: "豆瓣返回内容为空" }, 502);
  const saved = overrides.set(body.rel, patch);
  await overrides.flushNow();
  await index.build(scanner.getFiles());
  return json(c, { ok: true, override: saved });
});

// 手工填写覆盖（支持部分字段）
app.post("/api/metadata/override", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rel?: unknown; fields?: unknown; clear?: unknown } | null;
  if (!body || !validRel(body.rel)) return json(c, { error: "rel 非法" }, 400);
  if (!index.find(body.rel)) return json(c, { error: "书不在索引中" }, 404);
  // 支持清除字段（如管道把作者简介塞进了作者字段）：清掉后回落到管道/文件名数据
  const clearList = Array.isArray(body.clear) ? body.clear.filter((f) => typeof f === "string") : [];
  let cleared: ReturnType<typeof overrides.clearFields> = null;
  if (clearList.length) cleared = overrides.clearFields(body.rel, clearList as string[]);
  const fields = sanitizeOverride(body.fields);
  if (!fields) {
    if (!clearList.length) return json(c, { error: "未提供任何有效字段" }, 400);
    await overrides.flushNow();
    await index.build(scanner.getFiles());
    return json(c, { ok: true, override: cleared });
  }
  // 只在"新建"时打默认来源标记；部分更新（如清除字段）必须保留原有采纳来源
  const existing = overrides.get(body.rel);
  if (!fields.source && !existing) fields.source = "manual";
  if (!fields.note && !existing) fields.note = "人工填写";
  const saved = overrides.set(body.rel, fields);
  await overrides.flushNow();
  await index.build(scanner.getFiles());
  return json(c, { ok: true, override: saved });
});

// 撤销人工覆盖
app.delete("/api/metadata/override", async (c) => {
  const rel = c.req.query("path") || "";
  if (!validRel(rel)) return json(c, { error: "path 非法" }, 400);
  const removed = overrides.remove(rel);
  await overrides.flushNow();
  if (removed) await index.build(scanner.getFiles());
  return json(c, { ok: true, removed });
});

app.get("/api/recommendations", async (c) => {
  try {
    return json(c, { max: MAX_IDS_PER_RUN, running: isRunning(), items: await buildRecommendations() });
  } catch (err) {
    return json(c, { error: String(err) }, 500);
  }
});

// ---------- 待下载确认（清单来自管道 recommend.py，决策由它 apply 落盘）----------
// 读取：先让管道 sync 重建清单（保留手写勾选），再解析成结构化条目
app.get("/api/recommend/pending", async (c) => {
  try {
    // 默认纯读取；界面进入/刷新时带 ?sync=1 让管道重建清单（GET 本身不产生副作用）
    const wantSync = c.req.query("sync") === "1";
    const libKeys = index.entries.map((e) => {
      const base = e.rel.split("/").pop() || e.rel;
      return { rel: e.rel, key: normTitleKey(base), main: mainTitleKey(base) };
    });
    const [pending, queued] = await Promise.all([readPendingRecommend(wantSync, libKeys), readQueued(libKeys)]);
    return json(c, {
      ...pending,
      queued: queued.items,
      queuedInLibrary: queued.inLibrary,
      maxDownload: MAX_IDS_PER_RUN,
    });
  } catch (err) {
    return json(c, { error: String(err) }, 500);
  }
});

// 决策：批准→tier1（次日巡检自动下载归档）、拒绝→tier3+「用户拒绝」
// 与下载/元数据任务共用全局锁，避免并发写 tiers.json
app.post("/api/recommend/decide", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { approve?: unknown; reject?: unknown } | null;
  if (!body) return json(c, { error: '请求体须为 {"approve":[…],"reject":[…]}' }, 400);
  const libKeys = index.entries.map((e) => {
    const base = e.rel.split("/").pop() || e.rel;
    return { rel: e.rel, key: normTitleKey(base), main: mainTitleKey(base) };
  });
  const result = await decideRecommend(body.approve, body.reject, libKeys);
  if (result.ok) return json(c, result);
  const status = result.busy ? 409 : result.scriptMissing ? 502 : 400;
  return json(c, result, status);
});

// 推荐条目的完整详情（列表只有书名/目录/评分，这里给完整简介/目录/元数据）
app.get("/api/reco/detail", async (c) => {
  const id = String(c.req.query("id") || "");
  if (!/^[0-9]{1,10}$/.test(id)) return json(c, { error: "id 非法" }, 400);
  const rec = await ensureYabookDetail(id);
  if (!rec) return json(c, { error: "该帖详情不可用（不在缓存且抓取失败）" }, 502);
  return json(c, { ok: true, id: Number(id), ...rec, douban: normalizeDouban(rec.douban) });
});

// 恢复为待定：把误判「不要了」的书从 tier3 还原回 tier2（EBM 唯一写 tiers.json 的入口，带备份+锁）
app.post("/api/reco/restore", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids)) return json(c, { error: '请求体须为 {"ids":[…]' }, 400);
  const r = await restoreRejected(body.ids);
  if (!r.ok) return json(c, r, r.busy ? 409 : 400);
  // 恢复后让管道重建清单，该书应重新出现在「待确认」里
  try {
    await readPendingRecommend(true);
  } catch {
    /* 刷新失败不影响恢复结果 */
  }
  return json(c, r);
});

// 恢复能力的辅助信息（有快照的条数、最近操作、备份目录）
app.get("/api/reco/restore/status", async (c) => json(c, await restoreStatus()));

// 历史决策归档（只读）：按月/关键词查看被管道截断前的决策记录
app.get("/api/reco/archive", async (c) => {
  try {
    return json(c, await queryArchive({
      month: c.req.query("month") || "all",
      q: c.req.query("q") || "",
      limit: Number(c.req.query("limit") || 200),
    }));
  } catch (err) {
    return json(c, { error: String(err) }, 500);
  }
});

// ---------- 一键下载：流式日志 ----------
app.post("/api/pipeline/download", async (c) => {
  if (isRunning()) return c.text("已有下载任务在执行中", 409);
  let ids: number[];
  try {
    const body = await c.req.json();
    ids = (body?.ids || []).map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0);
  } catch {
    return c.text("请求体须为 {\"ids\":[...]}", 400);
  }
  if (!ids.length) return c.text("未选择任何书目", 400);
  if (ids.length > MAX_IDS_PER_RUN) return c.text(`单次最多 ${MAX_IDS_PER_RUN} 本`, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* 客户端断开 */
        }
      };
      try {
        const result = await runPipeline(ids, push);
        push(`\n[result] ${result.ok ? "完成，书库将自动刷新" : "失败"}\n`);
      } catch (err) {
        push(`\n[error] ${String(err)}\n`);
      } finally {
        controller.close();
        // 管道把书移入 iCloud → fs.watch 会自动触发重扫；这里兜底显式刷一次
        try {
          await scanner.scan();
          await index.build(scanner.getFiles());
        } catch {
          /* ignore */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});

// ---------- OPDS ----------
app.get("/opds", (c) => {
  const updated = index.entries.length
    ? new Date(Math.max(...index.entries.map((e) => e.mtimeMs))).toISOString()
    : new Date().toISOString();
  return c.newResponse(opdsRoot(categoriesOf(index.entries), updated), {
    headers: { "content-type": contentTypeForFeed() },
  });
});

app.get("/opds/opensearch.xml", (c) =>
  c.newResponse(opensearchXml(), { headers: { "content-type": "application/opensearchdescription+xml;charset=utf-8" } }),
);

app.get("/opds/category/:name", (c) => {
  const name = c.req.param("name");
  const books = name === "_all" ? index.entries : index.entries.filter((e) => e.category === name);
  if (name !== "_all" && !books.length) return c.text("分类不存在", 404);
  const title = name === "_all" ? "全部书目" : `${name}（${books.length}）`;
  return c.newResponse(opdsAcquisition(`urn:ebm:cat:${name}`, `/opds/category/${name}`, title, books), {
    headers: { "content-type": contentTypeForAcquisition() },
  });
});

app.get("/opds/search", (c) => {
  const q = c.req.query("q") || "";
  const books = index.search(q);
  return c.newResponse(opdsAcquisition("urn:ebm:search", "/opds/search", `搜索：${q}（${books.length}）`, books), {
    headers: { "content-type": contentTypeForAcquisition() },
  });
});

// ---------- 静态资源（网页 UI）----------
// 应用壳文件禁缓存（read.js/app.js 曾因浏览器启发式缓存导致更新不生效）；vendor 大库允许缓存
app.use("*", async (c, next) => {
  await next();
  const p = new URL(c.req.url).pathname;
  if (p === "/" || p === "/read" || p.endsWith(".html") || p.endsWith(".css") || p === "/app.js" || p === "/read.js") {
    c.header("Cache-Control", "no-cache");
  }
});
app.use("*", serveStatic({ root: WEB_ROOT, rewriteRequestPath: (p) => decodeURIComponent(p) }));
app.get("/", serveStatic({ root: WEB_ROOT, path: "index.html" }));
app.get("/read", serveStatic({ root: WEB_ROOT, path: "read.html" }));

// ---------- 启动 ----------
function buildAbsMap(files: BookFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.rel, f.abs]));
}

/** 后台补齐本地书封面（幂等，有缓存即跳过；仅本地 PDF/EPUB） */
function refreshCovers(): void {
  if (process.env.EBM_EAGER_COVERS === "0") return; // 测试环境跳过，避免无谓的 sips 调用
  const absMap = buildAbsMap(scanner.getFiles());
  const jobs = index.entries
    .filter((e) => !e.dataless && (e.ext === "PDF" || e.ext === "EPUB"))
    .filter((e) => absMap.has(e.rel))
    .map((e) => ({ rel: e.rel, mtimeMs: e.mtimeMs, abs: absMap.get(e.rel)!, ext: e.ext }));
  if (jobs.length) {
    console.log(`[ebm] 封面队列：${jobs.length} 本待检`);
    eagerGenerate(jobs);
  }
}

async function main(): Promise<void> {
  await shelves.load();
  await overrides.load();
  await pathAliases.load();
  await scanner.startWatching();
  await index.build(scanner.getFiles());
  console.log(`[ebm] 索引完成：${index.entries.length} 本 · 书库 ${LIBRARY_ROOT}`);
  refreshCovers();
  // 退出前把去抖窗口内的书架变更落盘（launchctl kickstart -k 会发 SIGTERM）
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void Promise.all([shelves.flushNow(), overrides.flushNow()]).finally(() => process.exit(0));
    });
  }
  scanner.on("updated", (files: BookFile[]) => {
    void index.build(files).then(() => {
      console.log(`[ebm] 书库变更 → 重新索引：${index.entries.length} 本`);
      refreshCovers();
    });
  });
  // 监听 book_meta.json：管道补全（每日巡检或手动补跑）写盘后自动重建索引。
  // ⚠ 管道写这个文件用 os.replace() 原子替换（inode 会变），而 fs.watch("文件") 在替换后
  //   收不到事件（实测：修好简介后 EBM 仍显示旧值，直到重启）。因此改为：
  //   ① 监听所在目录并按文件名过滤（目录监听不受替换影响）
  //   ② 30s 低频 mtime 轮询兜底（某些文件系统/网络盘可能漏事件）
  const metaFile = path.join(WATCH_DIR, "book_meta.json");
  let metaTimer: ReturnType<typeof setTimeout> | undefined;
  let metaMtime = 0;
  const rebuildForMeta = (): void => {
    if (metaTimer) clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      void (async () => {
        try {
          await index.build(scanner.getFiles());
          const withIntro = index.entries.filter((e) => e.intro).length;
          console.log(`[ebm] 书目元数据更新 → 索引已重建（含简介 ${withIntro} 本）`);
        } catch (err) {
          console.error("[ebm] 元数据更新后重建索引失败:", err);
        }
      })();
    }, 1500);
  };
  /** 只有 mtime 真的变了才重建，避免目录里其它文件（日志/报告）频繁触发 */
  const pollMeta = async (): Promise<void> => {
    try {
      const st = await fsp.stat(metaFile);
      if (st.mtimeMs !== metaMtime) {
        metaMtime = st.mtimeMs;
        rebuildForMeta();
      }
    } catch {
      /* 文件还不存在：等下次 */
    }
  };
  try {
    await pollMeta(); // 建立初始基准
    fs.watch(WATCH_DIR, (_ev, name) => {
      const n = name ? String(name) : "";
      if (n && n !== "book_meta.json") return; // 目录里其它文件不关心
      void pollMeta();
    });
    console.log(`[ebm] 已监听书目元数据目录（按 book_meta.json 过滤）：${WATCH_DIR}`);
    const metaPoll = setInterval(() => void pollMeta(), 30_000);
    metaPoll.unref?.();
  } catch (err) {
    console.warn("[ebm] 未能监听 book_meta.json，补全后需手动重建索引:", err);
  }
  // 打印构建时间：改代码后忘记重启服务时，一眼就能看出来
  try {
    const st = await fsp.stat(path.join(__dirname, "server.js"));
    console.log(`[ebm] 构建时间：${new Date(st.mtimeMs).toLocaleString("zh-CN")}`);
  } catch {
    /* ignore */
  }

  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[ebm] listening on http://${HOST}:${PORT}  (局域网/内网可直连同一端口)`);
    void info;
  });
}

void main().catch((err) => {
  console.error("[ebm] 启动失败:", err);
  process.exit(1);
});
