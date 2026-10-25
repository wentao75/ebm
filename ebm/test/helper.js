// test/helper.js —— 测试基建：临时书库、临时数据目录、可启动的服务实例
// 依赖为零：只用 node 内置模块 + 全局 fetch（Node 18+）
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const EBM_DIR = path.resolve(__dirname, "..");

/** 生成确定性字节内容（.pdf 带合法文件头，便于按扩展名走分支） */
function makeBytes(rel, size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + rel.length) % 251;
  const head = Buffer.from(rel.toLowerCase().endsWith(".pdf") ? "%PDF-1.4\n" : "ebm-test\n");
  head.copy(buf, 0);
  return buf;
}

/** 生成一个真正可被 pdf.js 解析的多页 PDF（阅读器测试需要） */
/** 生成"有真实文字层"的 PDF（每页约 200 字符）：用于 PDF→EPUB 转换的测试与 UI 端到端 */
async function makeTextPdf(file, pages = 4) {
  const objs = [];
  const add = (b) => {
    objs.push(b);
    return objs.length;
  };
  const catalog = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  const para =
    "The quick brown fox jumps over the lazy dog. This paragraph exists so that the PDF has a real text layer with enough characters per page to be classified as a text document rather than a scanned one. ";
  for (let i = 1; i <= pages; i++) {
    let y = 740;
    const ops = [`Page ${i}`, para, para]
      .map((t) => `BT /F1 14 Tf 60 ${(y -= 22)} Td (${t.replace(/[()\\]/g, "")}) Tj ET`)
      .join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, "utf-8"));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "utf-8");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, out);
  return file;
}

