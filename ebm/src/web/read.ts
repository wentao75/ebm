// read.ts —— 在线预览：PDF(pdf.js Range) / EPUB(epub.js) / TXT（设计文档四-5）
declare const pdfjsLib: any;
declare const ePub: any;

// —— 页面级错误可视化：任何 JS 错误直接显示在页面上（不再静默白屏）——
function showErr(scope: string, err: unknown): void {
  const bar = document.getElementById("errbar");
  if (!bar) return;
  bar.style.display = "block";
  bar.textContent += `[${scope}] ${String((err as Error)?.stack || err)}\n`;
}
window.addEventListener("error", (e) => showErr("window", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showErr("promise", e.reason));
console.log("[ebm] 阅读器 v2.5 · " + location.href);

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => {
  const el = document.querySelector(s);
  if (!el) throw new Error("missing " + s);
  return el as T;
};

const params = new URLSearchParams(location.search);
const rel = params.get("path") || "";
const ext = (rel.split(".").pop() || "").toLowerCase();
const bookName = decodeURIComponent(rel.split("/").pop() || rel);
const url = `/api/file?path=${encodeURIComponent(rel)}&disp=inline`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- 阅读器偏好（每台设备各自记忆）----------
interface ReaderPrefs { zoom: string; mode: "scroll" | "single"; v?: number }
const READER_KEY = "ebm.reader";
/** v2 起默认"适合整页 + 单页模式"；用户一旦改过就沿用其选择（写入即带 v） */
const READER_VERSION = 2;
const READER_DEFAULT: ReaderPrefs = { zoom: "page", mode: "single", v: READER_VERSION };

function loadReaderPrefs(): ReaderPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(READER_KEY) || "{}") as { zoom?: unknown; mode?: unknown; v?: unknown };
    // 旧版本（无 v 或 v<2）只在升级当次套用新默认，之后完全尊重用户选择
    if (p.v !== READER_VERSION) return { ...READER_DEFAULT };
    return {
      zoom: typeof p.zoom === "string" && p.zoom ? p.zoom : READER_DEFAULT.zoom,
      mode: p.mode === "single" ? "single" : "scroll",
      v: READER_VERSION,
    };
  } catch {
    return { ...READER_DEFAULT };
  }
}
function saveReaderPrefs(p: ReaderPrefs): void {
  try {
    localStorage.setItem(READER_KEY, JSON.stringify({ zoom: p.zoom, mode: p.mode, v: READER_VERSION }));
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

// ---------- 阅读进度（去抖上报；离开页面时兜底）----------
let currentPage = 1;
let lastSavedPage = 0;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
function flushProgress(): void {
  if (!rel || currentPage < 1 || currentPage === lastSavedPage) return;
  lastSavedPage = currentPage;
  const body = JSON.stringify({ rel, page: currentPage });
  try {
    void fetch("/api/shelves/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 进度丢失可接受，不能因此打断阅读 */
  }
}
function saveProgress(): void {
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, 3000);
}
window.addEventListener("pagehide", flushProgress);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushProgress();
});

/** 读取服务端保存的阅读状态（进度 + 是否在读） */
async function fetchShelfRecord(): Promise<{ page?: number; reading?: boolean }> {
  try {
    const res = await fetch("/api/shelves");
    const items = ((await res.json()).items || {}) as Record<string, { page?: number; reading?: boolean }>;
    return items[rel] || {};
  } catch {
    return {};
  }
}

