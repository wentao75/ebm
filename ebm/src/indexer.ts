// indexer.ts —— 文件名解析 + 雅书管道元数据 join + 搜索
import fsp from "fs/promises";
import path from "path";
import { MetaOverride, overrides } from "./overrides";
import { pathAliases } from "./rename";
import { WATCH_DIR } from "./paths";
import { BookFile, LIBRARY_ROOT } from "./scanner";
/** 书目元数据（新体系，覆盖率远高于雅书管道）：yabook_watch/book_meta.json，key 就是书库相对路径 */
const BOOK_META_FILE = path.join(WATCH_DIR, "book_meta.json");
/**
 * 管道每次下载（含界面「立即下载」）都会写的清单：id → 文件。
 * 手动下载不进 state.json.downloads（那由每日 daily_finish 记账），所以必须靠它拿到精确映射。
 */
const MANIFEST_FILE = path.join(WATCH_DIR, "download_manifest_result.json");
/** 参与"是否需要重读元数据"判定的管道文件 */
const META_SOURCE_FILES = [
  path.join(WATCH_DIR, "post_details.json"),
  path.join(WATCH_DIR, "state.json"),
  MANIFEST_FILE,
];
/** arXiv 摘要接口会把 arXiv ID 塞进 author 字段，属脏值需过滤 */
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;

export interface BookEntry {
  rel: string;
  title: string;
  author: string;
  category: string;
  ext: string;
  size: number;
  mtimeMs: number;
  // —— 来自管道元数据（约 193+ 本可命中，其余为空）——
  douban?: string;
  /** 列表用简介（截断，保证 /api/books 体积可控） */
  intro?: string;
  tags?: string[];
  publisher?: string;
  pubDate?: string;
  sourceId?: number; // 雅书 post id
  /** iCloud dataless：数据在云端 */
  dataless?: boolean;
  // —— 详情视图专用（体积大，仅 /api/book 单本返回，不进列表）——
  /** 完整简介（源数据最长约 1500 字） */
  introFull?: string;
  /** 目录文本 */
  toc?: string;
  /** 管道 meta：出版社/译者/页数/原名/ISBN/作者简介等 */
  meta?: Record<string, string>;
  /** 元数据来源层（yabook/douban/openlibrary/arxiv/googlebooks），详情页展示可信度 */
  metaSource?: string;
}

interface PostDetail {
  id: number;
  title: string;
  meta?: Record<string, string>;
  douban?: string;
  date?: string;
  category?: string;
  intro?: string;
  tags?: string[];
  toc?: string;
}

/** 显示清理：下划线转空格、合并空白、去首尾分隔符 */
function clean(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—、.。·]+|[\s\-–—]+$/g, "")
    .trim();
}

/**
 * 文件名解析（设计文档四-2 的多级兜底）：
 * 1) 《书名》作者【…】.ext
 * 2) 《书名》作者.ext
 * 3) 书名 - Author.ext
 * 4) 书名.ext
 */
export function parseFilename(filename: string): { title: string; author: string } {
  let base = filename.replace(/\.(pdf|epub|mobi|azw3|djvu|txt)$/i, "");
  base = base.replace(/【[^】]*】/g, "");
  const m1 = base.match(/^《(.+?)》\s*(.*)$/);
  if (m1) return { title: clean(m1[1]), author: clean(m1[2]) };
  const m2 = base.match(/^(.+?)\s[-–—]\s(.+)$/);
  if (m2) return { title: clean(m2[1]), author: clean(m2[2]) };
  return { title: clean(base), author: "" };
}

/** 归一化标题：去空白/标点，用于元数据 join 的模糊键 */
function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[《》【】（）()\[\]：:，,。.!！?？·、\s'’"“”\-–—_&+`～~]/g, "")
    .trim();
}

