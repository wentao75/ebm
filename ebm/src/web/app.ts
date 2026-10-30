/** 通用确认对话框（Promise 版，复用底部确认弹窗） */
function confirmAction(opts: { title: string; text: string; hint?: string; okLabel?: string; cancelLabel?: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    ($("#confirmTitle") as HTMLElement).textContent = opts.title;
    ($("#confirmText") as HTMLElement).textContent = opts.text;
    ($("#confirmHint") as HTMLElement).textContent = opts.hint || "";
    const ok = $("#confirmOk") as HTMLButtonElement;
    const cancel = $("#confirmCancel") as HTMLButtonElement;
    ok.textContent = opts.okLabel || "确定";
    cancel.textContent = opts.cancelLabel || "取消";
    $("#confirmMask").classList.remove("hidden");
    const finish = (v: boolean): void => {
      $("#confirmMask").classList.add("hidden");
      ok.onclick = null;
      cancel.onclick = null;
      resolve(v);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
  });
}

async function pushWithFormat(fmt: "orig" | "epub"): Promise<void> {
  const rel = detailRel;
  if (!rel) return;
  const book = allBooks.find((x) => x.rel === rel);
  if (fmt === "epub" && !convertedInfo) {
    const ok = await confirmAction({
      title: "先转换再发送？",
      text: `《${book?.title || rel}》还没有转成 EPUB。是否现在转换，转换完成后自动发送到阅读器？`,
      hint: "转换在服务端进行（文本版几秒；插图多的书可能需要几十秒）",
      okLabel: "开始转换并发送",
      cancelLabel: "取消",
    });
    if (!ok) return;
    toast("正在转换 EPUB…转换完成后会自动发送");
    const id = await convertForSend(rel);
    if (!id) return;
    convertedInfo = { id };
    void loadConvertedForDetail(rel);
  }
  const btn = document.getElementById("dPush") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "📤 发送中…";
  }
  try {
    const body = fmt === "epub" && convertedInfo ? { converted: convertedInfo.id } : { rel };
    const res = await fetch("/api/push/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; bytes?: number; ms?: number; message?: string; error?: string };
    if (res.ok && d.ok) {
      const mb = ((d.bytes || 0) / 1024 / 1024).toFixed(1);
      toast(`已发送到阅读器（${fmt === "epub" ? "EPUB" : "原文件"}）：${book?.title || rel}（${mb}MB · ${((d.ms || 0) / 1000).toFixed(1)}s）${d.message ? " · " + d.message : ""}`);
    } else {
      toast(`发送失败：${d.error || "HTTP " + res.status}`);
      pushStatusCache = null;
    }
  } catch (err) {
    toast(`发送异常：${String(err)}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📤 发送到阅读器";
    }
    closeMenus();
  }
}

/** 为发送而转换：返回转换产物 id（失败返回 null） */
async function convertForSend(rel: string): Promise<string | null> {
  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel }),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; chapters?: number; error?: string };
    if (res.ok && d.ok && d.id) {
      toast(`转换完成（${d.chapters || 0} 章），即将发送…`);
      return d.id;
    }
    toast(`转换失败：${d.error || "HTTP " + res.status}`);
    return null;
  } catch (err) {
    toast(`转换异常：${String(err)}`);
    return null;
  }
}

function closeMenus(): void {
  document.getElementById("dPushMenu")?.classList.add("hidden");
  document.getElementById("dMoreActions")?.classList.add("hidden");
  document.getElementById("dMore")?.setAttribute("aria-expanded", "false");
}

// app.ts —— ebm 前端（原生 TS，无框架；客户端瞬时过滤，805 本毫秒级）
interface Book {
  rel: string;
  title: string;
  author: string;
  category: string;
  ext: string;
  size: number;
  mtimeMs: number;
  douban?: string;
  intro?: string;
  tags?: string[];
  publisher?: string;
  pubDate?: string;
  sourceId?: number;
  dataless?: boolean;
  // 详情接口（/api/book）专用字段
  introFull?: string;
  toc?: string;
  meta?: Record<string, string>;
  /** 元数据来源层（yabook/douban/openlibrary/arxiv…），详情页显示"简介来源" */
  metaSource?: string;
}
/** /api/recommendations 的条目（原始清单：tier2 待定 / tier3 已拒绝） */
interface Reco {
  id: number;
  tier: number;
  title: string;
  author?: string;
  douban?: string;
  folder: string;
  note: string;
  intro?: string;
  category?: string;
  downloaded?: boolean;
}

interface QueuedReco {
  id: number;
  title: string;
  folder: string;
  note: string;
  douban?: string;
}

interface PendingReco {
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


type ShelfName = "reading" | "fav" | "done";
type ShelfKey = "all" | ShelfName;
interface ShelfRecord {
  reading?: boolean; fav?: boolean; done?: boolean; page?: number; ts: number;
}
interface Prefs { tab?: string; shelf?: ShelfKey; cat?: string; autoDl?: boolean }

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error("missing " + sel);
  return el as T;
};

const PREVIEWABLE = new Set(["PDF", "EPUB", "TXT"]);
const PREFS_KEY = "ebm.prefs";
const SHELF_LABEL: Record<ShelfKey, string> = { all: "全部", reading: "📖 在读", fav: "♥ 喜欢", done: "✓ 读完" };
let allBooks: Book[] = [];
let shelfData: Record<string, ShelfRecord> = {};
let activeCat = "全部";
let activeShelf: ShelfKey = "all";
let activeTab = "library";

// ---------- 偏好记忆（每台设备各自，localStorage） ----------
function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Prefs;
  } catch {
    return {};
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ tab: activeTab, shelf: activeShelf, cat: activeCat, autoDl: recoAutoDl }));
  } catch {
    /* 隐私模式下写入失败不影响使用 */
  }
}
function shelfCount(shelf: ShelfName): number {
  return allBooks.reduce((n, b) => n + (shelfData[b.rel]?.[shelf] ? 1 : 0), 0);
}

function fmtSize(n: number): string {
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** 兜底解码：服务端已解过一遍，这里防旧数据/新实体漏网（解码后再转义，安全） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", middot: "\u00b7", bull: "\u2022",
  laquo: "\u00ab", raquo: "\u00bb", times: "\u00d7", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g: string) => {
    if (g.startsWith("#")) {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[g] ?? m;
  });
}
/** 文本净化：先解码实体再转义，避免 &ldquo; 这类字符原样显示 */
function txt(s: string | undefined): string {
  return s ? esc(decodeEntities(s)) : "";
}
function fileUrl(rel: string, disp: "inline" | "attachment"): string {
  return `/api/file?path=${encodeURIComponent(rel)}&disp=${disp}`;
}
function readUrl(b: Book): string {
  return `/read?path=${encodeURIComponent(b.rel)}`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, sticky = false): void {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
  return;
}
function toastHide(): void {
  $("#toast").classList.add("hidden");
}

/** 轮询云端取回状态，就绪（或超时）后 resolve */
async function waitForReady(rel: string, onTick?: (s: string) => void): Promise<boolean> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`/api/materialized?path=${encodeURIComponent(rel)}`);
      const d = await r.json();
      if (d.ready) return true;
      if (d.status === "failed") return false;
      onTick?.("☁️ iCloud 取回中…（首次打开冷门书需等待，时长取决于网速与书的大小）");
    } catch {
      onTick?.("网络波动，继续等待…");
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

function bookCard(b: Book, showDate = false): string {
  const rec = shelfData[b.rel];
  const canRead = PREVIEWABLE.has(b.ext);
  const coverSrc = `/api/cover?path=${encodeURIComponent(b.rel)}&v=${b.mtimeMs}`;
  const initial = esc((b.title || "?").trim().charAt(0).toUpperCase());
  const hue = [...b.rel].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  // 信息行：单行文本（豆瓣 · 分类 · 格式 · 大小 · ☁ 云端），不再堆叠成一排标签
  const info =
    [b.douban ? `豆瓣 ${b.douban}` : "", b.category, `${b.ext} · ${fmtSize(b.size)}`, showDate ? fmtDate(b.mtimeMs) : ""]
      .filter(Boolean)
      .map((s) => esc(s))
      .join(" · ") + (b.dataless ? ` · <span class="cloudmark" title="数据在 iCloud，首次打开需取回">☁ 云端</span>` : "");
  // 状态芯片：只保留真正需要一眼看到的动态状态（绝大多数云端书不再各占一行）
  const chips = rec?.page ? `<div class="chips"><span class="chip progress">读到 P${rec.page}</span></div>` : "";
  // 图标顺序固定为：喜欢 → 在读 → 读完（用户指定，勿随意调整）
  const toggles = (["fav", "reading", "done"] as ShelfName[])
    .map((s) => {
      const label = s === "reading" ? "在读" : s === "fav" ? "喜欢" : "读完";
      const icon = s === "reading" ? "📖" : s === "fav" ? "♥" : "✓";
      return `<button class="sbtn ${rec?.[s] ? "on" : ""}" data-shelf="${s}" title="${label}" aria-pressed="${rec?.[s] ? "true" : "false"}">${icon}</button>`;
    })
    .join("");
  return `<div class="book" data-rel="${esc(b.rel)}" data-dataless="${b.dataless ? 1 : 0}"
    tabindex="0" role="button" title="点击查看完整信息（简介/目录/元数据）">
    <a class="cover" href="${canRead ? readUrl(b) : fileUrl(b.rel, "attachment")}" title="${canRead ? "阅读" : "下载"}">
      <img loading="lazy" src="${coverSrc}" alt=""
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <span class="cover-fb" style="display:none;--h:${hue}">${initial}</span>
    </a>
    <div class="bookbody">
      <div class="bhead">
        <div class="t" title="${txt(b.title)}">${txt(b.title)}</div>
        <div class="shelfbtns">${toggles}</div>
      </div>
      ${b.author ? `<div class="a">${txt(b.author)}</div>` : ""}
      <div class="meta">${info}</div>
      ${chips ? chips : ""}
      ${b.intro ? `<div class="intro">${txt(b.intro)}</div><button class="morelink" data-rel="${esc(b.rel)}">查看完整 ›</button>` : ""}
      <div class="actions">
        ${canRead
          ? `<a class="btn read" href="${readUrl(b)}">${rec?.page ? "▶ 继续阅读" : "📖 阅读"}</a>`
          : `<a class="btn read" disabled title="该格式暂不支持在线预览，请下载">预览不可用</a>`}
        <a class="btn primary dl dl-link" href="${fileUrl(b.rel, "attachment")}" download="${esc(b.title + "." + b.ext.toLowerCase())}">⬇ 下载</a>
      </div>
    </div>
  </div>`;
}

function renderCats(): void {
  const counts = new Map<string, number>();
  for (const b of allBooks) counts.set(b.category, (counts.get(b.category) || 0) + 1);
  const cats = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "zh-Hans-CN"));
  const html = [`<div class="cat ${activeCat === "全部" ? "active" : ""}" data-cat="全部"><span>全部</span><span class="n">${allBooks.length}</span></div>`]
    .concat(cats.map(([name, n]) =>
      `<div class="cat ${activeCat === name ? "active" : ""}" data-cat="${esc(name)}"><span>${esc(name)}</span><span class="n">${n}</span></div>`))
    .join("");
  $("#cats").innerHTML = html;
  $("#cats").querySelectorAll(".cat").forEach((el) => {
    el.addEventListener("click", () => {
      activeCat = (el as HTMLElement).dataset.cat || "全部";
      savePrefs();
      renderCats();
      renderActive();
    });
  });
}

/** 我的书架分组（在读/喜欢/读完）；与分类筛选叠加生效 */
function renderShelves(): void {
  const keys: ShelfKey[] = ["all", "reading", "fav", "done"];
  $("#shelves").innerHTML = keys
    .map((k) => {
      const n = k === "all" ? allBooks.length : shelfCount(k);
      return `<div class="cat shelf ${activeShelf === k ? "active" : ""}" data-shelf="${k}"><span>${SHELF_LABEL[k]}</span><span class="n">${n}</span></div>`;
    })
    .join("");
  $("#shelves").querySelectorAll(".cat").forEach((el) => {
    el.addEventListener("click", () => {
      const k = (el as HTMLElement).dataset.shelf as ShelfKey;
      activeShelf = keys.includes(k) ? k : "all";
      savePrefs();
      renderShelves();
      renderActive();
    });
  });
}

/** 书架标记切换（乐观更新 + 失败还原；不重建整个列表，避免打断分屏与滚动位置） */
async function toggleShelf(rel: string, shelf: ShelfName): Promise<void> {
  const before = shelfData[rel] ? { ...shelfData[rel] } : undefined;
  const on = !shelfData[rel]?.[shelf];
  const rec: ShelfRecord = { ...(shelfData[rel] || { ts: Date.now() }), ts: Date.now() };
  if (on) rec[shelf] = true;
  else delete rec[shelf];
  if (shelf === "done" && on) delete rec.reading; // 与后端一致的本地镜像
  shelfData[rel] = rec;
  applyShelfUi(rel);
  try {
    const res = await fetch("/api/shelves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel, shelf, value: on }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.record) shelfData[rel] = data.record as ShelfRecord;
    else delete shelfData[rel];
    applyShelfUi(rel);
  } catch (err) {
    if (before) shelfData[rel] = before;
    else delete shelfData[rel];
    applyShelfUi(rel);
    toast(`书架操作失败（${String(err)}），已还原`);
    return;
  }
  // 正筛选该书架时，取消标记后卡片应离开列表 → 需要重排
  if (activeShelf !== "all" && shelf === activeShelf) renderActive();
}

function currentFilter(): Book[] {
  const q = ($("#search") as HTMLInputElement).value.trim().toLowerCase();
  const searching = q.length > 0;
  let list = allBooks;
  const shelf = activeShelf; // 取本地副本，便于类型收窄
  // 搜索优先全库：有搜索词时忽略书架/分类筛选，避免"筛选叠加后搜不到书"的陷阱
  // （筛选状态本身不丢，清空搜索即恢复）
  if (!searching) {
    if (shelf !== "all") list = list.filter((b) => shelfData[b.rel]?.[shelf]);
    if (activeCat !== "全部") list = list.filter((b) => b.category === activeCat);
  }
  if (searching) {
    const tokens = q.split(/\s+/);
    list = list.filter((b) => {
      const hay = [b.title, b.author || "", b.category, (b.tags || []).join(" "), b.intro || "", b.douban || ""].join(" ").toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  if (activeTab === "recent") {
    list = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 60);
  }
  // 在读架按"最近打开"倒序，最可能接着读的排最前
  if (!searching && activeShelf === "reading") {
    list = [...list].sort((a, b) => (shelfData[b.rel]?.ts || 0) - (shelfData[a.rel]?.ts || 0));
  }
  return list;
}

/** 搜索时的提示条：说明已按全库搜索（忽略当前书架/分类筛选） */
function renderSearchNotice(): void {
  const el = document.getElementById("searchNotice");
  if (!el) return;
  const q = ($("#search") as HTMLInputElement).value.trim();
  const filtered = activeShelf !== "all" || activeCat !== "全部";
  if (!q || !filtered) {
    el.classList.add("hidden");
    return;
  }
  const parts: string[] = [];
  if (activeShelf !== "all") parts.push(`书架「${SHELF_LABEL[activeShelf]}」`);
  if (activeCat !== "全部") parts.push(`分类「${activeCat}」`);
  el.textContent = `🔍 已按全库搜索（暂时忽略${parts.join(" 与 ")}筛选，清空搜索即恢复）`;
  el.classList.remove("hidden");
}

/** 增量渲染：每屏先渲染 120 张，点击"显示更多"再追加（书库已过千本，iPad 上全量渲染会卡） */
const PAGE_SIZE = 120;
const shown = { library: PAGE_SIZE, recent: PAGE_SIZE };

function gridOf(key: "library" | "recent"): HTMLElement {
  return key === "recent" ? $("#gridRecent") : $("#grid");
}
function moreOf(key: "library" | "recent"): HTMLElement {
  return key === "recent" ? $("#moreRecent") : $("#moreLibrary");
}
function updateMore(key: "library" | "recent", total: number): void {
  const el = moreOf(key);
  const remaining = total - shown[key];
  el.classList.toggle("hidden", remaining <= 0);
  el.textContent = `显示更多（还有 ${remaining} 本）`;
}
function renderList(key: "library" | "recent", list: Book[]): void {
  shown[key] = Math.min(PAGE_SIZE, list.length);
  gridOf(key).innerHTML = list.slice(0, shown[key]).map((b) => bookCard(b, key === "recent")).join("");
  updateMore(key, list.length);
}
/** 追加下一屏（不重建已有卡片，避免滚动位置跳动） */
function showMore(): void {
  const key: "library" | "recent" = activeTab === "recent" ? "recent" : "library";
  const list = currentFilter();
  const next = list.slice(shown[key], shown[key] + PAGE_SIZE);
  if (!next.length) return;
  gridOf(key).insertAdjacentHTML("beforeend", next.map((b) => bookCard(b, key === "recent")).join(""));
  shown[key] += next.length;
  updateMore(key, list.length);
}

/**
 * 自动加载（无限滚动）：滚动到接近底部时自动追加下一屏，无需点击。
 * 按钮保留作为兜底（键盘/无障碍/自动加载未触发时手动点）。
 */
function setupAutoLoad(): void {
  const io = new IntersectionObserver(
    (entries) => {
      const key: "library" | "recent" = activeTab === "recent" ? "recent" : "library";
      const target = moreOf(key);
      // 仅当前可见视图的按钮能触发（隐藏视图的元素不会 intersect）
      if (entries.some((e) => e.isIntersecting && e.target === target)) showMore();
    },
    { rootMargin: "600px 0px" },
  );
  io.observe($("#moreLibrary"));
  io.observe($("#moreRecent"));
}

function renderLibrary(): void {
  const list = currentFilter();
  renderList("library", list);
  $("#empty").classList.toggle("hidden", list.length > 0);
  renderSearchNotice();
  $("#stats").textContent = list.length === allBooks.length
    ? `${allBooks.length} 本`
    : `${list.length} / ${allBooks.length} 本`;
}

function renderRecent(): void {
  renderList("recent", currentFilter());
  renderSearchNotice();
}

/** 重绘当前视图（书架/分类/搜索变化都走这里） */
function renderActive(): void {
  if (activeTab === "recent") renderRecent();
  else if (activeTab === "library") renderLibrary();
}

// ---------- 书目元数据补全（见 docs/metadata-enrichment.md）----------
interface MetaStatus {
  running: boolean;
  externalMeta?: boolean;
  runningJob: string | null;
  total: number;
  withIntro: number;
  missing: number;
  bySource: Record<string, number>;
  partial: number;
  failed: number;
  lastRunAt: string | null;
  missingRels: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  yabook: "雅书", douban: "豆瓣", openlibrary: "OpenLibrary",
  arxiv: "arXiv", arxiv_search: "arXiv", googlebooks: "Google Books",
};

async function fetchMetaStatus(): Promise<MetaStatus | null> {
  try {
    const res = await fetch("/api/metadata/status");
    if (!res.ok) return null;
    return (await res.json()) as MetaStatus;
  } catch {
    return null;
  }
}

function renderMetaStatus(st: MetaStatus | null): void {
  const stat = document.getElementById("metaStat");
  const src = document.getElementById("metaSrc");
  const notice = document.getElementById("metaNotice");
  if (!stat || !src || !notice) return;
  if (!st) {
    stat.textContent = "元数据状态不可用（管道未就绪？）";
    src.textContent = "";
    notice.classList.add("hidden");
    return;
  }
  const pct = st.total ? Math.round((100 * st.withIntro) / st.total) : 0;
  stat.textContent = `${st.withIntro} / ${st.total} 本有简介（${pct}%）${st.running ? ` · 任务运行中（${st.runningJob || ""}）` : ""}`;
  const extWarn = document.getElementById("metaHint");
  if (extWarn) {
    extWarn.textContent = st.externalMeta
      ? "⚠ 后台已有补全进程在运行（每日巡检或手动启动）——请等它结束，重复触发会互相覆盖数据"
      : "补简介约 5 本/分钟（外部源限速），跑完自动刷新书库";
  }
  const parts = Object.entries(st.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${SOURCE_LABEL[k] || k} ${n}`);
  src.textContent = [
    parts.length ? `来源：${parts.join(" · ")}` : "",
    st.partial ? `仅补到作者/年份 ${st.partial} 本` : "",
    st.failed ? `多源未命中 ${st.failed} 本` : "",
    st.lastRunAt ? `上次补简介：${st.lastRunAt.replace("T", " ")}` : "",
  ].filter(Boolean).join("　|　");

  // 「检测到新书」提示：由用户点击触发，不在 fs.watch 里自动跑。
  // 注意口径：missingRels = 还没进入元数据补全目录的书，**不等于**没有简介
  //（雅书简介会按帖子自动匹配填入，这里据实说明，避免"明明有简介却说没有"）
  const pendingRels = st.missingRels || [];
  const noIntro = pendingRels.filter((rel) => !allBooks.find((b) => b.rel === rel)?.intro).length;
  if (pendingRels.length > 0) {
    const detail = noIntro
      ? `（其中 <b>${noIntro}</b> 本还没有简介）`
      : "（简介已按网站帖子自动填入）";
    notice.innerHTML = `📥 检测到 <b>${pendingRels.length}</b> 本新书尚未补全元数据${detail}　<a href="#" id="metaNoticeRun">立即补全</a>　<a href="#" id="metaNoticeOpen">查看面板</a>`;
    notice.classList.remove("hidden");
    document.getElementById("metaNoticeRun")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openMeta(true);
    });
    document.getElementById("metaNoticeOpen")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openMeta(false);
    });
  } else {
    notice.classList.add("hidden");
    notice.innerHTML = "";
  }
}