function makePdf(pageCount = 12) {
  const objs = [];
  const add = (body) => {
    objs.push(body);
    return objs.length; // 1 起的对象号
  };
  const catalogId = add(""); // 先占位，最后回填
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  for (let i = 1; i <= pageCount; i++) {
    const content = `BT /F1 28 Tf 72 700 Td (Page ${i} of ${pageCount}) Tj ET`;
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`),
    );
  }
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const DEFAULT_FILES = [
  ["历史/明朝那些事儿.pdf", 0], // 0 = 用生成的合法 PDF
  ["历史/万历十五年.txt", 3000],
  ["IT&技术/The RLHF Book.epub", 5000],
];

async function tmpDir(prefix = "ebm-test-") {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 造一个隔离的临时书库，返回 { root, files }（files 里是实际字节数） */
async function makeLibrary(files = DEFAULT_FILES, pdfPages = 12) {
  const root = await tmpDir("ebm-lib-");
  const actual = [];
  for (const [rel, size] of files) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const buf = rel.toLowerCase().endsWith(".pdf") ? makePdf(pdfPages) : makeBytes(rel, size);
    await fsp.writeFile(abs, buf);
    actual.push([rel, buf.length]);
  }
  return { root, files: actual, pdfRel: actual.find(([r]) => r.endsWith(".pdf"))?.[0] };
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function stop(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      resolve();
    }, 4000).unref();
  });
}

/**
 * 启动一个隔离的 ebm 实例（真实进程、真实 HTTP），返回 { base, port, stop, output }
 * 关键隔离：书库/数据目录/管道目录全部指向临时目录，绝不触碰真实书库与 yabook_watch
 */
/**
 * 管道元数据夹具（写入 post_details.json）：覆盖完整简介（>300 字，验证详情接口不受列表截断影响）、
 * 命名实体、目录、meta（出版社/译者/页数）、豆瓣分
 */
const META_FIXTURE = {
  "1": {
    id: 1,
    title: "明朝那些事儿",
    intro:
      "《明朝那些事儿》&ldquo;测试简介&rdquo;" +
      "这是一段用于验证完整简介不被截断的较长文本。".repeat(20) +
      "结尾包含 &hellip; 与 &mdash; 等命名实体。",
    tags: ["历史", "明朝", "&ldquo;通俗史&rdquo;"],
    douban: "9.1",
    meta: { 书名: "明朝那些事儿", 出版社: "中国海关出版社", 出版日期: "2009-4", 页数: "320", 译者: "测试译者" },
    // 故意用"零换行压平"的真实形态（源数据 433 本全如此）+ 抓取垃圾，验证目录整理与清洗
    toc:
      "前 言 我如何走上这条路第一章 洪武大帝&ldquo;开局&rdquo;" +
      "01. 开局就闹饥荒02. 造反有理03. 郭子兴的算盘第二章 建文帝01. 削藩02. 靖难之役后记 浏览器不支持脚本！",
  },
  // 模拟真实"无分隔符扫描版"目录（如《豪放词全鉴》）：只能按 卷/前言/提要 分行
  "2": {
    id: 2,
    title: "万历十五年",
    intro: "这是一段较短但完整的简介，用于验证第二本书的详情。",
    tags: ["历史"],
    douban: "8.9",
    meta: { 书名: "万历十五年", 出版社: "中华书局" },
    // 真实扫描版目录的形态：词牌名+作者连成一片、无分隔符，单行极长（如《豪放词全鉴》869 字/行）
    toc:
      "内容 提要前言卷一 唐词敦煌曲子词生查子摊破浣溪沙菩萨蛮李白菩萨蛮忆秦娥结袜子" +
      "张志和渔歌子渔歌子渔歌子渔歌子渔歌子戴叔伦调笑令韦应物调笑令刘禹锡杨柳枝杨柳枝浪淘沙浪淘沙杨柳枝" +
      "白居易浪淘沙忆江南柳宗元欸乃曲·渔翁杨白花姚合杨柳枝杜牧江南春杜秋金缕曲皇甫松浪淘沙摘得新采莲子" +
      "温庭筠清平乐杨柳枝韦庄菩萨蛮喜迁莺卷二 五代词李珣定风波渔歌子欧阳炯江城子冯延巳谒金门李璟摊破浣溪沙" +
      "鹿虔扆临江仙李煜破阵子乌夜啼虞美人孙光宪酒泉子定西番卷三 宋词寇准阳关引王禹偁点绛唇潘阆酒泉子柳永鹤冲天",
  },
};

/**
 * 书目元数据夹具（book_meta.json）：与真实产出一致，key 就是书库相对路径。
 * 覆盖四种形态：有简介(douban) / 无评分("0.0") / 全部源未命中(enrich_failed) / 仅雅书(带 HTML 实体)。
 * 故意**不包含**「历史/万历十五年.txt」→ 用于验证"检测到新书还没有简介"提示。
 */
const BOOK_META_FIXTURE = {
  generated_at: "2026-10-05T15:01:34",
  counts: { files: 4, matched: 2, weak: 0, none: 2 },
  enrich: { ok: 2, fail: 1, source: "all", at: "2026-10-05T15:32:47" },
  books: {
    "IT&技术/The RLHF Book.epub": {
      path: "IT&技术/The RLHF Book.epub",
      sources: { douban: "37123456" },
      title: "The RLHF Book",
      author: "Nathan Lambert",
      publisher: "在线出版",
      translator: "测试译者",
      year: "2024-9",
      pages: "312",
      douban: "8.7",
      intro: "这是一本关于 &ldquo;人类反馈强化学习&rdquo; 的书，覆盖 RLHF 与 &hellip; 相关主题。",
      author_bio: "Nathan Lambert 是 &middot; 资深研究者。",
      original_title: "The RLHF Book: A Guide",
      isbn: "9780000000001",
      tags: ["机器学习", "&ldquo;RLHF&rdquo;"],
      douban_id: "37123456",
      enriched_at: "2026-10-05T15:10:04",
    },
    "批量/测试书001.txt": {
      path: "批量/测试书001.txt",
      sources: { douban: "37000001" },
      title: "测试书001",
      author: "某作者",
      douban: "0.0",
      year: "2020",
    },
    "批量/测试书002.txt": {
      path: "批量/测试书002.txt",
      sources: {},
      title: "",
      enrich_failed: true,
    },
    "批量/测试书003.txt": {
      path: "批量/测试书003.txt",
      sources: { yabook: 999 },
      title: "测试书003",
      author: "",
      intro: "&ldquo;雅书来源&rdquo;的摘要 &mdash; 用于验证实体解码。",
      toc: "第一章 &ldquo;开局&rdquo;\n第二章",
      tags: ["历史"],
      match_score: 100,
      yabook_id: 999,
    },
  },
};

/** 检索缓存夹具：决定"待补清单"的原因分类（near_miss / no_candidate / 已命中） */
const META_CACHE_FIXTURE = {
  "douban:测试书001|某作者|": { ok: false, note: "候选不匹配(73分: 测试书001、测试书001（新版）)", data: null, at: "2026-10-05T15:00:00" },
  "douban:测试书002||": { ok: false, note: "无搜索结果", data: null, at: "2026-10-05T15:00:00" },
  "douban:测试书003||": { ok: true, note: "测试书003 (2020)", data: {}, at: "2026-10-05T15:00:00" },
};

/** 文件名 → 雅书帖 id 映射夹具：覆盖"书确实来自雅书、但详情从未缓存"的场景 */
const UNCUT_MATCH_FIXTURE = [
  { file: "测试书002.txt", id: 999, cat: "测试", folder: "批量" },
];

/**
 * 把**真实的** yabook_watch/recommend.py 复制到临时 watch 目录，让「待下载确认」的
 * sync / decisions / apply 三条链路都跑生产代码（而不是测试里仿写的 stub，避免双实现漂移）。
 * 安全性：必须同时设置 YABOOK_WATCH=<临时目录>，否则脚本会去读写仓库里真实的 tiers.json。
 */
const REAL_WATCH_DIR = path.resolve(EBM_DIR, "..", "yabook_watch");

/** T2 待定夹具：3 本（用户会批准/拒绝各一本） */
const TIERS_FIXTURE = {
  "23415": { tier: 2, folder: "学习", note: "职场表达工具书，拿不准", title: "《会思考才会表达》杜斌" },
  "23408": { tier: 2, folder: "经济&投资", note: "消费心理学", title: "《存钱心理学》埃玛·爱德华兹" },
  "23406": { tier: 2, folder: "艺术&文学", note: "书信集，边界", title: "《你的懒惰让我愁肠百结》F.S.菲茨杰拉德" },
  "23001": { tier: 1, folder: "学习", note: "已批准待下载", title: "《已批准的书》" },
  // 与测试书库里的 历史/万历十五年.txt 同名：验证"书已在书库 → 自动移出待下载队列"
  "23002": { tier: 1, folder: "历史", note: "手动下载后账本未记账的情形", title: "《万历十五年》黄仁宇" },
  // T2 且与测试书库同名：验证未经批准直接下载后不再要求确认
  "23003": { tier: 2, folder: "历史", note: "T2 但已入库", title: "《明朝那些事儿》当年明月" },
};

async function startServer({ libraryRoot, dataDir, watchDir, port, metaFixture = META_FIXTURE, bookMetaFixture = BOOK_META_FIXTURE, cacheFixture = META_CACHE_FIXTURE, uncatFixture = UNCUT_MATCH_FIXTURE, tiersFixture = null, withRecommend = false, extraEnv = {} }) {
  const listenPort = port || (await freePort());
  const watch = watchDir || path.join(dataDir, "watch");
  if (metaFixture) {
    await fsp.mkdir(watch, { recursive: true });
    await fsp.writeFile(path.join(watch, "post_details.json"), JSON.stringify(metaFixture, null, 2), "utf-8");
  }
  if (bookMetaFixture) {
    await fsp.mkdir(watch, { recursive: true });
    await fsp.writeFile(path.join(watch, "book_meta.json"), JSON.stringify(bookMetaFixture, null, 2), "utf-8");
  }
  if (cacheFixture) {
    await fsp.mkdir(watch, { recursive: true });
    await fsp.writeFile(path.join(watch, "meta_cache.json"), JSON.stringify(cacheFixture, null, 2), "utf-8");
  }
  if (uncatFixture) {
    await fsp.mkdir(watch, { recursive: true });
    await fsp.writeFile(path.join(watch, "uncat_match.json"), JSON.stringify(uncatFixture, null, 2), "utf-8");
  }
  await fsp.writeFile(path.join(watch, "state.json"), JSON.stringify({ downloads: [] }, null, 2), "utf-8");
  if (tiersFixture) {
    await fsp.writeFile(path.join(watch, "tiers.json"), JSON.stringify(tiersFixture, null, 1), "utf-8");
  }
  const recFile = path.join(watch, "_推荐待确认.md");
  if (withRecommend) {
    // 复制真实管道脚本（不是仿写），配合 YABOOK_WATCH/YABOOK_RECFILE 指向临时目录 → 完全离线且不碰真实数据
    await fsp.copyFile(path.join(REAL_WATCH_DIR, "recommend.py"), path.join(watch, "recommend.py"));
  }
  const env = {
    ...process.env,
    EBM_PORT: String(listenPort),
    EBM_HOST: "127.0.0.1",
    EBM_LIBRARY_ROOT: libraryRoot,
    EBM_DATA_DIR: dataDir,
    EBM_WATCH_DIR: watch,
    EBM_EAGER_COVERS: "0",
    EBM_EXTERNAL_TASK_GUARD: "0", // 测试不依赖宿主机进程表
    YABOOK_RECFILE: recFile, // 待确认清单写到临时目录，绝不碰真实 iCloud 文件
    YABOOK_WATCH: watch, // ⚠ 必须：否则真实 recommend.py 会去读写仓库里的 tiers.json
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [path.join(EBM_DIR, "dist", "server.js")], {
    env,
    cwd: EBM_DIR, // 静态资源根是相对路径，必须固定工作目录
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d.toString()));
  proc.stderr.on("data", (d) => (output += d.toString()));
  const base = `http://127.0.0.1:${listenPort}`;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`服务提前退出（code=${proc.exitCode}）\n${output}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        return { base, port: listenPort, proc, output: () => output, stop: () => stop(proc) };
      }
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill("SIGKILL");
  throw new Error(`服务启动超时\n${output}`);
}

async function cleanup(dir) {
  try {
    await fsp.chmod(dir, 0o755).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

module.exports = {
  makeTextPdf, EBM_DIR, DEFAULT_FILES, META_FIXTURE, BOOK_META_FIXTURE, META_CACHE_FIXTURE, TIERS_FIXTURE, tmpDir, makeLibrary, makeBytes, makePdf, freePort, startServer, cleanup, stop };