/**
 * 清理来源文本里的"折叠态"残留：(展开全部)/(收起)、结尾省略号、游离引号。
 * 豆瓣把简介分成「折叠预览」与「完整正文」两处，历史数据里存过预览版 →
 * 界面不该出现 "(展开全部)" 这种痕迹（管道侧已修复取完整正文，这里再兜一层）。
 */
export function cleanSourceText(s: string): string {
  return htmlUnescape(s)
    .replace(/[（(]\s*展开全部\s*[)）]/g, "")
    .replace(/[（(]\s*收起\s*[)）]/g, "")
    .replace(/\n?\s*\.{3,}\s*$/g, "")
    .replace(/\s*[()（）“”"']\s*$/g, "")
    .trim();
}

/** HTML 实体解码：覆盖常见命名实体 + 数字实体（管道 intro/toc 里大量出现 &ldquo; &hellip; 等） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", middot: "\u00b7", bull: "\u2022",
  laquo: "\u00ab", raquo: "\u00bb", times: "\u00d7", divide: "\u00f7", plusmn: "\u00b1",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0", sect: "\u00a7", para: "\u00b6",
  larr: "\u2190", rarr: "\u2192", harr: "\u2194", le: "\u2264", ge: "\u2265", ne: "\u2260",
  sect2: "\u00a7", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
};
/** 管道标记（雅书下载器写进文件名的后缀，如【文字版_PDF电子书_雅书】） */
const PIPELINE_MARKER = /【[^】]*(?:雅书|电子书|文字版|扫描版|精校版)[^】]*】/g;

/**
 * 文件名归一化：剥离管道标记并统一空白/下划线。
 * 用于"按文件名匹配元数据"——这样无论文件是否已清理掉标记（含历史 state.json 记录），都能命中。
 */
function normBase(name: string): string {
  return name
    .toLowerCase()
    .replace(PIPELINE_MARKER, "")
    .replace(/[_\-\s]+(?=\.[a-z0-9]+$)/, "")
    .replace(/_{2,}/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlUnescape(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g: string) => {
    if (g.startsWith("#")) {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[g] ?? m;
  });
}

export class LibraryIndex {
  entries: BookEntry[] = [];
  private byNormTitle = new Map<string, PostDetail>();
  private byBasename = new Map<string, PostDetail>();
  private loadedMeta = false;
  /** 上次加载时管道文件的 mtime 指纹：变了就重读，下载新书后无需重启服务 */
  private metaStamp = "";
  private bookMeta: Record<string, Record<string, unknown>> = {};
  private bookMetaMtime = 0;

  /** 从雅书管道文件加载元数据（post_details.json + state.json.downloads） */
  /** 管道数据文件的 mtime 指纹 */
  private async metaStamps(): Promise<string> {
    const out: string[] = [];
    for (const f of META_SOURCE_FILES) {
      try {
        out.push(String((await fsp.stat(f)).mtimeMs));
      } catch {
        out.push("-");
      }
    }
    return out.join("|");
  }

  async loadMeta(force = false): Promise<void> {
    const stamp = await this.metaStamps();
    if (!force && this.loadedMeta && stamp === this.metaStamp) return; // 没变就不重读
    this.metaStamp = stamp;
    this.loadedMeta = false;
    this.byNormTitle.clear();
    this.byBasename.clear();
    try {
      const details: Record<string, PostDetail> = JSON.parse(
        await fsp.readFile(path.join(WATCH_DIR, "post_details.json"), "utf-8"),
      );
      for (const d of Object.values(details)) {
        const parsed = parseFilename(d.title || "");
        const t = normTitle(d.meta?.["书名"] || parsed.title);
        if (t) this.byNormTitle.set(t, d);
      }
      try {
        const state = JSON.parse(
          await fsp.readFile(path.join(WATCH_DIR, "state.json"), "utf-8"),
        );
        const downloads = Array.isArray(state.downloads) ? state.downloads : [];
        for (const d of downloads) {
          if (!d?.file || !d?.id) continue;
          const base = path.basename(d.file as string);
          const detail = details[String(d.id)];
          // 用归一化文件名做键：文件改名（清理管道标记）后仍能命中
          if (detail) this.byBasename.set(normBase(base), detail);
        }
      } catch {
        // state.json 读取失败不影响主流程
      }
      // 手动下载（界面「立即下载」）不写 state.downloads，用 download_books.py 的清单补精确映射
      try {
        const man = JSON.parse(await fsp.readFile(MANIFEST_FILE, "utf-8")) as
          | Array<{ id?: number; file?: string }>
          | { results?: Array<{ id?: number; file?: string }> };
        const arr = Array.isArray(man) ? man : man.results || [];
        for (const r of arr) {
          const detail = details[String(r?.id ?? "")];
          const file = String(r?.file || "");
          if (!detail || !file) continue;
          this.byBasename.set(normBase(path.basename(file)), detail);
        }
      } catch {
        // 没有清单文件（管道未跑过下载）时忽略
      }
      this.loadedMeta = true;
    } catch (err) {
      console.error("[indexer] post_details.json 加载失败（元数据将缺失）:", err);
    }
    await this.loadBookMeta(true);
  }

  /**
   * 读取 book_meta.json（管道侧元数据补全体系的产出，见 docs/metadata-enrichment.md）。
   * force=false 时只在文件 mtime 变化后重读——补全任务在后台持续写入，索引重建即可看到新简介。
   */
  private async loadBookMeta(force = false): Promise<void> {
    try {
      const st = await fsp.stat(BOOK_META_FILE);
      if (!force && st.mtimeMs === this.bookMetaMtime) return;
      const data = JSON.parse(await fsp.readFile(BOOK_META_FILE, "utf-8")) as {
        books?: Record<string, Record<string, unknown>>;
      };
      this.bookMeta = data.books || {};
      this.bookMetaMtime = st.mtimeMs;
      const withIntro = Object.values(this.bookMeta).filter((b) => b.intro).length;
      console.log(`[ebm] 书目元数据已载入：${Object.keys(this.bookMeta).length} 条（含简介 ${withIntro}）`);
    } catch {
      // 文件不存在（管道未就绪）时保持为空，不影响服务
      this.bookMeta = {};
      this.bookMetaMtime = 0;
    }
  }

  /** 把 book_meta.json 的记录映射到索引条目：**只填空、不覆盖**（雅书精确匹配结果优先） */
  private applyBookMeta(e: BookEntry, m: Record<string, unknown>): void {
    const txt = (k: string): string => {
      const v = m[k];
      return typeof v === "string" ? htmlUnescape(v).trim() : "";
    };
    const src = Object.keys((m.sources as Record<string, unknown>) || {})[0] || "";
    e.metaSource = src || undefined;

    const intro = cleanSourceText(txt("intro"));
    if (!e.intro && intro) {
      e.intro = intro.slice(0, 300);
      e.introFull = intro.slice(0, 6000);
    }
    const toc = cleanSourceText(txt("toc"));
    if (!e.toc && toc) e.toc = toc.slice(0, 6000);
    if (!e.author) {
      const author = txt("author");
      // arXiv 记录把 arXiv ID 写进了 author，属脏值，跳过
      if (author && !ARXIV_ID_RE.test(author)) e.author = author;
    }
    if (!e.title && txt("title")) e.title = txt("title");
    const db = parseFloat(txt("douban"));
    if (!e.douban && !isNaN(db) && db > 0) e.douban = txt("douban");
    if (!e.pubDate && txt("year")) e.pubDate = txt("year");
    if (!e.publisher && txt("publisher")) e.publisher = txt("publisher");
    const tags = m.tags;
    if (!e.tags?.length && Array.isArray(tags) && tags.length) {
      e.tags = tags.map((t) => htmlUnescape(String(t)).trim()).filter(Boolean);
    }
    const meta: Record<string, string> = { ...(e.meta || {}) };
    const META_FIELDS: Array<[string, string]> = [
      ["translator", "译者"], ["pages", "页数"], ["original_title", "原名"],
      ["isbn", "ISBN"], ["author_bio", "作者简介"],
    ];
    for (const [key, label] of META_FIELDS) {
      if (!meta[label] && txt(key)) meta[label] = txt(key);
    }
    if (Object.keys(meta).length) e.meta = meta;
  }

  /** 人工覆盖：**优先级最高**，显式覆盖已解析/已补全的字段（含空值也覆盖） */
  private applyOverride(e: BookEntry, ov: MetaOverride): void {
    const t = (v?: string): string => (typeof v === "string" && v.trim() ? htmlUnescape(v).trim() : "");
    if (t(ov.title)) e.title = t(ov.title);
    if (t(ov.author)) e.author = t(ov.author);
    const intro = t(ov.intro);
    if (intro) {
      e.intro = intro.slice(0, 300);
      e.introFull = intro.slice(0, 6000);
    }
    if (t(ov.toc)) e.toc = t(ov.toc).slice(0, 6000);
    if (t(ov.publisher)) e.publisher = t(ov.publisher);
    if (t(ov.year)) e.pubDate = t(ov.year);
    const db = parseFloat(t(ov.douban));
    if (!isNaN(db) && db > 0) e.douban = t(ov.douban);
    else if (typeof ov.douban === "string" && !ov.douban.trim()) delete e.douban;
    if (ov.tags?.length) e.tags = ov.tags.map((x) => htmlUnescape(String(x)).trim()).filter(Boolean);
    const meta: Record<string, string> = { ...(e.meta || {}) };
    const FIELD_MAP: Array<[keyof MetaOverride, string]> = [
      ["translator", "译者"], ["pages", "页数"], ["isbn", "ISBN"], ["author_bio", "作者简介"],
    ];
    for (const [k, label] of FIELD_MAP) {
      const v = t(ov[k] as string | undefined);
      if (v) meta[label] = v;
      else if (e.meta && label in e.meta && typeof ov[k] === "string" && !String(ov[k]).trim()) delete meta[label];
    }
    e.meta = Object.keys(meta).length ? meta : undefined;
    e.metaSource =
      ov.source === "douban-adopt" ? "douban（人工确认）"
      : ov.source === "yabook-adopt" ? "雅书（人工确认）"
      : "manual";
  }

  /** 用扫描结果重建索引 */
  async build(files: BookFile[]): Promise<void> {
    await this.loadMeta(); // mtime 未变时内部直接返回，开销只是几次 stat
    await this.loadBookMeta(); // 补全任务在后台持续写盘，mtime 变化即重读
    this.entries = files.map((f) => {
      const parsed = parseFilename(f.name);
      const e: BookEntry = {
        rel: f.rel,
        title: parsed.title || f.name,
        author: parsed.author,
        category: f.category,
        ext: f.ext.replace(".", "").toUpperCase(),
        size: f.size,
        mtimeMs: f.mtimeMs,
        dataless: f.dataless || undefined,
      };
      // 改名后 rel 变了：跟随路径别名找回旧键下的管道元数据（否则会像上次那样"改名丢简介"）
      const aliasRel = pathAliases.resolve(f.rel);
      const aliasName = aliasRel === f.rel ? "" : path.basename(aliasRel);
      const detail =
        this.byBasename.get(normBase(f.name)) ||
        (aliasName ? this.byBasename.get(normBase(aliasName)) : undefined) ||
        this.byNormTitle.get(normTitle(parsed.title));
      if (detail) {
        e.sourceId = detail.id;
        // 豆瓣 "0.0" 视为无评分（数据源用 0.0 表示抓不到评分）
        const db = parseFloat(detail.douban || "");
        e.douban = !isNaN(db) && db > 0 ? detail.douban : undefined;
        const fullIntro = detail.intro ? cleanSourceText(detail.intro) : "";
        // 列表只带截断简介（控制 /api/books 体积）；详情接口返回完整版
        e.intro = fullIntro ? fullIntro.slice(0, 300) : undefined;
        e.introFull = fullIntro ? fullIntro.slice(0, 6000) : undefined;
        e.toc = detail.toc ? cleanSourceText(detail.toc).slice(0, 6000) : undefined;
        e.meta = detail.meta
          ? Object.fromEntries(Object.entries(detail.meta).map(([k, v]) => [k, htmlUnescape(String(v)).trim()]))
          : undefined;
        e.tags = detail.tags && detail.tags.length
          ? (Array.isArray(detail.tags) ? detail.tags : [detail.tags]).map((t) => htmlUnescape(String(t)).trim())
          : undefined;
        e.publisher = detail.meta?.["出版社"] ? htmlUnescape(detail.meta["出版社"]).trim() : undefined;
        e.pubDate = detail.meta?.["出版日期"] ? htmlUnescape(detail.meta["出版日期"]).trim() : undefined;
        if (!e.author && detail.meta?.["作者"]) e.author = htmlUnescape(detail.meta["作者"]).trim();
        if (!e.title && detail.meta?.["书名"]) e.title = htmlUnescape(detail.meta["书名"]).trim();
      }
      // 新体系（覆盖率 76%）兜底补齐：只填空字段
      const bm = this.bookMeta[f.rel] || (aliasRel !== f.rel ? this.bookMeta[aliasRel] : undefined);
      if (bm) this.applyBookMeta(e, bm);
      // 人工覆盖优先级最高（显式确认的数据必须生效）
      const ov = overrides.get(f.rel);
      if (ov) this.applyOverride(e, ov);
      return e;
    });
  }

  /** 子串搜索：全部 token 命中任一字段即入选（805 本规模毫秒级） */
  search(q: string): BookEntry[] {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return this.entries;
    const hits: Array<{ e: BookEntry; score: number }> = [];
    for (const e of this.entries) {
      const title = e.title.toLowerCase();
      const author = (e.author || "").toLowerCase();
      const hay = [
        title,
        author,
        e.category.toLowerCase(),
        (e.tags || []).join(" ").toLowerCase(),
        (e.intro || "").toLowerCase(),
        e.douban || "",
      ];
      let score = 0;
      let all = true;
      for (const tk of tokens) {
        const idx = hay.findIndex((h) => h.includes(tk));
        if (idx === -1) {
          all = false;
          break;
        }
        score += idx === 0 ? (title.startsWith(tk) ? 4 : 2) : 1;
      }
      if (all) hits.push({ e, score });
    }
    const doubanNum = (d?: string) => {
      const n = parseFloat(d || "");
      return isNaN(n) ? 0 : n;
    };
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        doubanNum(b.e.douban) - doubanNum(a.e.douban) ||
        b.e.mtimeMs - a.e.mtimeMs,
    );
    return hits.map((h) => h.e);
  }

  /** 列表用精简条目：剔除详情专用的大字段（introFull/toc/meta），控制 /api/books 体积 */
  summaries(): Array<Omit<BookEntry, "introFull" | "toc" | "meta">> {
    return this.entries.map(({ introFull: _i, toc: _t, meta: _m, ...rest }) => rest);
  }

  /** 单本详情（含完整简介/目录/meta） */
  find(rel: string): BookEntry | undefined {
    return this.entries.find((e) => e.rel === rel);
  }
}

/** 安全路径解析：结果必须严格位于书库根内（防目录穿越） */
export function safeResolve(rel: string): string | null {
  const rootAbs = path.resolve(LIBRARY_ROOT);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  if (/(^|\/)\.\.($|\/)/.test(rel)) return null;
  return abs;
}