async function refreshMetaNotice(): Promise<void> {
  const st = await fetchMetaStatus();
  metaCache = st;
  renderMetaStatus(st);
}

let metaCache: MetaStatus | null = null;
let metaBusy = false;

async function openMeta(runAll = false): Promise<void> {
  $("#metaMask").classList.remove("hidden");
  renderMetaStatus(metaCache || (await fetchMetaStatus()));
  void loadGaps();
  if (runAll) void runMetaTasks(["build", "enrich", "catalog"]);
}

function closeMeta(): void {
  $("#metaMask").classList.add("hidden");
}

/** 触发元数据任务：流式日志 + 完成后刷新书库（与一键下载同构） */
async function runMetaTasks(tasks: string[]): Promise<void> {
  if (metaBusy) {
    toast("已有任务在执行中，请稍候");
    return;
  }
  metaBusy = true;
  const logEl = document.getElementById("metaLog");
  if (logEl) {
    logEl.classList.remove("hidden");
    logEl.textContent = "";
  }
  const limit = Number((document.getElementById("metaLimit") as HTMLInputElement)?.value || 80);
  const buttons = ["metaBuild", "metaEnrich", "metaCatalog", "metaAll"].map((id) => document.getElementById(id) as HTMLButtonElement);
  buttons.forEach((b) => b && (b.disabled = true));
  try {
    const res = await fetch("/api/metadata/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks, limit }),
    });
    if (!res.ok || !res.body) {
      const msg = await res.text();
      if (logEl) logEl.textContent += `[HTTP ${res.status}] ${msg}
`;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (logEl) {
        logEl.textContent += dec.decode(value, { stream: true });
        logEl.scrollTop = logEl.scrollHeight;
      }
    }
    toast("元数据任务完成，正在刷新书库…");
  } catch (err) {
    if (logEl) logEl.textContent += `[error] ${String(err)}
`;
  } finally {
    metaBusy = false;
    buttons.forEach((b) => b && (b.disabled = false));
    // 重新拉取书库（新简介生效）+ 状态
    try {
      const books = await (await fetch("/api/books")).json();
      allBooks = books.books || allBooks;
      renderCats();
      renderActive();
    } catch {
      /* ignore */
    }
    await refreshMetaNotice();
    await loadGaps();
    toastHide();
  }
}

// ---------- 编辑信息：书名 / 文件名 / 元数据（v1.7.3）----------
interface EditInitial {
  rel: string;
  title: string;
  author: string;
  publisher: string;
  pubDate: string;
  translator: string;
  pages: string;
  isbn: string;
  douban: string;
  tags: string;
  intro: string;
  toc: string;
}
let editState: { initial: EditInitial; rel: string } | null = null;

const EDIT_FIELDS: Array<[string, string]> = [
  ["title", "edTitle"], ["author", "edAuthor"], ["publisher", "edPublisher"],
  ["year", "edYear"], ["translator", "edTranslator"], ["pages", "edPages"],
  ["isbn", "edIsbn"], ["douban", "edDouban"], ["tags", "edTags"],
  ["intro", "edIntro"], ["toc", "edToc"],
];

function editEl(id: string): HTMLInputElement | HTMLTextAreaElement | null {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
}

/** 从详情页进入编辑：按需拉取全量详情（完整简介/目录/meta） */
async function openEditFromDetail(): Promise<void> {
  if (!detailRel) return;
  try {
    const d = await (await fetch(`/api/book?path=${encodeURIComponent(detailRel)}`)).json();
    if (d.book) openEdit(d.book);
  } catch {
    /* ignore */
  }
}

/** 打开编辑弹层（从详情页带入当前值与文件名） */
function openEdit(book: Book): void {
  const rel = book.rel;
  const name = rel.split("/").pop() || rel;
  const meta = book.meta || {};
  const initial: EditInitial = {
    rel,
    title: decodeEntities(book.title || ""),
    author: decodeEntities(book.author || ""),
    publisher: decodeEntities(book.publisher || ""),
    pubDate: decodeEntities(book.pubDate || ""),
    translator: decodeEntities(meta["译者"] || ""),
    pages: decodeEntities(meta["页数"] || ""),
    isbn: decodeEntities(meta["ISBN"] || ""),
    douban: decodeEntities(book.douban || ""),
    tags: (book.tags || []).join(", "),
    intro: decodeEntities(book.introFull || book.intro || ""),
    toc: decodeEntities(book.toc || ""),
  };
  editState = { initial, rel };
  editEl("edTitle")!.value = initial.title;
  editEl("edAuthor")!.value = initial.author;
  editEl("edPublisher")!.value = initial.publisher;
  editEl("edYear")!.value = initial.pubDate;
  editEl("edTranslator")!.value = initial.translator;
  editEl("edPages")!.value = initial.pages;
  editEl("edIsbn")!.value = initial.isbn;
  editEl("edDouban")!.value = initial.douban;
  editEl("edTags")!.value = initial.tags;
  editEl("edIntro")!.value = initial.intro;
  editEl("edToc")!.value = initial.toc;
  editEl("edName")!.value = name;
  (document.getElementById("edRename") as HTMLInputElement).checked = false;
  const prev = document.getElementById("edPreview");
  if (prev) prev.textContent = "";
  const hint = document.getElementById("edHint");
  if (hint) hint.textContent = "";
  document.getElementById("edConfirm")?.classList.add("hidden");
  $("#editMask").classList.remove("hidden");
  void refreshUndoButton(rel);
}

function closeEdit(): void {
  $("#editMask").classList.add("hidden");
}