/** 打开即标记"在读"（已标记则跳过） */
async function markReading(): Promise<void> {
  try {
    const rec = await fetchShelfRecord();
    if (rec.reading) return;
    await fetch("/api/shelves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel, shelf: "reading", value: true }),
    });
  } catch {
    /* 标记失败不影响阅读 */
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast hidden";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

$("#title").textContent = bookName;
($("#btnDownload") as HTMLAnchorElement).href = `/api/file?path=${encodeURIComponent(rel)}&disp=attachment`;
($("#btnDownload") as HTMLAnchorElement).download = bookName;

async function renderPdf(): Promise<void> {
  $("#epubbox").classList.add("hidden");
  const box = $("#pdfbox");
  box.classList.remove("hidden");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";

  // Range Request 分段加载：翻到哪里才取哪段（服务端支持 Accept-Ranges）
  // 看门狗：worker 脚本被浏览器插件拦截时会永久挂起，25s 后明确报错而不是无限白屏
  const docPromise = pdfjsLib.getDocument({
    url,
    disableAutoFetch: true,
    disableStream: false,
  }).promise as Promise<any>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pdf = await Promise.race([
    docPromise,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(
        "PDF 解析超时（25 秒）——pdf.worker 脚本疑似被浏览器插件拦截或缓存异常。请用无痕窗口（⌘⇧N）重开本页验证。",
      )), 25000);
    }),
  ]).finally(() => clearTimeout(timer));
  const total = pdf.numPages as number;
  const pageinfo = $("#pageinfo");

  // —— 缩放与模式（v2.5）：适合宽度 / 适合整页 / 百分比，选择按设备记忆 ——
  const prefs = loadReaderPrefs();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // 清晰度与内存折中
  const PX_PER_PT = 96 / 72; // PDF 点 → CSS 像素（100% 即原始尺寸）
  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  let zoomKey = prefs.zoom;
  let cssW = 0;
  let scale = 1;

  /** 目标页宽：适合宽度 / 适合整页 / 百分比 */
  function targetWidth(): number {
    const boxW = Math.max(280, box.clientWidth - 24);
    if (zoomKey === "width") return Math.min(boxW, 1400);
    if (zoomKey === "page") {
      const boxH = Math.max(220, box.clientHeight - 24);
      return Math.min(boxW, (boxH * vp1.width) / vp1.height);
    }
    const pct = Math.min(400, Math.max(25, Number(zoomKey) || 100));
    return Math.max(120, vp1.width * PX_PER_PT * (pct / 100));
  }

  function layoutHolders(): void {
    cssW = targetWidth();
    scale = cssW / vp1.width;
    for (const h of holders) {
      h.style.width = `${Math.round(cssW)}px`;
      h.style.height = `${Math.round(vp1.height * scale)}px`;
    }
  }

  /** 当前等效倍率（相对 PDF 原始尺寸） */
  function currentPercent(): number {
    return Math.round((cssW / (vp1.width * PX_PER_PT)) * 100);
  }

  // 占位容器：先按第 1 页尺寸摆放（多数书页面统一；渲染时若有出入再校正）
  const holders: HTMLElement[] = [];
  for (let i = 1; i <= total; i++) {
    const holder = document.createElement("div");
    holder.className = "pageholder";
    holder.dataset.page = String(i);
    holder.innerHTML = `<span class="pagenum">${i}</span>`;
    box.appendChild(holder);
    holders.push(holder);
  }
  layoutHolders();

  const rendered = new Map<number, HTMLCanvasElement>();
  const inflight = new Set<number>();
  let chain: Promise<void> = Promise.resolve(); // 串行渲染队列，避免并发撕裂

  async function renderPage(num: number): Promise<void> {
    if (rendered.has(num) || inflight.has(num) || num < 1 || num > total) return;
    const holder = holders[num - 1];
    holder.dataset.want = "1"; // 明确表达"这页要展示"（避免渲染完成后被误判丢弃）
    inflight.add(num);
    chain = chain.then(async () => {
      if (rendered.has(num)) return; // 排队期间可能已被相邻触发渲染
      const page = await pdf.getPage(num);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.className = "pagecanvas";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      // 仍需展示时才挂载（可能已滚出窗口被卸载）
      if (holder.isConnected && holder.dataset.want === "1") {
        holder.replaceChildren(canvas);
        holder.style.width = `${Math.round(vp.width / dpr)}px`;
        holder.style.height = `${Math.round(vp.height / dpr)}px`;
        rendered.set(num, canvas);
      }
    }).catch(() => {}).finally(() => inflight.delete(num));
    await chain;
  }

  function unloadPage(num: number): void {
    const canvas = rendered.get(num);
    if (!canvas) return;
    const holder = holders[num - 1];
    const span = document.createElement("span");
    span.className = "pagenum";
    span.textContent = String(num);
    holder.replaceChildren(span);
    rendered.delete(num); // 释放 canvas 内存
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const num = Number((e.target as HTMLElement).dataset.page);
        if (e.isIntersecting) {
          (e.target as HTMLElement).dataset.want = "1";
          void renderPage(num);
          void renderPage(num + 1);
          void renderPage(num - 1);
        } else {
          delete (e.target as HTMLElement).dataset.want;
          unloadPage(num); // 滚出 ±2 屏即释放
        }
      }
    },
    { root: box, rootMargin: "200% 0px 200% 0px" },
  );
  holders.forEach((h) => io.observe(h));

  // 页码指示：连续模式按滚动位置估算；单页模式由 showSingle 维护
  let singleCur = 1;
  const isSingle = (): boolean => prefs.mode === "single";
  function updatePageInfo(): void {
    pageinfo.textContent = `${currentPage} / ${total} 页`;
  }
  box.addEventListener("scroll", () => {
    if (isSingle()) return;
    const avg = box.scrollHeight / total;
    currentPage = Math.min(total, Math.max(1, Math.round(box.scrollTop / avg) + 1));
    updatePageInfo();
    saveProgress();
  }, { passive: true });

  // —— 阅读导航（v2.4）：悬浮按钮 ☰ 目录 / ⌃ 回到顶部；点页码输入跳页 ——
  pageinfo.style.cursor = "pointer";
  pageinfo.title = "点击输入页码跳转";
  pageinfo.addEventListener("click", () => {
    const s = window.prompt(`跳转到页码（1-${total}）：`, String(currentPage));
    const n = parseInt(s || "", 10);
    if (n >= 1 && n <= total) jumpTo(n);
  });

  const jumpTo = (n: number): void => {
    holders[Math.min(total, Math.max(1, n)) - 1].scrollIntoView({ block: "start" });
    closeToc();
  };
  const closeToc = (): void => {
    document.getElementById("tocpanel")?.remove();
    document.getElementById("tocmask")?.remove();
  };
  const openToc = async (): Promise<void> => {
    if (document.getElementById("tocpanel")) { closeToc(); return; } // 再点一次=关闭
    const mask = document.createElement("div");
    mask.id = "tocmask";
    mask.addEventListener("click", closeToc);
    const panel = document.createElement("div");
    panel.id = "tocpanel";
    panel.innerHTML = `<h3>目录</h3><div style="padding:10px;color:#888;font-size:12.5px">加载中…</div>`;
    document.body.append(mask, panel);
    // 1) 优先用 PDF 内嵌书签
    type TocItem = { title: string; page: number | null; depth: number; dest?: any };
    let items: TocItem[] = [];
    try {
      const destToPage = async (dest: any): Promise<number | null> => {
        try {
          if (dest == null) return null;
          if (typeof dest === "string") dest = await pdf.getDestination(dest);
          if (!Array.isArray(dest) || !dest[0]) return null;
          return (await pdf.getPageIndex(dest[0])) + 1;
        } catch { return null; }
      };
      const outline = await pdf.getOutline();
      const walk = (arr: any[], depth: number): void => {
        for (const it of arr || []) {
          items.push({ title: it.title || "(无标题)", page: null, depth, dest: it.dest });
          if (it.items?.length) walk(it.items, depth + 1);
        }
      };
      if (outline?.length) walk(outline, 0);
      for (const it of items) it.page = await destToPage(it.dest);
      items = items.filter((it) => it.page != null);
    } catch { items = []; }
    // 纯页码书签（扫描版 PDF 常见：书签只有"1""2""3"…）折叠进"按页跳转"，避免目录被噪音淹没
    const isBarePage = (t: string): boolean => /^\d{1,4}$/.test(t.trim());
    const named = items.filter((it) => !isBarePage(it.title));
    const numeric = items.filter((it) => isBarePage(it.title));
    const keepNamed = named.length >= 3;
    const listItems = keepNamed ? named : items;

    if (listItems.length) {
      const sub = keepNamed && numeric.length ? ` · 已折叠 ${numeric.length} 个纯页码书签` : "";
      panel.innerHTML = `<h3>目录（${listItems.length} 条${sub}）</h3>` + listItems
        .map((it) => `<button class="tocitem" data-pg="${it.page}" style="padding-left:${12 + it.depth * 14}px">${esc(it.title)}<span class="pg">P${it.page}</span></button>`)
        .join("");
      panel.querySelectorAll(".tocitem").forEach((b) =>
        b.addEventListener("click", () => jumpTo(Number((b as HTMLElement).dataset.pg) || 1)));
    }

    // 追加"按页跳转"网格：无目录时是兜底；有目录但页码书签很多时，作为折叠后的补偿入口
    const showGrid = listItems.length === 0 || (keepNamed && numeric.length >= 10);
    if (showGrid) {
      const wrap = document.createElement("div");
      wrap.className = "tocgridwrap";
      wrap.innerHTML =
        `<div class="tocgroup">${listItems.length ? "按页跳转" : `无内嵌目录 · 点页码跳转（共 ${total} 页）`}</div>` +
        `<div class="tocgrid">${Array.from({ length: total }, (_, i) => `<button data-pg="${i + 1}">${i + 1}</button>`).join("")}</div>`;
      panel.appendChild(wrap);
      wrap.querySelectorAll(".tocgrid button").forEach((b) =>
        b.addEventListener("click", () => jumpTo(Number((b as HTMLElement).dataset.pg))));
    }
  };

  const fabwrap = document.createElement("div");
  fabwrap.className = "fabwrap";
  fabwrap.innerHTML = `<button class="fab" id="fabToc" title="目录 / 跳页">☰</button>
    <button class="fab" id="fabTop" title="回到第 1 页">⌃</button>`;
  document.body.appendChild(fabwrap);
  fabwrap.querySelector("#fabToc")!.addEventListener("click", () => void openToc());
  fabwrap.querySelector("#fabTop")!.addEventListener("click", () => jumpTo(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Home") { e.preventDefault(); jumpTo(1); }
    if (e.key === "Escape") closeToc();
  });

  // —— 缩放工具条（v2.5）——
  function updateZoomLabel(): void {
    const label = document.getElementById("zlabel");
    if (label) label.textContent = `${currentPercent()}%`;
    zoombar.querySelectorAll<HTMLElement>(".zb[data-zoom]").forEach((b) =>
      b.classList.toggle("on", b.dataset.zoom === zoomKey));
  }

  /** 重新排版并重绘可见页（缩放/模式切换共用） */
  function relayout(): void {
    const ratio = box.scrollHeight ? box.scrollTop / box.scrollHeight : 0;
    for (const n of [...rendered.keys()]) unloadPage(n);
    layoutHolders();
    box.scrollTop = Math.round(ratio * box.scrollHeight);
    if (isSingle()) {
      showSingle(currentPage);
    } else {
      const view = Math.min(total, Math.max(1, Math.round(box.scrollTop / (box.scrollHeight / total)) + 1));
      for (let n = Math.max(1, view - 1); n <= Math.min(total, view + 2); n++) void renderPage(n);
    }
    updateZoomLabel();
    updatePageInfo();
  }

  function setZoom(key: string): void {
    zoomKey = key;
    prefs.zoom = key;
    saveReaderPrefs(prefs);
    relayout();
  }

  function stepZoom(delta: number): void {
    setZoom(String(Math.min(400, Math.max(25, currentPercent() + delta))));
  }

  // —— 单页翻页模式 ——
  function showSingle(n: number): void {
    singleCur = Math.min(total, Math.max(1, n));
    currentPage = singleCur;
    holders.forEach((h, i) => {
      h.classList.toggle("current", i + 1 === singleCur);
      if (i + 1 !== singleCur) {
        delete h.dataset.want;
        unloadPage(i + 1);
      }
    });
    box.scrollTop = 0;
    void renderPage(singleCur);
    void renderPage(singleCur + 1); // 预取下一页
    updatePageInfo();
    saveProgress();
  }

  function setMode(mode: "scroll" | "single"): void {
    prefs.mode = mode;
    saveReaderPrefs(prefs);
    box.classList.toggle("single", mode === "single");
    const btn = document.getElementById("btnMode");
    if (btn) btn.textContent = mode === "single" ? "连续滚动" : "单页模式";
    if (mode === "single") {
      showSingle(currentPage);
    } else {
      holders.forEach((h) => h.classList.remove("current"));
      const view = currentPage;
      for (let n = Math.max(1, view - 1); n <= Math.min(total, view + 2); n++) void renderPage(n);
      box.scrollTop = ((view - 1) / total) * box.scrollHeight;
      updatePageInfo();
    }
    updateZoomLabel();
  }

  const zoombar = document.createElement("div");
  zoombar.className = "zoombar";
  zoombar.innerHTML = `
    <button class="zb" data-zoom="out" title="缩小">－</button>
    <button class="zb" data-zoom="width" title="适合宽度">适合宽度</button>
    <button class="zb" data-zoom="page" title="适合整页">适合整页</button>
    <button class="zb" data-zoom="100">100%</button>
    <button class="zb" data-zoom="125">125%</button>
    <button class="zb" data-zoom="150">150%</button>
    <button class="zb" data-zoom="in" title="放大">＋</button>
    <span class="zlabel" id="zlabel"></span>
    <span class="zsep"></span>
    <button class="zb" id="btnMode" title="切换连续滚动 / 单页翻页">单页模式</button>
    <button class="zb" id="btnUnread" title="把本书移出在读">移出在读</button>`;
  document.body.appendChild(zoombar);
  zoombar.querySelector('[data-zoom="out"]')!.addEventListener("click", () => stepZoom(-10));
  zoombar.querySelector('[data-zoom="in"]')!.addEventListener("click", () => stepZoom(10));
  zoombar.querySelectorAll<HTMLElement>(".zb[data-zoom]").forEach((b) => {
    const k = b.dataset.zoom || "";
    if (k === "out" || k === "in") return;
    b.addEventListener("click", () => setZoom(k));
  });
  document.getElementById("btnMode")!.addEventListener("click", () => setMode(isSingle() ? "scroll" : "single"));
  document.getElementById("btnUnread")!.addEventListener("click", () => {
    void fetch("/api/shelves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel, shelf: "reading", value: false }),
    })
      .then(() => toast("已移出「在读」"))
      .catch(() => toast("操作失败，请重试"));
  });

  // 单页模式：左右滑动 / 点击两侧翻页（iPad 触屏友好）
  let touchX = 0;
  box.addEventListener("touchstart", (e) => { touchX = e.touches[0]?.clientX || 0; }, { passive: true });
  box.addEventListener("touchend", (e) => {
    if (!isSingle()) return;
    const dx = (e.changedTouches[0]?.clientX || 0) - touchX;
    if (Math.abs(dx) > 60) showSingle(singleCur + (dx < 0 ? 1 : -1));
  }, { passive: true });
  box.addEventListener("click", (e) => {
    if (!isSingle()) return;
    const r = box.getBoundingClientRect();
    const x = (e as MouseEvent).clientX - r.left;
    if (x < r.width * 0.25) showSingle(singleCur - 1);
    else if (x > r.width * 0.75) showSingle(singleCur + 1);
  });

  // 键盘：⌘±/⌘0 缩放，单页模式左右键/空格翻页
  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "+" || e.key === "=")) { e.preventDefault(); stepZoom(10); return; }
    if (meta && e.key === "-") { e.preventDefault(); stepZoom(-10); return; }
    if (meta && e.key === "0") { e.preventDefault(); setZoom("width"); return; }
    if (isSingle()) {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); showSingle(singleCur + 1); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); showSingle(singleCur - 1); }
    }
  });

  // —— 首次进入：应用记忆的模式、续读、自动标记"在读" ——
  setMode(prefs.mode);
  box.scrollTop = 0;
  currentPage = 1;
  await renderPage(1); // 首屏立即可见
  const saved = await fetchShelfRecord();
  if (saved.page && saved.page > 1 && saved.page <= total) {
    currentPage = saved.page;
    if (isSingle()) showSingle(saved.page);
    else jumpTo(saved.page);
    updatePageInfo();
    toast(`已跳到上次读到第 ${saved.page} 页`);
    lastSavedPage = saved.page;
  } else {
    updatePageInfo();
  }
  updateZoomLabel();
  void markReading();
  console.log(`[ebm] PDF 就绪：${total} 页 · 占位 ${holders.length} 个 · 模式 ${prefs.mode} · 倍率 ${currentPercent()}%`);
}
async function renderEpub(): Promise<void> {
  const box = $("#epubbox");
  const book = ePub(url);
  const rendition = book.renderTo(box, { width: "100%", height: "100%", spread: "auto" });
  await rendition.display();
  // 左右键 / 边缘点击翻页
  rendition.on("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "ArrowRight") rendition.next();
    if (ev.key === "ArrowLeft") rendition.prev();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowRight") rendition.next();
    if (ev.key === "ArrowLeft") rendition.prev();
  });
}

async function renderTxt(): Promise<void> {
  $("#epubbox").classList.add("hidden");
  const box = $("#txtbox");
  box.classList.remove("hidden");
  const text = await fetch(url).then((r) => r.text());
  box.textContent = text;
}

async function waitCloudReady(): Promise<boolean> {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`/api/materialized?path=${encodeURIComponent(rel)}`);
      const d = await r.json();
      if (d.ready) return true;
      if (d.status === "failed") return false;
      msg(`☁️ 本书数据在 iCloud 云端，正在取回…<br/><span style="color:#999;font-size:12.5px">首次打开冷门书需要一点时间（取决于网速与 ${esc(bookName.slice(0, 20))}… 的大小）</span>`);
    } catch {
      msg("网络波动，继续等待…");
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

function msg(html: string): void {
  const box = ensureCloudMask();
  box.innerHTML = `<div class="spin">☁️</div><div>${html}</div>`;
}

function ensureCloudMask(): HTMLElement {
  let m = document.querySelector(".cloudmask") as HTMLElement | null;
  if (!m) {
    m = document.createElement("div");
    m.className = "cloudmask";
    document.body.appendChild(m);
  }
  return m;
}

function removeCloudMask(): void {
  document.querySelector(".cloudmask")?.remove();
}

async function main(): Promise<void> {
  if (!rel) return;
  const pageinfo = $("#pageinfo");
  try {
    pageinfo.textContent = "① 检查云端状态…";
    // 云端书：先等取回完成再交给阅读器
    msg("正在检查本书状态…");
    const ready = await waitCloudReady();
    if (!ready) {
      msg("取回超时或失败。<br/>可在 Finder 中找到本书手动点开一次，再刷新本页重试。");
      return;
    }
    removeCloudMask();
    pageinfo.textContent = "② 解析文档结构…";
    if (ext === "pdf") await renderPdf();
    else if (ext === "epub") await renderEpub();
    else if (ext === "txt") await renderTxt();
    else {
      $("#epubbox").classList.add("hidden");
      $("#fallback").classList.remove("hidden");
      $("#fallback").innerHTML = `${esc(ext.toUpperCase())} 格式暂不支持在线预览，请下载后用本地阅读器打开。<br/>
        <a href="/api/file?path=${encodeURIComponent(rel)}&disp=attachment" style="color:#8fd0ff">⬇ 下载本书</a>`;
    }
  } catch (err) {
    showErr("main", err);
    $("#epubbox").classList.add("hidden");
    $("#fallback").classList.remove("hidden");
    $("#fallback").textContent = `加载失败：${String(err)}`;
  }
}

void main();