/** 清理建议：拿服务端规则算，展示"旧 → 新"与命中的规则 */
async function previewCleanName(): Promise<void> {
  if (!editState) return;
  const prev = document.getElementById("edPreview")!;
  prev.innerHTML = `<span class="muted">正在计算…</span>`;
  try {
    const d = await (await fetch(`/api/book/rename/suggest?path=${encodeURIComponent(editState.rel)}`)).json();
    if (!d.ok) {
      prev.innerHTML = `<span class="warn">${txt(String(d.error || "建议失败"))}</span>`;
      return;
    }
    editEl("edName")!.value = d.suggested;
    const rules = (d.rules || []) as Array<{ label: string }>;
    const notes = (d.notes || []) as string[];
    prev.innerHTML =
      `<div>${txt(d.current)}<span class="arrow">→</span><span class="${d.suggested === d.current ? "" : "ok"}">${txt(d.suggested)}</span></div>` +
      (rules.length ? `<div class="muted">规则：${rules.map((r) => txt(r.label)).join(" · ")}</div>` : `<div class="muted">没有可清理的内容</div>`) +
      (notes.length ? `<div class="muted">提示：${notes.map((n) => txt(n)).join(" · ")}</div>` : "") +
      (d.blocked ? `<div class="warn">注意：${txt(String(d.blocked))}</div>` : "");
  } catch (err) {
    prev.innerHTML = `<span class="warn">${txt(String(err))}</span>`;
  }
}

/** 书名建议：沿用同一套清理规则，只取书名部分 */
async function suggestTitle(): Promise<void> {
  if (!editState) return;
  try {
    const d = await (await fetch(`/api/book/rename/suggest?path=${encodeURIComponent(editState.rel)}`)).json();
    if (d.ok && d.title) {
      editEl("edTitle")!.value = d.title;
    }
  } catch {
    /* ignore */
  }
}

async function refreshUndoButton(rel: string): Promise<void> {
  const btn = document.getElementById("edUndo") as HTMLButtonElement | null;
  if (!btn) return;
  try {
    const d = await (await fetch(`/api/book/rename/history?path=${encodeURIComponent(rel)}`)).json();
    btn.disabled = !d.undoable;
    btn.title = d.undoable ? `可还原为：${(d.last?.old || "").split("/").pop()}` : "没有可撤销的重命名";
  } catch {
    btn.disabled = true;
  }
}

/** 保存：只提交改动过的字段；**物理改名必须二次确认**（防手快误改） */
async function saveEdit(confirmed = false): Promise<void> {
  if (!editState) return;
  const { initial, rel } = editState;
  const cur = (id: string): string => (editEl(id)?.value || "").trim();
  const fields: Record<string, string> = {};
  // 书名：改了才提交；清空则请求清除覆盖（回落自动解析）
  const titleNow = cur("edTitle");
  let clearTitle = false;
  if (titleNow !== initial.title.trim()) {
    if (titleNow) fields.title = titleNow;
    else clearTitle = true;
  }
  if (cur("edAuthor") !== initial.author) fields.author = cur("edAuthor");
  if (cur("edPublisher") !== initial.publisher) fields.publisher = cur("edPublisher");
  if (cur("edYear") !== initial.pubDate) fields.year = cur("edYear");
  if (cur("edTranslator") !== initial.translator) fields.translator = cur("edTranslator");
  if (cur("edPages") !== initial.pages) fields.pages = cur("edPages");
  if (cur("edIsbn") !== initial.isbn) fields.isbn = cur("edIsbn");
  if (cur("edDouban") !== initial.douban) fields.douban = cur("edDouban");
  if (cur("edTags") !== initial.tags) fields.tags = cur("edTags");
  if (cur("edIntro") !== initial.intro) fields.intro = cur("edIntro");
  if (cur("edToc") !== initial.toc) fields.toc = cur("edToc");

  const nameNow = cur("edName");
  const syncRename = (document.getElementById("edRename") as HTMLInputElement).checked;
  const currentName = rel.split("/").pop() || rel;
  let renameTo = "";
  if (nameNow && nameNow !== currentName) renameTo = nameNow;
  if (syncRename && titleNow && titleNow !== currentName) renameTo = titleNow;

  const hint = document.getElementById("edHint")!;
  // 需要改物理文件时先亮出"旧 → 新"让用户确认一次，避免点快了改错名
  if (renameTo && !confirmed) {
    const bar = document.getElementById("edConfirm")!;
    bar.innerHTML = `将重命名文件：<b>${txt(currentName)}</b><span class="arrow">→</span><b>${txt(renameTo)}</b>
      <button class="btn primary tiny" id="edConfirmYes">确认重命名</button>
      <button class="btn tiny" id="edConfirmNo">取消</button>`;
    bar.classList.remove("hidden");
    document.getElementById("edConfirmYes")?.addEventListener("click", () => void saveEdit(true));
    document.getElementById("edConfirmNo")?.addEventListener("click", () => bar.classList.add("hidden"));
    hint.textContent = "（文件名有改动，请先确认上面的重命名）";
    return;
  }
  const bar = document.getElementById("edConfirm");
  if (bar) bar.classList.add("hidden");
  hint.textContent = "保存中…";
  let newRel = rel;
  try {
    // 先重命名（后续覆盖写在新路径上）
    if (renameTo) {
      const res = await fetch("/api/book/rename", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rel, newName: renameTo }),
      });
      const d = await res.json();
      if (!res.ok) {
        hint.innerHTML = `<span class="warn">重命名失败：${txt(String(d.error))}</span>`;
        return;
      }
      newRel = d.newRel as string;
      if (d.extForced) toast("已按原扩展名重命名");
    }
    if (Object.keys(fields).length || clearTitle) {
      const res = await fetch("/api/metadata/override", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rel: newRel, fields, clear: clearTitle ? ["title"] : [] }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        hint.innerHTML = `<span class="warn">保存失败：${txt(String(d.error || res.status))}</span>`;
        return;
      }
    }
    toast(renameTo || Object.keys(fields).length ? "已保存修改" : "没有需要保存的改动");
    closeEdit();
    closeDetail();
    await refreshBooks();
  } catch (err) {
    hint.innerHTML = `<span class="warn">异常：${txt(String(err))}</span>`;
  }
}

/** 撤销该书最近一次重命名（文件与数据一起还原） */
async function undoRename(rel: string): Promise<void> {
  const hint = document.getElementById("edHint")!;
  hint.textContent = "正在还原…";
  try {
    const res = await fetch("/api/book/rename/undo", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel }),
    });
    const d = await res.json();
    if (!res.ok) {
      hint.innerHTML = `<span class="warn">${txt(String(d.error))}</span>`;
      return;
    }
    toast("已还原文件名");
    closeEdit();
    closeDetail();
    await refreshBooks();
  } catch (err) {
    hint.innerHTML = `<span class="warn">${txt(String(err))}</span>`;
  }
}

/** 重新拉取书库并刷新界面（编辑后统一走这里） */
async function refreshBooks(): Promise<void> {
  try {
    const d = await (await fetch("/api/books")).json();
    if (d.books) allBooks = d.books;
    renderCats();
    renderActive();
  } catch {
    /* ignore */
  }
  await refreshMetaNotice();
  // 新书入库后：回到页面 / 定时轮询也能看到（无需刷新浏览器）
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshBooksIfFresh("visible");
  });
  window.setInterval(() => {
    if (!document.hidden) void refreshBooksIfFresh("poll");
  }, 30_000);
}

// ---------- 待补清单 + 人工覆盖（复用管道匹配逻辑，只写 ebm 自己的覆盖文件）----------
interface Gap {
  rel: string;
  title: string;
  author: string;
  reason: "near_miss" | "low_score" | "no_candidate" | "partial" | "throttled" | "no_entry" | "other";
  score: number | null;
  candidates: string[];
  note: string;
  overridden: boolean;
}
const GAP_LABEL: Record<string, string> = {
  near_miss: "差一点命中", low_score: "候选分低", no_candidate: "无候选",
  partial: "仅作者/年份", throttled: "被限流", no_entry: "未登记", other: "其它",
};
let gapItems: Gap[] = [];

async function loadGaps(): Promise<void> {
  const summary = document.getElementById("gapSummary");
  const list = document.getElementById("gapList");
  if (!summary || !list) return;
  summary.textContent = "待补清单加载中…";
  try {
    const d = (await (await fetch("/api/metadata/gaps")).json()) as {
      total: number; byReason: Record<string, number>; overrides: number; items: Gap[];
    };
    gapItems = d.items || [];
    const parts = Object.entries(d.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${GAP_LABEL[k] || k} ${n}`);
    summary.textContent = `待补 ${d.total} 本：${parts.join(" · ")}${d.overrides ? `　|　人工覆盖 ${d.overrides} 条` : ""}`;
    renderGaps(list);
  } catch (err) {
    summary.textContent = `清单加载失败：${String(err)}`;
  }
}

function gapReasonBadge(g: Gap): string {
  const score = g.score ? ` ${g.score}分` : "";
  return `<span class="gapreason r-${g.reason}">${GAP_LABEL[g.reason] || g.reason}${score}</span>`;
}

function renderGaps(list: HTMLElement): void {
  if (!gapItems.length) {
    list.innerHTML = `<div class="muted" style="padding:8px 4px">暂无待补书目 🎉</div>`;
    return;
  }
  list.innerHTML = gapItems
    .map(
      (g) => `<div class="gaprow" data-rel="${esc(g.rel)}">
      <div class="gaptop">
        ${gapReasonBadge(g)}
        <span class="gaptitle" title="${esc(g.rel)}">${txt(g.title)}</span>
        ${g.candidates.length ? `<span class="gapcandhint" title="豆瓣返回的候选">候选：${txt(g.candidates.slice(0, 2).join("、"))}</span>` : ""}
        <span class="gapacts">
          <button class="btn tiny gapFind">查候选</button>
          <button class="btn tiny gapManual">手动补</button>
          <button class="btn tiny gapUndo">撤销覆盖</button>
        </span>
      </div>
      <div class="gapdetail hidden"></div>
    </div>`,
    )
    .join("");
}

interface YabookCand {
  id: number; title: string; score: number | null; introLen: number;
  hasToc: boolean; cached: boolean; from: "score" | "map";
}

/** 查候选 → 同时列出**雅书（L1）**与豆瓣候选；雅书帖来自书库自己的下载记录/缓存，最可靠 */
async function gapFindCandidates(row: HTMLElement, g: Gap): Promise<void> {
  const box = row.querySelector(".gapdetail") as HTMLElement;
  box.classList.remove("hidden");
  box.innerHTML = `<div class="muted">正在查候选（雅书本机匹配 + 豆瓣，约 3~10 秒）…</div>`;
  try {
    const res = await fetch("/api/metadata/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel: g.rel }),
    });
    const d = await res.json();
    if (!res.ok) {
      box.innerHTML = `<div class="gapwarn">查询失败：${txt(String(d.error || res.status))}${d.log ? `<br><span class="muted">${txt(String(d.log).slice(0, 160))}</span>` : ""}</div>`;
      return;
    }
    const yb = (d.yabook || []) as YabookCand[];
    const top = (d.top || []) as Array<{ id: string; title: string; author?: string; year?: string }>;
    const seen = new Set<string>();
    const uniq = top.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));

    const ybHtml = yb.length
      ? yb
          .map((c) => {
            const how = c.from === "map" ? "书库下载记录里的雅书 id" : `标题相似度 ${c.score} 分`;
            const body = c.cached
              ? `已缓存：简介 ${c.introLen} 字${c.hasToc ? " · 有目录" : ""}`
              : "详情未缓存，采纳时现场抓取（约 2~5 秒）";
            return `<div class="gapcand">
              <span class="gapsrc yb">雅书</span>
              <span class="gapcandtitle">${txt(c.title)}</span>
              <span class="muted">${txt(how)} · ${txt(body)} · 帖 ${c.id}</span>
              <button class="btn tiny primary gapAdoptYb" data-id="${c.id}">采用</button>
            </div>`;
          })
          .join("")
      : `<div class="muted">雅书没有匹配到帖子（本地缓存与下载记录里都没有）</div>`;

    const dbHtml = uniq.length
      ? uniq
          .map(
            (c) => `<div class="gapcand">
              <span class="gapsrc db">豆瓣</span>
              <span class="gapcandtitle">${txt(c.title || "")}</span>
              <span class="muted">${txt(c.author || "")} ${txt(c.year || "")} · id ${esc(c.id)}</span>
              <button class="btn tiny gapAdopt" data-id="${esc(c.id)}" data-score="${d.score ?? 0}">采用</button>
            </div>`,
          )
          .join("")
      : `<div class="muted">豆瓣无候选（这本书可能不在豆瓣）</div>`;

    box.innerHTML =
      `<div class="gapwarn">自动匹配门槛：雅书按标题相似度、豆瓣 88 分（有作者佐证 75 分）。**请人工确认是同一本书再采用**：</div>
       <div class="gapgroup">雅书（L1，来自书库下载记录/缓存）</div>${ybHtml}
       <div class="gapgroup">豆瓣（匹配分 ${d.score ?? 0}）</div>${dbHtml}`;
    box.querySelectorAll(".gapAdoptYb").forEach((btn) =>
      btn.addEventListener("click", () =>
        void adoptYabook(g, (btn as HTMLElement).dataset.id || "", box),
      ),
    );
    box.querySelectorAll(".gapAdopt").forEach((btn) =>
      btn.addEventListener("click", () =>
        void adoptCandidate(g, (btn as HTMLElement).dataset.id || "", Number((btn as HTMLElement).dataset.score || 0), box),
      ),
    );
  } catch (err) {
    box.innerHTML = `<div class="gapwarn">查询异常：${txt(String(err))}</div>`;
  }
}

/** 采纳雅书帖：详情未缓存时服务端会现场抓取（约 2~5 秒） */
async function adoptYabook(g: Gap, yabookId: string, box: HTMLElement): Promise<void> {
  box.innerHTML = `<div class="muted">正在读取/抓取雅书帖 ${yabookId} 并写入覆盖…</div>`;
  try {
    const res = await fetch("/api/metadata/adopt-yabook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel: g.rel, yabookId }),
    });
    const d = await res.json();
    if (!res.ok) {
      box.innerHTML = `<div class="gapwarn">采纳失败：${txt(String(d.error || res.status))}</div>`;
      return;
    }
    toast(`已采纳雅书帖 ${yabookId} 的信息`);
    await afterMetaChange();
  } catch (err) {
    box.innerHTML = `<div class="gapwarn">异常：${txt(String(err))}</div>`;
  }
}

async function adoptCandidate(g: Gap, doubanId: string, score: number, box: HTMLElement): Promise<void> {
  box.innerHTML = `<div class="muted">正在抓取豆瓣详情并写入覆盖…</div>`;
  try {
    const res = await fetch("/api/metadata/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel: g.rel, doubanId, score }),
    });
    const d = await res.json();
    if (!res.ok) {
      box.innerHTML = `<div class="gapwarn">采纳失败：${txt(String(d.error || res.status))}</div>`;
      return;
    }
    toast(`已采纳「${g.title}」的豆瓣信息`);
    await afterMetaChange();
  } catch (err) {
    box.innerHTML = `<div class="gapwarn">异常：${txt(String(err))}</div>`;
  }
}

/** 手动填写（部分字段即可） */
function gapManualForm(row: HTMLElement, g: Gap): void {
  const box = row.querySelector(".gapdetail") as HTMLElement;
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="gapform">
      <textarea class="gapintro" rows="4" placeholder="内容简介（可粘贴）"></textarea>
      <div class="gapfields">
        <input class="gf" data-k="author" placeholder="作者" />
        <input class="gf" data-k="publisher" placeholder="出版社" />
        <input class="gf" data-k="year" placeholder="出版日期" />
        <input class="gf" data-k="douban" placeholder="豆瓣评分" />
        <input class="gf" data-k="pages" placeholder="页数" />
        <input class="gf" data-k="translator" placeholder="译者" />
        <input class="gf" data-k="isbn" placeholder="ISBN" />
        <input class="gf" data-k="toc" placeholder="目录（可留空）" />
      </div>
      <div class="gapformacts">
        <button class="btn primary gapSave">保存覆盖</button>
        <span class="muted">只填你确定的字段；保存后立即生效，可随时「撤销覆盖」</span>
      </div>
    </div>`;
  box.querySelector(".gapSave")?.addEventListener("click", async () => {
    const fields: Record<string, string> = {};
    const intro = (box.querySelector(".gapintro") as HTMLTextAreaElement)?.value.trim();
    if (intro) fields.intro = intro;
    box.querySelectorAll<HTMLInputElement>(".gf").forEach((i) => {
      if (i.value.trim()) fields[i.dataset.k || ""] = i.value.trim();
    });
    if (!Object.keys(fields).length) {
      toast("至少填写一个字段");
      return;
    }
    const res = await fetch("/api/metadata/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel: g.rel, fields }),
    });
    if (res.ok) {
      toast(`已保存「${g.title}」的人工覆盖`);
      await afterMetaChange();
    } else {
      const d = await res.json().catch(() => ({}));
      toast(`保存失败：${String(d.error || res.status)}`);
    }
  });
}

async function gapUndo(g: Gap): Promise<void> {
  const res = await fetch(`/api/metadata/override?path=${encodeURIComponent(g.rel)}`, { method: "DELETE" });
  if (res.ok) {
    toast("已撤销人工覆盖");
    await afterMetaChange();
  } else {
    toast("撤销失败");
  }
}

/** 覆盖变更后：重拉书库（新简介立即生效）+ 重载清单与状态 */
async function afterMetaChange(): Promise<void> {
  try {
    const books = await (await fetch("/api/books")).json();
    allBooks = books.books || allBooks;
    renderCats();
    renderActive();
  } catch {
    /* ignore */
  }
  await loadGaps();
  await refreshMetaNotice();
}

// ---------- 图书详情（点击卡片打开；完整简介/目录/元数据按需拉取）----------
let detailRel = "";

/**
 * 目录整理：源数据是"零换行"的压平长字符串（433 本全部如此），这里还原成一行一条目。
 * 支持四种形态：第N章/节/回/部/篇/卷、Part N.、NN. / NN、 编号、条目尾页码（_0072 / 章节名1）
 */
function formatToc(raw: string): string[] {
  let s = raw
    .replace(/浏览器不支持脚本[！!]?/g, "")
    .replace(/内容\s*提要/g, "内容提要")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return [];
  if (raw.includes("\n")) return raw.split(/\n+/).map((t) => t.trim()).filter(Boolean);
  // 页锚 _0072 → " · 72"，更易读
  s = s.replace(/_(\d+)/g, (_m, d: string) => ` · ${Number(d)}`);
  // ① 第N章/节/卷…  ② 卷N（无"第"字，如"卷一 唐词"）  ③ 常见标题词  ④ Part N.  ⑤ 编号条目  ⑥ 页锚 " / 12"
  s = s
    .replace(/(?<!^)\s*(?=第\s*[0-9一二三四五六七八九十百千零〇]{1,6}\s*[章节目回部篇卷集讲])/g, "\n")
    .replace(/(?<!^)\s*(?=卷\s*[0-9一二三四五六七八九十百千零〇]{1,4}(?![0-9]))/g, "\n")
    .replace(/(?<!^)\s*(?=(?:内容提要|内容简介|前言|序言|自序|后记|编后记|附录|跋)(?![\u4e00-\u9fa5]))/g, "\n")
    .replace(/(?<!^)\s*(?=Part\s*\d+)/gi, "\n")
    // 编号条目（01. / 2、）：前一位不能是数字，否则会把 "01." 从中间的 1 处切开
    .replace(/(?<!^)(?<!\d)\s*(?=\d{1,3}\s*[.、]\s*\S)/g, "\n")
    // 页锚 " / 12" 之后断行（如：第一章 … / 9“鹰派”的发迹史 / 10变味的“整肃”）
    .replace(/\s*\/\s*\d{1,4}\s*/g, (m) => `${m.trimEnd()}\n`);
  let lines = s.split("\n").map((t) => t.trim()).filter(Boolean);
  // 仍像一整段 → 用"条目尾页码"启发式切分（如：引子 机器人的声明1 …事茶” · 72 蓬加星…3）
  if (lines.length <= 2 && lines.join(" ").length > 60) {
    const out: string[] = [];
    let cur: string[] = [];
    for (const tk of lines.join(" ").split(" ")) {
      if (!tk) continue;
      cur.push(tk);
      if (/\d$/.test(tk) || /·\s*\d+$/.test(tk)) {
        out.push(cur.join(" "));
        cur = [];
      }
    }
    if (cur.length) out.push(cur.join(" "));
    if (out.length > lines.length) lines = out;
  }
  return lines;
}

/** 目录若存在超长条目（正常条目 10-40 字），说明源数据没有分隔符，如实说明 */
function toggleTocHint(lines: string[]): void {
  const el = document.getElementById("dTocHint");
  if (!el) return;
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  el.classList.toggle("hidden", longest <= 120);
}

function closeDetail(): void {  $("#detailMask").classList.add("hidden");
  detailRel = "";
}

/** 只更新某本书的卡片按钮与侧栏计数，避免整列表重排（不打断分屏与滚动位置） */
function applyShelfUi(rel: string): void {
  renderShelves();
  document.querySelectorAll<HTMLElement>(".book").forEach((card) => {
    if (card.dataset.rel !== rel) return;
    card.querySelectorAll<HTMLElement>(".sbtn").forEach((btn) => {
      const on = !!shelfData[rel]?.[btn.dataset.shelf as ShelfName];
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  });
  refreshDetailActions();
}

function detailToggleHtml(rel: string): string {
  const rec = shelfData[rel];
  return (["fav", "reading", "done"] as ShelfName[])
    .map((s) => {
      const label = s === "fav" ? "♥" : s === "reading" ? "📖" : "✓";
      const tip = s === "fav" ? "加入/移出「喜欢」" : s === "reading" ? "标记/取消「在读」" : "标记/取消「读完」";
      const on = !!rec?.[s];
      return `<button class="btn tiny sbtn-wide ${on ? "on" : ""}" data-shelf="${s}" data-rel="${esc(rel)}" aria-pressed="${on ? "true" : "false"}" title="${tip}">${label}</button>`;
    })
    .join("");
}

// ---------- 阅读器地址设置（设备地址每次可能不同，需要在网页里改）----------
async function openPushCfg(): Promise<void> {
  const st = await loadPushStatus(true);
  ($("#pushUrl") as HTMLInputElement).value = st.target || "";
  ($("#pushResult") as HTMLElement).textContent = "";
  $("#pushMask").classList.remove("hidden");
  ($("#pushUrl") as HTMLInputElement).focus();
}

function closePushCfg(): void {
  $("#pushMask").classList.add("hidden");
}

async function savePushCfg(): Promise<void> {
  const input = $("#pushUrl") as HTMLInputElement;
  const btn = $("#pushSave") as HTMLButtonElement;
  const out = $("#pushResult") as HTMLElement;
  const url = input.value.trim();
  if (!url) {
    out.textContent = "请先粘贴阅读器上显示的网址";
    return;
  }
  btn.disabled = true;
  out.textContent = "保存中…";
  try {
    const res = await fetch("/api/push/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; saved?: boolean; target?: string; reachable?: boolean; fileSizeLimit?: number; error?: string };
    if (!res.ok || !d.ok) {
      out.textContent = `保存失败：${d.error || "HTTP " + res.status}`;
      return;
    }
    pushStatusCache = null; // 让详情页按钮重新探测
    if (d.reachable) {
      input.value = d.target || url;
      out.textContent = `✅ 已保存并连接成功：${d.target}${d.fileSizeLimit ? ` · 单文件上限 ${d.fileSizeLimit}MB` : ""}`;
    } else {
      out.textContent = `已保存 ${d.target}，但当前连不上：${d.error || "请确认阅读器上已打开「传书」页面"}（可稍后点按钮重试）`;
    }
    if (detailRel) void refreshPushHint(detailRel);
  } catch (err) {
    out.textContent = `保存异常：${String(err)}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 元数据体检：找出疑似错配，逐本重查/替换 ----------
async function openAudit(): Promise<void> {
  $("#auditMask").classList.remove("hidden");
  await renderAuditList();
}

async function renderAuditList(): Promise<void> {
  const list = $("#auditList") as HTMLElement;
  list.innerHTML = `<p class="muted">体检中…（扫描 book_meta.json，最长约 1 分钟）</p>`;
  try {
    const d = (await (await fetch("/api/metadata/audit")).json()) as {
      ok?: boolean;
      suspects?: { rel: string; similarity?: number; matchedTitle?: string; fileTitle?: string; author?: string; pinned?: boolean }[];
      total?: number;
      error?: string;
    };
    if (!d.ok) {
      list.innerHTML = `<p class="muted">体检失败：${esc(d.error || "未知错误")}</p>`;
      return;
    }
    const items = d.suspects || [];
    if (!items.length) {
      list.innerHTML = `<p class="muted">✅ 没有发现可疑条目（共扫描出 ${d.total || 0} 条低相似度记录）</p>`;
      return;
    }
    list.innerHTML = items
      .map(
        (it) => `<div class="audit-item" data-rel="${esc(it.rel)}">
        <div class="audit-title">${esc(it.fileTitle || it.rel)}</div>
        <div class="audit-sub">匹配到：${esc(it.matchedTitle || "?")} · 相似度 ${it.similarity ?? "?"} 分${it.pinned ? " · 已手动固定" : ""}</div>
        <div class="audit-actions">
          <button class="btn tiny" data-act="rematch">🔄 重查</button>
          <button class="btn tiny" data-act="link" data-rel="${esc(it.rel)}">🔗 链接</button>
        </div>
      </div>`,
      )
      .join("");
  } catch (err) {
    list.innerHTML = `<p class="muted">体检异常：${esc(String(err))}</p>`;
  }
}

async function rematchBook(rel: string): Promise<void> {
  toast(`重新匹配中：${rel.split("/").pop() || rel}…`);
  try {
    const res = await fetch("/api/metadata/rematch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel }),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; title?: string; douban?: string; publisher?: string; error?: string };
    if (res.ok && d.ok) {
      toast(`已重新匹配：${d.title || ""}${d.publisher ? " · " + d.publisher : ""}${d.douban ? " · " + d.douban + " 分" : ""}`);
    } else {
      toast(`重新匹配失败：${d.error || "HTTP " + res.status}`);
    }
  } catch (err) {
    toast(`重新匹配异常：${String(err)}`);
  }
  await renderAuditList();
  if (detailRel) setTimeout(() => void openDetail(detailRel), 800);
}

// ---------- 推送格式选择（原文件 / 已转换的 EPUB）----------
let convertedInfo: { id: string; chapters?: number } | null = null;

/** 查这本书是否已转换过 EPUB，用于发送菜单里的 EPUB 选项 */
async function loadConvertedForDetail(rel: string): Promise<void> {
  try {
    const d = (await (await fetch(`/api/converted?rel=${encodeURIComponent(rel)}`)).json()) as {
      converted?: { id: string; chapters?: number } | null;
    };
    if (detailRel !== rel) return;
    convertedInfo = d.converted || null;
    const epubBtn = document.getElementById("dPushEpub");
    if (epubBtn) {
      epubBtn.textContent = convertedInfo
        ? `发送 EPUB（已转换${convertedInfo.chapters ? ` · ${convertedInfo.chapters} 章` : ""}）`
        : "发送 EPUB（需先转换）";
      epubBtn.title = convertedInfo
        ? "发送之前转换好的 EPUB"
        : "这本书还没转换 EPUB：点击后会先转换，完成后自动发送";
    }
  } catch {
    convertedInfo = null;
  }
}

// ---------- 按链接更新元数据（用户给豆瓣链接，跳过模糊匹配）----------
let metaLinkRel = "";
async function openMetaLink(): Promise<void> {
  ($("#metaLinkUrl") as HTMLInputElement).value = "";
  ($("#metaLinkResult") as HTMLElement).textContent = "";
  $("#metaLinkMask").classList.remove("hidden");
  ($("#metaLinkUrl") as HTMLInputElement).focus();
}

function closeMetaLink(): void {
  $("#metaLinkMask").classList.add("hidden");
}

async function saveMetaLink(): Promise<void> {
  const rel = metaLinkRel || detailRel;
  if (!rel) return;
  const input = $("#metaLinkUrl") as HTMLInputElement;
  const btn = $("#metaLinkSave") as HTMLButtonElement;
  const out = $("#metaLinkResult") as HTMLElement;
  const url = input.value.trim();
  if (!url) {
    out.textContent = "请先粘贴豆瓣图书页链接或数字 ID";
    return;
  }
  btn.disabled = true;
  out.textContent = "抓取中…（需要几秒）";
  try {
    const res = await fetch("/api/metadata/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel, url }),
    });
    const d = (await res.json().catch(() => ({}))) as {
      ok?: boolean; title?: string; publisher?: string; year?: string; douban?: string; introLen?: number; error?: string;
    };
    if (!res.ok || !d.ok) {
      out.textContent = `更新失败：${d.error || "HTTP " + res.status}`;
      return;
    }
    out.textContent = `✅ 已更新：${d.title || ""}${d.publisher ? " · " + d.publisher : ""}${d.year ? " · " + d.year : ""}${d.douban ? " · " + d.douban + " 分" : ""}${d.introLen ? ` · 简介 ${d.introLen} 字` : ""}`;
    toast(`已按链接更新元数据：${d.title || rel}`);
    setTimeout(() => {
      if (detailRel === rel) void openDetail(rel);
      closeMetaLink();
    }, 1600);
  } catch (err) {
    out.textContent = `更新异常：${String(err)}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- PDF → EPUB 转换（文本版）----------
function renderConvertResult(d: { id?: string; chapters?: number; chars?: number; sizeBytes?: number; kind?: string; imagePages?: number; note?: string }): void {
  const box = document.getElementById("dConvertBox");
  if (!box || !d.id) return;
  const wan = ((d.chars || 0) / 10000).toFixed(1);
  const mb = ((d.sizeBytes || 0) / 1024 / 1024).toFixed(2);
  const note = d.note ? `（${d.note}）` : "";
  box.classList.remove("hidden");
  box.innerHTML = `<span class="dconvert-info">✅ 已转换：${d.chapters || 0} 章 · ${wan} 万字 · ${mb}MB ${note}</span>
    <a class="btn tiny" href="/api/converted/${d.id}" download>⬇ 下载 EPUB</a>
    <button class="btn tiny primary" id="dConvertPush" data-id="${d.id}">📤 发送 EPUB</button>`;
  document.getElementById("dConvertPush")?.addEventListener("click", () => void pushConverted(d.id as string));
}

async function pushConverted(id: string): Promise<void> {
  const btn = document.getElementById("dConvertPush") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "📤 发送中…"; }
  try {
    const res = await fetch("/api/push/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ converted: id }) });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; bytes?: number; ms?: number; message?: string; error?: string };
    if (res.ok && d.ok) toast(`已发送 EPUB 到阅读器（${((d.bytes || 0) / 1024 / 1024).toFixed(2)}MB · ${((d.ms || 0) / 1000).toFixed(1)}s）`);
    else toast(`发送失败：${d.error || "HTTP " + res.status}`);
  } catch (err) {
    toast(`发送异常：${String(err)}`);
  } finally {
    const b = document.getElementById("dConvertPush") as HTMLButtonElement | null;
    if (b) { b.disabled = false; b.textContent = "📤 发送 EPUB"; }
  }
}

async function convertBook(): Promise<void> {
  const rel = detailRel;
  if (!rel) return;
  const btn = document.getElementById("dConvert") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "📄 转换中…"; }
  try {
    const res = await fetch("/api/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel }) });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; kind?: string; needsOcr?: boolean; pages?: number; textPages?: number; chapters?: number; chars?: number; sizeBytes?: number; id?: string; error?: string };
    if (res.ok && d.ok) {
      renderConvertResult(d);
      toast(`转换完成：${d.chapters || 0} 章 · ${((d.chars || 0) / 10000).toFixed(1)} 万字`);
    } else if (d.needsOcr) {
      toast(`该书是扫描版（有文字页 ${d.textPages || 0}/${d.pages || 0}），需要 OCR，暂未启用`);
    } else {
      toast(`转换失败：${d.error || "HTTP " + res.status}`);
    }
  } catch (err) {
    toast(`转换异常：${String(err)}`);
  } finally {
    const b = document.getElementById("dConvert") as HTMLButtonElement | null;
    if (b) { b.disabled = false; b.textContent = "📄 转 EPUB"; }
  }
}

// ---------- 推送到局域网阅读器（讯飞起点阅读器）----------
let pushStatusCache: { at: number; reachable: boolean; target: string; fileSizeLimit?: number; error?: string } | null = null;

async function loadPushStatus(force = false): Promise<NonNullable<typeof pushStatusCache>> {
  if (!force && pushStatusCache && Date.now() - pushStatusCache.at < 30_000) return pushStatusCache;
  let d: { reachable?: boolean; target?: string; fileSizeLimit?: number; error?: string } = {};
  try {
    d = (await (await fetch("/api/push/status")).json()) as typeof d;
  } catch {
    d = { reachable: false, error: "状态查询失败" };
  }
  pushStatusCache = { at: Date.now(), reachable: d.reachable === true, target: String(d.target || ""), fileSizeLimit: d.fileSizeLimit, error: d.error };
  return pushStatusCache;
}

/** 按钮反映设备在线状态（未连接时禁用并说明） */
async function refreshPushHint(rel: string): Promise<void> {
  const st = await loadPushStatus();
  if (detailRel !== rel) return;
  const btn = document.getElementById("dPush") as HTMLButtonElement | null;
  if (!btn) return;
  if (st.reachable) {
    btn.disabled = false;
    btn.textContent = "📤 发送到阅读器";
    btn.title = `设备已连接：${st.target}${st.fileSizeLimit ? ` · 单文件上限 ${st.fileSizeLimit}MB` : ""}`;
  } else {
    btn.disabled = true;
    btn.textContent = "📤 阅读器未连接";
    btn.title = `设备未连接：${st.target}${st.error ? `（${st.error}）` : ""} — 请在阅读器上打开传书页面`;
  }
}

async function sendToDevice(): Promise<void> {
  const rel = detailRel;
  if (!rel) return;
  const book = allBooks.find((x) => x.rel === rel);
  const btn = document.getElementById("dPush") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "📤 发送中…";
  }
  const sel = document.getElementById("dPushFormat") as HTMLSelectElement | null;
  const mode = sel?.value || "orig";
  const epubId = sel?.dataset.epubId || "";
  const useEpub = mode === "epub" && epubId;
  try {
    const res = await fetch("/api/push/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(useEpub ? { converted: epubId } : { rel }),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; bytes?: number; ms?: number; message?: string; error?: string };
    if (res.ok && d.ok) {
      const mb = ((d.bytes || 0) / 1024 / 1024).toFixed(1);
      toast(`已发送到阅读器：${book?.title || rel}（${mb}MB · ${((d.ms || 0) / 1000).toFixed(1)}s）${d.message ? " · " + d.message : ""}`);
    } else {
      toast(`发送失败：${d.error || "HTTP " + res.status}`);
      pushStatusCache = null;
    }
  } catch (err) {
    toast(`发送异常：${String(err)}`);
  } finally {
    const b = document.getElementById("dPush") as HTMLButtonElement | null;
    if (b) {
      b.disabled = false;
      b.textContent = "📤 发送到阅读器";
    }
  }
}

function refreshDetailActions(): void {
  const rel = detailRel;
  if (!rel || $("#detailMask").classList.contains("hidden")) return;
  const b = allBooks.find((x) => x.rel === rel);
  if (!b) return;
  const rec = shelfData[rel];
  const canRead = PREVIEWABLE.has(b.ext);
  const actions = $("#dActions");
  actions.dataset.dataless = b.dataless ? "1" : "0";
  actions.dataset.rel = rel;
  // 紧凑单行：主操作 → 发送(+格式) → 书架 → EPUB/更多（低频操作放弹层，不占布局空间）
  actions.innerHTML = `
      ${canRead ? `<a class="btn read" href="${readUrl(b)}">${rec?.page ? "▶ 继续阅读" : "📖 阅读"}</a>` : `<a class="btn read" disabled>预览不可用</a>`}
      <a class="btn primary dl-link" href="${fileUrl(b.rel, "attachment")}" download="${txt(b.title)}.${b.ext.toLowerCase()}">⬇ 下载</a>
      <span class="pushwrap">
        <button class="btn pushbtn" id="dPush" disabled title="检测阅读器连接中">📤 阅读器检测中…</button>
        <div class="push-menu hidden" id="dPushMenu">
          <button class="btn tiny" data-push="orig" id="dPushOrig">发送 原文件</button>
          <button class="btn tiny" data-push="epub" id="dPushEpub">发送 EPUB</button>
          <div class="pmenu-hint" id="dPushMenuHint"></div>
        </div>
      </span>
      <span class="morewrap2">
        <button class="btn tiny morebtn" id="dMore" aria-expanded="false" title="转换 / 元数据修正 / 编辑">⚙ 更多</button>
        <div class="more-actions hidden" id="dMoreActions">
          <button class="btn tiny convertbtn" id="dConvert" title="把 PDF 转成可重排的 EPUB（文本版）">📄 转 EPUB</button>
          <button class="btn tiny metalinkbtn" id="dMetaLink" title="粘贴豆瓣图书页链接，直接用该页面更新这本书的元数据">🔗 链接更新</button>
          <button class="btn tiny rematchbtn" id="dRematch" title="用修复后的匹配器重新查找这本书的豆瓣信息">🔄 重新匹配</button>
          <button class="btn tiny editbtn" title="修改书名 / 文件名 / 元数据">✏ 编辑</button>
        </div>
      </span>`;
  // 书架三态紧跟书名右侧（与图书本身关联更直观）
  const titleShelf = document.getElementById("dTitleShelf");
  if (titleShelf) titleShelf.innerHTML = detailToggleHtml(rel);
  void refreshPushHint(rel);
  void loadConvertedForDetail(rel);
  void refreshPushHint(rel);
  void loadConvertedForDetail(rel);
}

async function openDetail(rel: string): Promise<void> {
  const b = allBooks.find((x) => x.rel === rel);
  if (!b) return;
  detailRel = rel;
  document.getElementById("dConvertBox")?.classList.add("hidden");
  const rec = shelfData[rel];
  const initial = esc((b.title || "?").trim().charAt(0).toUpperCase());
  const hue = [...rel].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  const coverSrc = `/api/cover?path=${encodeURIComponent(rel)}&v=${b.mtimeMs}`;

  $("#dCover").innerHTML = `<img src="${coverSrc}" alt=""
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <span class="cover-fb" style="display:none;--h:${hue}">${initial}</span>`;
  $("#dTitle").textContent = decodeEntities(b.title || "");
  $("#dAuthor").textContent = decodeEntities(b.author || "（未知作者）");

  const rows: Array<[string, string]> = [["分类", b.category], ["格式", `${b.ext} · ${fmtSize(b.size)}`]];
  if (b.douban) rows.push(["豆瓣评分", b.douban]);
  rows.push(["数据位置", b.dataless ? "☁ iCloud 云端（首次打开自动取回）" : "本机（可直接阅读/下载）"]);
  rows.push(["文件时间", fmtDate(b.mtimeMs)]);
  if (rec?.page) rows.push(["阅读进度", `读到第 ${rec.page} 页`]);
  const renderRows = (extra: Array<[string, string]> = []) =>
    extra
      .concat(rows)
      .map(([k, v]) => `<div class="drow"><span class="dk">${esc(k)}</span><span class="dv">${esc(v)}</span></div>`)
      .join("");
  $("#dInfo").innerHTML = renderRows();
  $("#dChips").innerHTML = (b.tags || []).map((t) => `<span class="chip">${txt(t)}</span>`).join("");

  const intro0 = decodeEntities(b.introFull || b.intro || "");
  $("#dIntro").textContent = intro0 || "（暂无简介）";
  $("#dIntro").classList.toggle("muted", !intro0);
  const tocLines0 = formatToc(b.toc || "");
  $("#dTocWrap").classList.toggle("hidden", !tocLines0.length);
  $("#dToc").textContent = tocLines0.join("\n");
  toggleTocHint(tocLines0);
  $("#dPath").textContent = rel;
  $("#detailMask").classList.remove("hidden"); // 必须先显示，refreshDetailActions 有可见性前置判断
  refreshDetailActions();

  // 拉取完整详情（完整简介 / 目录 / meta），失败则用列表数据兜底
  try {
    const res = await fetch(`/api/book?path=${encodeURIComponent(rel)}`);
    if (!res.ok) return;
    const full = (await res.json()).book as Book;
    if (detailRel !== rel) return; // 期间又打开了别的书
    const meta = full.meta || {};
    const extra: Array<[string, string]> = [];
    for (const k of ["原名", "译者", "页数", "出版日期", "出版社", "ISBN"]) {
      if (meta[k]) extra.push([k, meta[k]]);
    }
    if (!extra.length) {
      if (full.publisher) extra.push(["出版社", full.publisher]);
      if (full.pubDate) extra.push(["出版日期", full.pubDate]);
    }
    $("#dInfo").innerHTML = renderRows(extra);
    const intro = decodeEntities(full.introFull || full.intro || "");
    const srcLabel = full.metaSource ? `简介来源：${SOURCE_LABEL[full.metaSource] || full.metaSource}` : "";
    $("#dIntroLabel").textContent = srcLabel ? `内容简介（${srcLabel}）` : "内容简介";
    $("#dIntro").textContent = intro || "（暂无简介）";
    $("#dIntro").classList.toggle("muted", !intro);
    const bio = decodeEntities((full.meta || {})["作者简介"] || "");
    const bioWrap = document.getElementById("dBioWrap");
    if (bioWrap) {
      bioWrap.classList.toggle("hidden", !bio);
      const bioEl = document.getElementById("dBio");
      if (bioEl) bioEl.textContent = bio;
    }
    const tocLines = formatToc(full.toc || "");
    $("#dTocWrap").classList.toggle("hidden", !tocLines.length);
    if (tocLines.length) {
      $("#dToc").textContent = tocLines.join("\n");
      toggleTocHint(tocLines);
    }
  } catch {
    /* 用列表数据已经可读，忽略 */
  }
}

// ---------- 待下载确认（清单来自管道 recommend.py，决策由它 apply 落盘）----------
let recos: PendingReco[] = [];
let recoQueued: QueuedReco[] = [];
let recoQueuedInLibrary: QueuedReco[] = [];
let recoInLibrary: PendingReco[] = [];
let recoFileBytes = 0;
let recoArchive: { total: number; months: string[] } = { total: 0, months: [] };
let queuedOpen = false;
let recoScriptAvailable = true;
let recoReadable = true;
let recoMaxDownload = 30;
let recoLoading = false;
/**
 * 页面级选项：勾选后「确认下载」批准的同时立即开始下载（记忆到 localStorage）。
 * ⚠ 必须在模块初始化时就恢复：启动流程里的 switchTab() 会调用 savePrefs()，
 *   若此时还是默认值 false，就会把用户的选择覆盖掉。
 */
let recoAutoDl = loadPrefs().autoDl === true;
const recoSel = new Set<number>();

async function loadReco(sync = true): Promise<void> {
  if (recoLoading) return; // 开页预取 + 切 Tab 可能同时触发：只发一次，避免重复 sync
  recoLoading = true;
  try {
    const res = await fetch(sync ? "/api/recommend/pending?sync=1" : "/api/recommend/pending");
    const data = await res.json();
    recos = (data.items || []) as PendingReco[];
    recoQueued = (data.queued || []) as QueuedReco[];
    recoQueuedInLibrary = (data.queuedInLibrary || []) as QueuedReco[];
    recoInLibrary = (data.itemsInLibrary || []) as PendingReco[];
    recoFileBytes = Number(data.fileBytes) || 0;
    recoArchive = (data.archive || { total: 0, months: [] }) as { total: number; months: string[] };
    recoScriptAvailable = data.scriptAvailable !== false;
    recoReadable = data.readable !== false;
    recoMaxDownload = Number(data.maxDownload) || 30;
    // 已不在清单里的选择要清掉（避免"幽灵选择"被提交）
    for (const id of [...recoSel]) {
      if (!recos.some((r) => r.id === id)) recoSel.delete(id);
    }
    renderReco();
    renderQueued();
    renderRecoStatus();
    renderBrowse();
    renderArchive();
    const notice = document.getElementById("recoNotice");
    if (notice) {
      // 四种情况分别提示：脚本缺失 / 清单读不出来 / 刷新(sync)失败 / 文件还不存在
      let msg = "";
      if (!recoScriptAvailable) msg = "⚠ 管道 recommend.py 不可用：当前只能查看，确认功能不可用";
      else if (!recoReadable) msg = `⚠ ${String(data.error || "清单读取失败")}（当前只读展示）`;
      else if (data.syncSkipped) msg = `⚠ ${String(data.error || "有任务在执行中，本次未刷新清单")}`;
      else if (data.syncOk === false) msg = `⚠ ${String(data.error || "清单未刷新成功")}（显示的可能是过期数据）`;
      notice.innerHTML = msg ? txt(msg) : "";
      notice.classList.toggle("hidden", !msg);
    }
  } catch (err) {
    recoReadable = false;
    const list = document.getElementById("recoList");
    if (list) list.innerHTML = `<div class="empty">待确认清单加载失败：${txt(String(err))}</div>`;
  } finally {
    recoLoading = false;
  }
}

/**
 * 清单状态与量级提示。
 * 实测结论：管道 sync 只保留最近 200 条已处理 → 文件有界（稳态 20~50KB，千行内亚毫秒解析），
 * 所以瓶颈不是速度，而是 ①历史会被截断（已按月归档）②待确认积压影响人工查看。
 */
function renderRecoStatus(): void {
  const box = document.getElementById("recoStatus");
  if (!box) return;
  const kb = recoFileBytes / 1024;
  const bits: string[] = [`清单 ${kb.toFixed(1)} KB`];
  if (recoArchive.total > 0) {
    bits.push(`历史已归档 ${recoArchive.total} 条（${recoArchive.months.length} 个月）`);
  } else {
    bits.push("历史归档：暂无");
  }
  const warns: string[] = [];
  if (recos.length > 100) warns.push(`待确认积压 ${recos.length} 本，建议尽快处理`);
  if (kb > 200) warns.push(`清单已达 ${kb.toFixed(0)} KB，建议检查归档`);
  box.innerHTML = warns.length
    ? `${bits.join(" · ")}　<span class="warn">⚠ ${warns.map((w) => txt(w)).join("；")}</span>`
    : bits.join(" · ");
}

/** 「已确认待下载」：确认后、次日巡检下载前的队列（T1 且尚未下载/未失效） */
function renderQueued(): void {
  const box = document.getElementById("recoQueued");
  if (!box) return;
  if (!recoQueued.length && !recoQueuedInLibrary.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  // 账本（每日流程记账）之外还要看书库：手动下载的书已入库，这里说明清楚避免"明明下过了还挂着"
  const inLibNote = recoQueuedInLibrary.length
    ? `<div class="qmuted" style="margin-top:6px">✅ 另有 ${recoQueuedInLibrary.length} 本已在书库（手动下载后账本尚未记账，已自动移出队列）：${recoQueuedInLibrary.map((q) => esc(q.title.slice(0, 18))).join("、")}</div>`
    : "";
  box.classList.remove("hidden");
  const rows = recoQueued
    .map(
      (q) => `<div class="qrow" data-id="${q.id}">
        <span class="qtitle">${esc(q.title)}</span>
        <span class="qmuted">→ ${esc(q.folder)}${q.douban ? ` · 豆瓣 ${esc(q.douban)}` : ""}</span>
        <button class="btn tiny rq-dl" data-id="${q.id}">立即下载</button>
      </div>`,
    )
    .join("");
  box.innerHTML = `
    <div class="qhead">
      <button class="btn tiny qtoggle" aria-expanded="${queuedOpen}">${queuedOpen ? "▾" : "▸"}</button>
      <span class="qsummary">📥 已确认待下载 <b>${recoQueued.length}</b> 本<span class="qmuted">　次日 08:00 巡检会自动下载并归档</span></span>
      <span class="reco-spacer"></span>
      <button class="btn tiny primary" id="queuedDlAll">全部立即下载</button>
    </div>
    <div class="qlist ${queuedOpen ? "" : "hidden"}">${rows || '<div class="qmuted">（队列里已没有待下载的书）</div>'}</div>${inLibNote}`;
  const toggle = box.querySelector(".qtoggle");
  toggle?.addEventListener("click", () => {
    queuedOpen = !queuedOpen;
    renderQueued();
  });
  document.getElementById("queuedDlAll")?.addEventListener("click", () => downloadQueued(recoQueued.map((q) => q.id)));
  box.querySelectorAll(".rq-dl").forEach((btn) =>
    btn.addEventListener("click", () => downloadQueued([Number((btn as HTMLElement).dataset.id)])),
  );
}

// ---------- 折叠区一：推荐浏览（tier2/3 原始清单，含已拒绝；恢复 v1.8 前的浏览/直接下载能力）----------
let browseOpen = false;
let browseItems: Reco[] = [];
let browseFilter: "all" | "2" | "3" = "all";
let browseLoaded = false;

function renderBrowse(): void {
  const box = document.getElementById("recoBrowse");
  if (!box) return;
  const rows = browseItems.filter((r) => (browseFilter === "all" ? true : String(r.tier) === browseFilter));
  const sel = browseSel.size;
  const restorable = browseItems.filter((r) => browseSel.has(r.id) && r.tier === 3).length;
  const body = !browseLoaded
    ? `<div class="muted">正在加载…</div>`
    : rows.length
      ? rows
          .slice(0, 300)
          .map(
            (r) => `<div class="brow" data-id="${r.id}">
              <input type="checkbox" data-id="${r.id}" ${browseSel.has(r.id) ? "checked" : ""} />
              <span class="btitle" data-id="${r.id}" title="点击查看完整介绍">${r.tier === 2 ? "👍" : "🤔"} ${esc(r.title)}<span class="bcaret">${browseExpanded.has(r.id) ? "▾" : "▸"}</span></span>
              <span class="qmuted">→ ${esc(r.folder)}${r.douban ? ` · 豆瓣 ${esc(r.douban)}` : ""}${r.downloaded ? " · 已下载过" : ""}</span>
              ${r.tier === 3 ? `<button class="btn tiny restore rq-restore" data-id="${r.id}" title="把这本书从「不要了」改回待定（会重新出现在待确认里）">恢复为待定</button>` : ""}
            </div>
            ${browseExpanded.has(r.id) ? `<div class="bdetail" data-id="${r.id}">${browseDetails.get(r.id) ?? `<div class="muted">正在加载完整介绍…</div>`}</div>` : ""}`,
          )
          .join("") + (rows.length > 300 ? `<div class="muted">仅显示前 300 条（共 ${rows.length} 条）</div>` : "")
      : `<div class="muted">没有符合条件的条目</div>`;
  box.innerHTML = `
    <div class="qhead">
      <button class="btn tiny xtoggle" data-x="browse" aria-expanded="${browseOpen}">${browseOpen ? "▾" : "▸"}</button>
      <span class="qsummary">📚 推荐浏览 <span class="qmuted">（原始清单：👍待定 + 🤔已拒绝${browseLoaded ? `，共 ${browseItems.length} 条` : "，展开后加载"}${sel ? ` · 已选 ${sel} 本` : ""}）</span></span>
      <span class="qmuted xhint">勾选可批量「下载选中 / 恢复为待定」；点书名或整行看完整介绍</span>
      <span class="reco-spacer"></span>
      <span class="xfilter ${browseFilter === "all" ? "on" : ""}" data-f="all">全部</span>
      <span class="xfilter ${browseFilter === "2" ? "on" : ""}" data-f="2">仅待定</span>
      <span class="xfilter ${browseFilter === "3" ? "on" : ""}" data-f="3">仅已拒绝</span>
      <button class="btn tiny" id="browseRestore" ${restorable ? "" : "disabled"} title="把勾选的「已拒绝」书改回待定">恢复为待定${restorable ? `(${restorable})` : ""}</button>
      <button class="btn tiny primary" id="browseDl" ${sel ? "" : "disabled"}>下载选中${sel ? `(${sel})` : ""}</button>
    </div>
    <div class="qlist ${browseOpen ? "" : "hidden"}">${body}</div>`;
  box.querySelector(".xtoggle")?.addEventListener("click", () => {
    browseOpen = !browseOpen;
    if (browseOpen && !browseLoaded) void loadBrowse();
    else renderBrowse();
  });
  box.querySelectorAll(".xfilter").forEach((el) =>
    el.addEventListener("click", () => {
      browseFilter = (el as HTMLElement).dataset.f as typeof browseFilter;
      renderBrowse();
    }),
  );
  const toggleSel = (id: number, on: boolean): void => {
    if (on) browseSel.add(id);
    else browseSel.delete(id);
    renderBrowse();
  };
  box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener("change", () => toggleSel(Number(cb.dataset.id), cb.checked)),
  );
  // 整行点击 = 展开/收起完整介绍（勾选只走复选框，避免两者互相干扰）
  box.querySelectorAll(".brow").forEach((row) =>
    row.addEventListener("click", (ev) => {
      const el = ev.target as HTMLElement;
      if (el.tagName === "INPUT" || el.classList.contains("rq-restore")) return;
      void toggleBrowseDetail(Number((row as HTMLElement).dataset.id));
    }),
  );
  box.querySelectorAll(".rq-restore").forEach((btn) =>
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void restoreRejected([Number((btn as HTMLElement).dataset.id)]);
    }),
  );
  document.getElementById("browseRestore")?.addEventListener("click", () => {
    const ids = browseItems.filter((r) => browseSel.has(r.id) && r.tier === 3).map((r) => r.id);
    if (!ids.length) return void toast("请先勾选「已拒绝」的书");
    void restoreRejected(ids);
  });
  document.getElementById("browseDl")?.addEventListener("click", () => {
    const ids = [...browseSel];
    if (!ids.length) return void toast("请先勾选要下载的书");
    downloadQueued(ids); // 复用一键下载（按上限截断并提示）
    browseSel.clear(); // 动作已提交，清空选择避免误以为还未处理
    renderBrowse();
  });
}

let browseSel = new Set<number>();
/** 展开查看完整介绍的条目 */
const browseExpanded = new Set<number>();
/** 已取到的完整详情（渲染好的 HTML 片段，按 id 缓存） */
const browseDetails = new Map<number, string>();

/** 把「不要了」的书恢复为待定（EBM 会写 tiers.json，自动备份 + 共用锁） */
async function restoreRejected(ids: number[]): Promise<void> {
  if (!ids.length) return;
  try {
    const res = await fetch("/api/reco/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`恢复失败：${String(d.error || res.status)}`);
      return;
    }
    const n = (d.restored || []).length;
    const skipped = (d.skipped || []) as Array<{ id: number; reason: string }>;
    toast(`已恢复 ${n} 本为待定${skipped.length ? `（${skipped.length} 本跳过：${skipped[0].reason}）` : ""}`);
    for (const r of d.restored || []) browseSel.delete(r.id);
    await loadBrowse();
    await loadReco(); // 恢复的书应重新出现在「待确认」里
  } catch (err) {
    toast(`恢复异常：${String(err)}`);
  }
}

interface RecoDetail {
  title?: string;
  author?: string;
  author_bio?: string;
  publisher?: string;
  year?: string;
  pages?: string;
  translator?: string;
  douban?: string;
  intro?: string;
  toc?: string;
  tags?: string[];
}

/** 展开/收起某本书的完整介绍（首次展开才拉取，之后走缓存） */
async function toggleBrowseDetail(id: number): Promise<void> {
  if (browseExpanded.has(id)) {
    browseExpanded.delete(id);
    renderBrowse();
    return;
  }
  browseExpanded.add(id);
  renderBrowse();
  if (browseDetails.has(id)) return;
  try {
    const res = await fetch(`/api/reco/detail?id=${id}`);
    const d = (await res.json()) as RecoDetail & { error?: string };
    browseDetails.set(id, res.ok ? renderRecoDetail(d) : `<div class="warn">${txt(String(d.error || res.status))}</div>`);
  } catch (err) {
    browseDetails.set(id, `<div class="warn">加载失败：${txt(String(err))}</div>`);
  }
  if (browseExpanded.has(id)) renderBrowse();
}

/** 完整介绍面板：元数据一行 + 标签 + 完整简介 + 目录（折叠） */
function renderRecoDetail(d: RecoDetail): string {
  // 源数据里常用「无 / 暂无 / -」占位，别显示成"译者：无"
  const real = (v?: string): string => {
    const t = String(v ?? "").trim();
    return /^(无|暂无|未知|none|null|-|—)$/i.test(t) ? "" : t;
  };
  const metaBits = [
    real(d.author) ? `作者：${esc(real(d.author))}` : "",
    real(d.translator) ? `译者：${esc(real(d.translator))}` : "",
    real(d.publisher) ? `出版社：${esc(real(d.publisher))}` : "",
    real(d.year) ? `出版日期：${esc(real(d.year))}` : "",
    real(d.pages) ? `页数：${esc(real(d.pages))}` : "",
    real(d.douban) ? `豆瓣：${esc(real(d.douban))}` : "",
  ].filter(Boolean);
  const tags = (d.tags || []).filter(Boolean);
  const intro = decodeEntities(d.intro || "");
  const toc = decodeEntities(d.toc || "");
  return `
    ${metaBits.length ? `<div class="dmeta">${metaBits.join("　·　")}</div>` : ""}
    ${tags.length ? `<div class="dtags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="dlabel">内容简介</div>
    <div class="dintro">${intro ? esc(intro).replace(/\n/g, "<br>") : '<span class="muted">（该帖没有简介）</span>'}</div>
    ${d.author_bio ? `<div class="dlabel">作者简介</div><div class="dintro">${esc(decodeEntities(d.author_bio)).replace(/\n/g, "<br>")}</div>` : ""}
    ${toc ? `<details class="dtoc"><summary>目录（${toc.length} 字）</summary><div class="dintro">${esc(formatToc(toc).join("\n")).replace(/\n/g, "<br>")}</div></details>` : ""}`;
}

async function loadBrowse(): Promise<void> {
  try {
    const d = await (await fetch("/api/recommendations")).json();
    browseItems = (d.items || []) as Reco[];
  } catch {
    browseItems = [];
  }
  browseLoaded = true;
  renderBrowse();
}

// ---------- 折叠区二：历史决策（归档查看 + 搜索；原先只能翻 Markdown 文件）----------
let archiveOpen = false;
let archiveMonths: Array<{ month: string; count: number }> = [];
let archiveItems: ArchiveRow[] = [];
let archiveTotal = 0;
let archiveQuery = { month: "all", q: "" };
let archiveLoaded = false;
let archiveTimer: ReturnType<typeof setTimeout> | undefined;

function renderArchive(): void {
  const box = document.getElementById("recoArchive");
  if (!box) return;
  const opts = [`<option value="all">全部月份</option>`]
    .concat(archiveMonths.map((m) => `<option value="${esc(m.month)}" ${archiveQuery.month === m.month ? "selected" : ""}>${esc(m.month)}（${m.count} 条）</option>`))
    .join("");
  const rows = archiveItems
    .map(
      (e) => `<div class="arow">
        <span class="adate">${esc(e.date)}</span>
        <span class="aact ${e.action}">${e.action === "approve" ? "✔ 已批" : "✘ 不要了"}</span>
        <span class="atitle">${esc(e.title)}</span>
        <span class="qmuted">${e.folder ? `→ ${esc(e.folder)} · ` : ""}ID ${e.id}${e.note ? ` · ${esc(e.note.slice(0, 60))}` : ""}</span>
      </div>`,
    )
    .join("");
  box.innerHTML = `
    <div class="qhead">
      <button class="btn tiny xtoggle" data-x="archive" aria-expanded="${archiveOpen}">${archiveOpen ? "▾" : "▸"}</button>
      <span class="qsummary">📜 历史决策 <span class="qmuted">（${archiveLoaded ? `已归档 ${archiveTotal} 条` : "展开后加载"}，主清单只保留最近 200 条）</span></span>
      <span class="reco-spacer"></span>
      <select id="archiveMonth" class="xselect">${opts}</select>
      <input id="archiveQ" class="xinput" placeholder="搜索书名 / ID / 理由" value="${esc(archiveQuery.q)}" />
    </div>
    <div class="qlist ${archiveOpen ? "" : "hidden"}">${!archiveLoaded ? `<div class="muted">正在加载…</div>` : rows || `<div class="muted">没有匹配的历史记录</div>`}</div>`;
  box.querySelector(".xtoggle")?.addEventListener("click", () => {
    archiveOpen = !archiveOpen;
    if (archiveOpen && !archiveLoaded) void loadArchive();
    else renderArchive();
  });
  const mSel = document.getElementById("archiveMonth") as HTMLSelectElement | null;
  mSel?.addEventListener("change", () => {
    archiveQuery.month = mSel.value;
    void loadArchive();
  });
  const qIn = document.getElementById("archiveQ") as HTMLInputElement | null;
  qIn?.addEventListener("input", () => {
    archiveQuery.q = qIn.value;
    if (archiveTimer) clearTimeout(archiveTimer);
    archiveTimer = setTimeout(() => void loadArchive(), 300); // 输入防抖
  });
}

/** 已归档条目（与后端返回结构一致） */
interface ArchiveRow {
  date: string;
  action: "approve" | "reject";
  id: number;
  title: string;
  folder: string;
  note: string;
  month: string;
}

async function loadArchive(): Promise<void> {
  try {
    const url = `/api/reco/archive?month=${encodeURIComponent(archiveQuery.month)}&q=${encodeURIComponent(archiveQuery.q)}&limit=200`;
    const d = await (await fetch(url)).json();
    archiveMonths = (d.months || []) as Array<{ month: string; count: number }>;
    archiveItems = (d.items || []) as ArchiveRow[];
    archiveTotal = Number(d.total) || 0;
  } catch {
    archiveItems = [];
  }
  archiveLoaded = true;
  renderArchive();
}

/** 从「已确认待下载」直接下载（复用一键下载流；超上限时只下前 N 本并提示） */
function downloadQueued(ids: number[]): void {
  const picked = ids.filter((n) => Number.isFinite(n));
  if (!picked.length) return;
  const limit = recoMaxDownload;
  if (picked.length > limit) {
    toast(`一次最多 ${limit} 本，本次下载前 ${limit} 本`);
  }
  void startPipeline(picked.slice(0, limit));
}

function renderReco(): void {
  const list = document.getElementById("recoList");
  if (!list) return;
  const badge = document.getElementById("recoBadge");
  if (badge) badge.textContent = recos.length ? String(recos.length) : "";
  // 直接从推荐浏览下载（未经批准）的书已入库 → 不再要求确认，这里说明去处
  const inLibBox = document.getElementById("recoInLibrary");
  if (inLibBox) {
    if (recoInLibrary.length) {
      inLibBox.classList.remove("hidden");
      inLibBox.innerHTML = `✅ 另有 ${recoInLibrary.length} 本已在书库（未经批准直接下载，账本尚未记账，已自动移出待确认）：${recoInLibrary
        .map((r) => esc(r.title.slice(0, 22)))
        .join("、")}`;
    } else {
      inLibBox.classList.add("hidden");
      inLibBox.innerHTML = "";
    }
  }
  const count = document.getElementById("recoCount");
  if (count) {
    count.textContent = recos.length
      ? `待确认 ${recos.length} 本 · 已选 ${recoSel.size} 本`
      : "待确认 0 本";
  }
  // 主按钮文案跟随页面选项（"确认下载"=只批准排队；"确认并下载"=批准并立即下载）
  const mainBtn = document.getElementById("recoApprove");
  if (mainBtn) mainBtn.textContent = recoAutoDl ? "确认并下载" : "确认下载";
  const autoBox = document.getElementById("recoAutoDl") as HTMLInputElement | null;
  if (autoBox) autoBox.checked = recoAutoDl;
  if (!recos.length) {
    list.innerHTML = recoReadable
      ? `<div class="empty">暂无待确认书目 🎉<br><span class="muted">每日巡检发现"部分匹配但未到自动下载标准"的书会出现在这里</span></div>`
      : `<div class="empty">清单读取失败，暂时无法展示（可点「刷新」重试）</div>`;
    return;
  }
  list.innerHTML = recos
    .map(
      (r) => `
    <div class="reco" data-id="${r.id}">
      <input type="checkbox" data-id="${r.id}" ${recoSel.has(r.id) ? "checked" : ""} />
      <div class="body">
        <div class="t">${esc(r.title)} ${r.douban ? `<span class="tag douban">豆瓣 ${esc(r.douban)}</span>` : ""}
          <span class="tag">建议归档：${esc(r.folder)}</span>
          ${r.mark === "approve" ? `<span class="tag marked">清单里已勾选：确认下载</span>` : r.mark === "reject" ? `<span class="tag marked">清单里已勾选：不要了</span>` : ""}</div>
        <div class="a muted">${esc(r.author || "（未知作者）")}${r.date ? ` · ${esc(r.date)}` : ""} · 帖子 ID ${r.id}</div>
        ${r.note ? `<div class="note">判断理由：${esc(r.note)}</div>` : ""}
        ${r.intro ? `<div class="note">${esc(r.intro)}</div>` : ""}
        <div class="reco-quick">
          <button class="btn tiny primary rq-approve" data-id="${r.id}">${recoAutoDl ? "确认并下载" : "确认下载"}</button>
          <button class="btn tiny rq-reject" data-id="${r.id}">不要了</button>
        </div>
      </div>
    </div>`,
    )
    .join("");
}

function selectedRecoIds(): number[] {
  return recos.filter((r) => recoSel.has(r.id)).map((r) => r.id);
}

/** 提交决策：批准进 T1、拒绝不再推荐（写回由管道 recommend.py apply 完成） */
async function decideReco(approve: number[], reject: number[], alsoDownload = false): Promise<void> {
  if (!approve.length && !reject.length) {
    toast("请先勾选要处理的条目");
    return;
  }
  if (alsoDownload && approve.length > recoMaxDownload) {
    toast(`立即下载单次最多 ${recoMaxDownload} 本（已选 ${approve.length} 本）；可先取消「立即下载」把其余排队`);
    return;
  }
  if (!recoScriptAvailable) {
    toast("管道 recommend.py 不可用，无法提交");
    return;
  }
  try {
    const res = await fetch("/api/recommend/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve, reject }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`${String(d.error || res.status)}；已刷新清单，请核对后再操作`);
      await loadReco(false);
      return;
    }
    const parts: string[] = [];
    if (approve.length) {
      parts.push(
        alsoDownload
          ? `已批准 ${approve.length} 本并开始下载（进度见日志；入库后自动离开队列）`
          : `已批准 ${approve.length} 本（进 T1，次日 08:00 巡检自动下载归档）`,
      );
    }
    if (reject.length) parts.push(`已标记不要 ${reject.length} 本`);
    toast(parts.join("；"));
    for (const id of [...approve, ...reject]) recoSel.delete(id);
    await loadReco();
    if (alsoDownload && approve.length) {
      void startPipeline(approve);
    }
  } catch (err) {
    toast(`异常：${String(err)}`);
  }
}

/**
 * 通用二次确认：**标题、说明、按钮文案都由动作决定**。
 * 曾经的缺陷：复用了下载弹层而只替换正文，于是"不要了"的弹层写着「确认下载 / 开始下载」。
 * 这里把 title/okLabel/hint 设为必填，杜绝再出现"文案与动作背离"。
 */
function confirmReco(opts: {
  title: string;
  okLabel: string;
  hint: string;
  text: string;
  reject?: number[];
  approveAndDownload?: number[];
}): void {
  const rejectIds = opts.reject || [];
  const approveIds = opts.approveAndDownload || [];
  $("#confirmTitle").textContent = opts.title;
  $("#confirmText").textContent = opts.text;
  $("#confirmHint").textContent = opts.hint;
  $("#confirmOk").textContent = opts.okLabel;
  $("#confirmMask").classList.remove("hidden");
  $("#confirmOk").onclick = () => {
    $("#confirmMask").classList.add("hidden");
    void decideReco(approveIds, rejectIds, approveIds.length > 0);
  };
}

/** 「不要了」的确认文案（拒绝=之后不再推荐） */
function rejectConfirm(ids: number[], text: string): void {
  confirmReco({
    title: "确认不要了",
    okLabel: "标记为不要了",
    hint: "该书记为拒绝，之后不再推荐（如需恢复需手动改 tiers.json）。",
    text,
    reject: ids,
  });
}



async function startPipeline(ids: number[]): Promise<void> {
  const box = $("#logBox");
  box.textContent = `[ebm] 开始下载 ${ids.length} 本（帖子 ID: ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? " …" : ""}）\n下面是雅书管道的原始输出（第一行是它执行的命令）：\n\n`;
  $("#logMask").classList.remove("hidden");
  let full = "";
  try {
    const res = await fetch("/api/pipeline/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok || !res.body) {
      box.textContent += `\n[HTTP ${res.status}] ${await res.text()}\n`;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      full += chunk;
      box.textContent += chunk;
      box.scrollTop = box.scrollHeight;
    }
  } catch (err) {
    box.textContent += `\n[error] ${String(err)}\n`;
  }
  // 结果摘要：管道每本一行「… -> OK …」或「… -> …失败…」，直接告诉用户成败，
  // 避免"看到一堆提示却不知道到底下了没下"
  const okCount = (full.match(/->\s*OK\b/g) || []).length;
  const failLines = full.split("\n").filter((l) => /->\s*[^\n]*失败/.test(l));
  if (okCount || failLines.length) {
    const parts: string[] = [];
    if (okCount) parts.push(`成功 ${okCount} 本`);
    if (failLines.length) parts.push(`失败 ${failLines.length} 本`);
    const reason = failLines[0] ? failLines[0].split("->").pop()?.trim().slice(0, 40) : "";
    toast(`下载结束：${parts.join("，")}${reason ? `（${reason}）` : ""}${failLines.length ? "；失败的书仍在待下载队列，可稍后重试或等次日巡检" : ""}`);
  } else if (full.includes("HTTP ") || full.includes("[error]")) {
    toast("下载未成功启动，详见日志");
  }
  if (activeTab === "reco") void loadReco(); // 成功的书入库后立刻从队列消失
}

// ---------- 事件与启动 ----------
// ---------- 书库新鲜度检查（新书下载后不用刷新浏览器）----------
let libRefreshBusy = false;

/** 轻量探针：/api/health 只返回计数，开销极小 */
async function libFreshDelta(): Promise<number> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return 0;
    const d = (await res.json()) as { books?: number };
    const now = Number(d.books) || 0;
    return now > allBooks.length ? now - allBooks.length : 0;
  } catch {
    return 0;
  }
}

/** 有新书才重新拉取书目并重绘当前视图（保留搜索/书架/分类状态） */
async function refreshBooksIfFresh(reason: "tab" | "visible" | "poll"): Promise<boolean> {
  if (libRefreshBusy) return false;
  const added = await libFreshDelta();
  if (!added) return false;
  libRefreshBusy = true;
  try {
    const res = await fetch("/api/books", { cache: "no-store" });
    const data = (await res.json()) as { books?: typeof allBooks };
    if (!Array.isArray(data.books)) return false;
    allBooks = data.books;
    renderActive();
    toast(`书库已更新：新增 ${added} 本`);
    return true;
  } catch {
    return false;
  } finally {
    libRefreshBusy = false;
  }
}

function switchTab(tab: string): void {
  activeTab = tab;
  savePrefs();
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab));
  $("#view-library").classList.toggle("hidden", tab !== "library");
  $("#view-recent").classList.toggle("hidden", tab !== "recent");
  $("#view-reco").classList.toggle("hidden", tab !== "reco");
  if (tab === "recent") renderRecent();
  if (tab === "library") renderLibrary();
  if (tab === "reco") void loadReco();
  // 切回来时先同步渲染（立即响应），再检查服务端是否有新书
  if (tab === "recent" || tab === "library") void refreshBooksIfFresh("tab");
}

async function boot(): Promise<void> {
  const [booksRes, shelfRes] = await Promise.all([
    fetch("/api/books"),
    fetch("/api/shelves").catch(() => null),
  ]);
  const data = await booksRes.json();
  allBooks = data.books || [];
  if (shelfRes && shelfRes.ok) {
    try {
      shelfData = ((await shelfRes.json()).items || {}) as Record<string, ShelfRecord>;
    } catch {
      shelfData = {};
    }
  }

  // 默认进入：有上次记录就恢复；首次则"在读"非空进在读，否则进新书速递
  const prefs = loadPrefs();
  const hasReading = shelfCount("reading") > 0;
  activeTab = prefs.tab === "library" || prefs.tab === "recent" || prefs.tab === "reco"
    ? prefs.tab
    : hasReading ? "library" : "recent";
  activeShelf = prefs.shelf === "all" || prefs.shelf === "reading" || prefs.shelf === "fav" || prefs.shelf === "done"
    ? prefs.shelf
    : hasReading ? "reading" : "all";
  activeCat = prefs.cat || "全部";
  if (activeCat !== "全部" && !allBooks.some((b) => b.category === activeCat)) activeCat = "全部";

  renderShelves();
  renderCats();
  switchTab(activeTab);
  if (activeTab === "library") renderLibrary();

  document.querySelectorAll(".tab").forEach((el) =>
    el.addEventListener("click", () => switchTab((el as HTMLElement).dataset.tab || "library")));

  // 书架按钮（卡片内 / 详情弹层内，事件委托）
  document.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest?.(".sbtn, .sbtn-wide") as HTMLElement | null;
    if (!btn) return;
    ev.preventDefault();
    const card = btn.closest(".book") as HTMLElement | null;
    const rel = card?.dataset.rel || btn.dataset.rel;
    const shelf = btn.dataset.shelf as ShelfName | undefined;
    if (rel && shelf) void toggleShelf(rel, shelf);
  });

  // 云端书下载拦截：先预热取回，就绪后再真正下载（卡片与详情弹层通用）
  document.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest?.("a.dl-link") as HTMLAnchorElement | null;
    if (!a) return;
    const box = a.closest("[data-dataless]") as HTMLElement | null;
    if (!box || box.dataset.dataless !== "1") return;
    const rel = (a.closest(".book") as HTMLElement | null)?.dataset.rel || box.dataset.rel || "";
    if (!rel) return;
    ev.preventDefault();
    toast("☁️ 本书数据在 iCloud，正在取回…", true);
    void waitForReady(rel, (s) => toast(s, true)).then((ok) => {
      if (ok) {
        toastHide();
        location.href = a.href;
      } else {
        toast("取回超时或失败：可在 Finder 中找到本书手动点开一次后重试");
      }
    });
  });

  // 点击卡片 → 图书详情（完整简介 / 目录 / 元数据）；互动元素各自处理，不触发详情
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const more = t.closest?.(".morelink") as HTMLElement | null;
    if (more?.dataset.rel) {
      ev.preventDefault();
      void openDetail(more.dataset.rel);
      return;
    }
    if (t.closest?.("a, button")) return;
    const card = t.closest?.(".book[data-rel]") as HTMLElement | null;
    if (card?.dataset.rel) void openDetail(card.dataset.rel);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeDetail();
      closeMeta();
      closeEdit();
      return;
    }
    const card = (ev.target as HTMLElement)?.closest?.(".book[data-rel]") as HTMLElement | null;
    if (card?.dataset.rel && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      void openDetail(card.dataset.rel);
    }
  });
  $("#btnMeta").addEventListener("click", () => void openMeta(false));
  $("#gapRefresh").addEventListener("click", () => void loadGaps());
  $("#gapList").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const row = t.closest(".gaprow") as HTMLElement | null;
    if (!row) return;
    const rel = row.dataset.rel || "";
    const g = gapItems.find((x) => x.rel === rel);
    if (!g) return;
    if (t.closest(".gapFind")) void gapFindCandidates(row, g);
    else if (t.closest(".gapManual")) gapManualForm(row, g);
    else if (t.closest(".gapUndo")) void gapUndo(g);
  });
  $("#metaClose").addEventListener("click", closeMeta);
  $("#metaMask").addEventListener("click", (ev) => {
    if (ev.target === $("#metaMask")) closeMeta();
  });
  $("#metaBuild").addEventListener("click", () => void runMetaTasks(["build"]));
  $("#metaEnrich").addEventListener("click", () => void runMetaTasks(["enrich"]));
  $("#metaCatalog").addEventListener("click", () => void runMetaTasks(["catalog"]));
  $("#metaAll").addEventListener("click", () => void runMetaTasks(["build", "enrich", "catalog"]));
  $("#btnPushCfg").addEventListener("click", () => void openPushCfg());
  $("#pushCancel").addEventListener("click", closePushCfg);
  $("#metaLinkCancel").addEventListener("click", closeMetaLink);
  $("#btnAudit").addEventListener("click", () => void openAudit());
  $("#auditClose").addEventListener("click", () => $("#auditMask").classList.add("hidden"));
  $("#auditRefresh").addEventListener("click", () => void renderAuditList());
  $("#auditMask").addEventListener("click", (ev) => {
    if (ev.target === $("#auditMask")) $("#auditMask").classList.add("hidden");
  });
  $("#auditList").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const item = t.closest(".audit-item") as HTMLElement | null;
    const rel = item?.dataset.rel || t.dataset.rel || "";
    if (!rel) return;
    if (t.dataset.act === "rematch") void rematchBook(rel);
    if (t.dataset.act === "link") {
      metaLinkRel = rel;
      void openMetaLink();
    }
  });
  $("#metaLinkSave").addEventListener("click", () => void saveMetaLink());
  $("#metaLinkMask").addEventListener("click", (ev) => {
    if (ev.target === $("#metaLinkMask")) closeMetaLink();
  });
  ($("#metaLinkUrl") as HTMLInputElement).addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") void saveMetaLink();
  });
  $("#pushSave").addEventListener("click", () => void savePushCfg());
  $("#pushMask").addEventListener("click", (ev) => {
    if (ev.target === $("#pushMask")) closePushCfg();
  });
  ($("#pushUrl") as HTMLInputElement).addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") void savePushCfg();
  });
  $("#detailClose").addEventListener("click", closeDetail);
  $("#dActions").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "dPush" || t.closest("#dPush")) {
      const menu = document.getElementById("dPushMenu");
      const opening = menu?.classList.contains("hidden") === true;
      closeMenus();
      if (opening) menu?.classList.remove("hidden");
      return;
    }
    const pushItem = t.closest("[data-push]") as HTMLElement | null;
    if (pushItem) {
      void pushWithFormat((pushItem.dataset.push as "orig" | "epub") || "orig");
      return;
    }
    if (t.classList.contains("editbtn")) void openEditFromDetail();
    if (t.id === "dConvert") void convertBook();
    if (t.id === "dMetaLink") {
      metaLinkRel = detailRel;
      void openMetaLink();
    }
    if (t.id === "dMore") {
      const more = document.getElementById("dMoreActions");
      document.getElementById("dPushMenu")?.classList.add("hidden");
      const open = more?.classList.toggle("hidden") === false;
      (t as HTMLButtonElement).setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (t.id === "dRematch") {
      const rel = detailRel;
      if (rel) void rematchBook(rel);
    }
  });
  $("#edClose").addEventListener("click", closeEdit);
  $("#editMask").addEventListener("click", (ev) => {
    if (ev.target === $("#editMask")) closeEdit();
  });
  $("#edSuggest").addEventListener("click", () => void previewCleanName());
  $("#edTitleSuggest").addEventListener("click", () => void suggestTitle());
  $("#edSave").addEventListener("click", () => void saveEdit());
  $("#edUndo").addEventListener("click", () => {
    const rel = editState?.rel || "";
    if (rel) void undoRename(rel);
  });
  $("#detailMask").addEventListener("click", (ev) => {
    if (ev.target === $("#detailMask")) closeDetail();
  });
  void refreshMetaNotice();
  void loadReco(); // 开页即拉一次待确认清单，让徽标直接显示待处理数量
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("#dPushMenu") || t.closest("#dPush") || t.closest("#dMoreActions") || t.closest("#dMore")) return;
    closeMenus();
  });
  $("#search").addEventListener("input", renderActive);
  $("#moreLibrary").addEventListener("click", showMore);
  $("#moreRecent").addEventListener("click", showMore);
  setupAutoLoad();
  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      ($("#search") as HTMLInputElement).focus();
    }
  });
  $("#recoRefresh").addEventListener("click", () => void loadReco());
  $("#recoAll").addEventListener("click", () => {
    recos.forEach((r) => recoSel.add(r.id));
    renderReco();
  });
  $("#recoNone").addEventListener("click", () => {
    recoSel.clear();
    renderReco();
  });
  $("#recoApprove").addEventListener("click", () => void decideReco(selectedRecoIds(), [], recoAutoDl));
  $("#recoAutoDl").addEventListener("change", (ev) => {
    recoAutoDl = (ev.target as HTMLInputElement).checked;
    savePrefs();
    renderReco();
    toast(recoAutoDl ? "已开启：确认时立即下载" : "已关闭：只批准，交给每日巡检下载");
  });
  $("#recoReject").addEventListener("click", () => {
    const ids = selectedRecoIds();
    if (!ids.length) return toast("请先勾选要处理的条目");
    rejectConfirm(ids, `将把 ${ids.length} 本标记为「不要了」（之后不再推荐）：ID ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? " …" : ""}`);
  });
  $("#recoList").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const id = Number(t.dataset.id || 0);
    if (!id) return;
    if (t.classList.contains("rq-approve")) void decideReco([id], [], recoAutoDl);
    else if (t.classList.contains("rq-reject")) {
      rejectConfirm([id], `将把「${txt(recos.find((r) => r.id === id)?.title || String(id))}」标记为「不要了」（之后不再推荐）`);
    }
  });
  $("#recoList").addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement;
    const id = Number(t.dataset.id || 0);
    if (!id) return;
    if (t.checked) recoSel.add(id); else recoSel.delete(id);
    // 直接从推荐浏览下载（未经批准）的书已入库 → 不再要求确认，这里说明去处
  const inLibBox = document.getElementById("recoInLibrary");
  if (inLibBox) {
    if (recoInLibrary.length) {
      inLibBox.classList.remove("hidden");
      inLibBox.innerHTML = `✅ 另有 ${recoInLibrary.length} 本已在书库（未经批准直接下载，账本尚未记账，已自动移出待确认）：${recoInLibrary
        .map((r) => esc(r.title.slice(0, 22)))
        .join("、")}`;
    } else {
      inLibBox.classList.add("hidden");
      inLibBox.innerHTML = "";
    }
  }
  const count = document.getElementById("recoCount");
    if (count) count.textContent = `待确认 ${recos.length} 本 · 已选 ${recoSel.size} 本`;
  });
  $("#confirmCancel").addEventListener("click", () => $("#confirmMask").classList.add("hidden"));
  $("#logClose").addEventListener("click", () => {
    $("#logMask").classList.add("hidden");
    if (activeTab === "reco") void loadReco();
  });
}

void boot();
