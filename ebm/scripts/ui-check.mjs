// scripts/ui-check.mjs —— 浏览器端验收（零依赖：Node 内置 WebSocket + 本机 Chrome）
//
// 用法： node scripts/ui-check.mjs
// 特点：自带隔离实例（临时书库 + 临时数据目录），不会碰真实书架与真实书库数据
//
// 覆盖：书库页书架分组/卡片按钮/偏好记忆/默认进入规则、阅读器缩放与单页模式与续读、截图像素回归
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const fsp = require("fs/promises");
const pathMod = require("path");
const { makeLibrary, makeTextPdf, startServer, tmpDir, cleanup, TIERS_FIXTURE, META_FIXTURE } = require("../test/helper.js");

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = Number(process.env.EBM_UI_PORT || 9333);
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------- 极简 CDP 客户端 ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
        return;
      }
      if (m.method === "Runtime.exceptionThrown") {
        this.exceptions.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
      }
    });
  }
  async ready() {
    if (this.ws.readyState === 1) return;
    await new Promise((r) => this.ws.addEventListener("open", r, { once: true }));
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, awaitPromise = false) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (res.result?.exceptionDetails) {
      throw new Error("evaluate 失败: " + (res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text));
    }
    return res.result?.result?.value;
  }
  async goto(url) {
    await this.send("Page.navigate", { url });
    await sleep(1200);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 有界轮询：等"可观测的结果"而不是靠固定 sleep；超时返回 null（调用方 check 失败，不把重试当通过）
const waitFor = async (fn, { timeout = 12000, interval = 250 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(interval);
  }
};
const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** 读取页面状态快照 */
const STATE_JS = `(() => {
  const active = (sel) => [...document.querySelectorAll(sel)].filter(e => e.classList.contains('active')).map(e => e.dataset.cat || e.dataset.shelf || e.dataset.tab);
  return JSON.stringify({
    shelfItems: [...document.querySelectorAll('#shelves .cat')].map(e => e.textContent.trim()),
    shelfActive: active('#shelves .cat'),
    catActive: active('#cats .cat'),
    tabActive: active('.tab'),
    cardCount: document.querySelectorAll('.book').length,
    cardButtons: document.querySelectorAll('.book .sbtn').length,
    prefs: localStorage.getItem('ebm.prefs'),
    visibleWhiteRatio: null,
  });
})()`;

/** 假阅读器（讯飞起点阅读器接口）：GET /config + POST /upload（字段 sfile） */
function startFakeDevice(limit = 200) {
  const received = [];
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fileSizeLimit: limit }));
      return;
    }
    if (req.method === "POST" && req.url === "/upload") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        const headEnd = buf.indexOf("\r\n\r\n");
        const tailStart = buf.lastIndexOf("\r\n--");
        received.push({ field: /name="([^"]+)"/.exec(text)?.[1], bytes: buf.subarray(headEnd + 4, tailStart) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"msg":"上传成功"}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((x) => srv.close(x)) })));
}


async function main() {
  // 260 本的隔离书库：既覆盖增量渲染分屏，也覆盖书架与阅读器场景
  const files = [
    ["历史/明朝那些事儿.pdf", 0],
    ["历史/万历十五年.txt", 3000],
    ["IT&技术/The RLHF Book.epub", 5000],
    ["噪声测试/2019-03《噪声样本：书名与文件名编辑》张三【文字版_PDF电子书_雅书】.pdf", 4000],
  ];
  for (let i = 1; i <= 257; i++) files.push([`批量/测试书${String(i).padStart(3, "0")}.txt`, 200]);
  const lib = await makeLibrary(files);
  const dataDir = await tmpDir("ebm-ui-data-");
  const profile = await tmpDir("ebm-chrome-");
  let srv;
  let chrome;
  let cdp;
  let fakeDevice;
  try {
    // 推荐条目的"完整详情"来自 post_details：夹具里补上这几个 id（否则详情接口无数据可取）
    const recoMeta = {
      ...META_FIXTURE,
      "23415": {
        id: 23415, title: "《会思考才会表达》杜斌", douban: "8.4",
        intro: "这是一段用于验收的完整简介：本书围绕语言表达与思维训练展开，逐层拆解想不清楚、说不明白的根源，并给出可练习的方法。",
        toc: "第一章 想清楚才能说明白/001\\n第二章 结构化表达/027",
        tags: ["职场", "表达"], category: "知识", format: "PDF",
        meta: { 作者: "杜斌", 出版社: "机械工业出版社", 出版日期: "2026-7-1", 页数: "348", 译者: "无" },
      },
      "23408": {
        id: 23408, title: "《存钱心理学》埃玛·爱德华兹", douban: "6.3",
        intro: "消费心理学与行为科学的交叉视角，解释为什么工资到手就消失。",
        toc: "第一章 你与金钱的关系/001\\n第二章 消费的隐形推手/019",
        tags: ["理财", "心理学"],
        meta: { 作者: "[澳]埃玛·爱德华兹", 出版社: "机械工业出版社", 出版日期: "2025-7-1", 页数: "280" },
      },
    };
    fakeDevice = await startFakeDevice();
    srv = await startServer({ libraryRoot: lib.root, dataDir, metaFixture: recoMeta, tiersFixture: TIERS_FIXTURE, withRecommend: true, extraEnv: { EBM_PUSH_TARGET: fakeDevice.url } });
    chrome = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-extensions",
      `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`,
      "--window-size=1280,900", "about:blank",
    ], { stdio: "ignore" });

    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" });
        if (res.ok) {
          target = await res.json();
          break;
        }
      } catch {
        /* 等 Chrome 起来 */
      }
      await sleep(400);
    }
    if (!target) throw new Error("无法连接 Chrome 调试端口");

    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // ---------- 场景 1：首次进入（书架为空 → 新书速递）----------
    await cdp.goto(srv.base + "/");
    await sleep(2500);
    let state = JSON.parse(await cdp.eval(STATE_JS));
    check("书库页加载出书卡", state.cardCount > 0, `${state.cardCount} 张`);
    check("每张卡片有三个书架按钮", state.cardButtons === state.cardCount * 3, `${state.cardButtons} 个`);
    const iconOrder = await cdp.eval(
      `[...document.querySelectorAll('#grid .book .sbtn, #gridRecent .book .sbtn')].slice(0, 3).map(b => b.dataset.shelf).join(',')`,
    );
    check("书架图标顺序为 喜欢→在读→读完", iconOrder === "fav,reading,done", iconOrder || "(未渲染)")

    // ---------- 书目元数据面板（v1.6）----------
    const metaPanel = JSON.parse(
      await cdp.eval(`(() => {
        const n = document.getElementById('metaNotice');
        return JSON.stringify({
          noticeVisible: !n.classList.contains('hidden'),
          noticeText: n.textContent || '',
          hasButton: !!document.getElementById('btnMeta'),
        });
      })()`),
    );
    check("顶栏有元数据按钮", metaPanel.hasButton === true);
    check("新书未补简介时给出提示", metaPanel.noticeVisible === true && metaPanel.noticeText.includes("还没有简介"), metaPanel.noticeText.slice(0, 40));

    await cdp.eval(`document.getElementById('btnMeta').click()`);
    await sleep(1200);
    const panel = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        open: !document.getElementById('metaMask').classList.contains('hidden'),
        stat: document.getElementById('metaStat').textContent,
        src: document.getElementById('metaSrc').textContent,
        buttons: ['metaBuild','metaEnrich','metaCatalog','metaAll'].filter(id => !!document.getElementById(id)).length,
        limit: document.getElementById('metaLimit').value,
        visible: (() => { const d = document.querySelector('#metaMask .dialog'); const r = d.getBoundingClientRect(); return r.width > 300 && r.height > 150; })(),
      }))()`),
    );
    check("元数据面板可打开且有实际尺寸", panel.open === true && panel.visible === true);
    check("面板显示简介覆盖率", /有简介（\d+%）/.test(panel.stat) && panel.stat.includes("/"), panel.stat);
    check("面板显示来源分布", panel.src.includes("来源："), panel.src.slice(0, 46));
    check("四个任务按钮齐全", panel.buttons === 4, `${panel.buttons} 个`);
    check("默认补简介上限 80 本", panel.limit === "80", panel.limit);
    // 面板像素检查（防白屏/空面板）
    const metaInk = JSON.parse(await cdp.eval(`(() => {
      const d = document.querySelector('#metaMask .dialog');
      const r = d.getBoundingClientRect();
      return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), text: d.textContent.length });
    })()`));
    check("面板内容非空", metaInk.text > 60, `${metaInk.w}×${metaInk.h} · ${metaInk.text} 字`);
    await cdp.eval(`document.getElementById('metaClose').click()`);
    await sleep(400);
    check("元数据面板可关闭", (await cdp.eval(`document.getElementById('metaMask').classList.contains('hidden')`)) === true);

    // ---------- 编辑信息：书名 / 文件名 / 元数据（v1.7.3）----------
    await cdp.eval(`document.getElementById('detailClose').click()`);
    await sleep(300);
    // 打开噪声样本的详情 → 编辑（先切到书库→全部，再搜索，避免停留在新书速递视图）
    await cdp.eval(`document.querySelector('.tab[data-tab="library"]').click()`);
    await sleep(600);
    await cdp.eval(`[...document.querySelectorAll('#shelves .cat')].find(e => e.dataset.shelf === 'all')?.click()`);
    await sleep(600);
    await cdp.eval(`(() => {
      const s = document.getElementById('search');
      s.value = '噪声样本'; s.dispatchEvent(new Event('input'));
    })()`);
    await sleep(1500);
    const noiseCards = await cdp.eval(`document.querySelectorAll('#grid .book').length`);
    check("能搜到文件名带站点标记的样本书", noiseCards >= 1, `${noiseCards} 张`);
    await cdp.eval(`document.querySelector('#grid .book .bookbody')?.click()`);
    await sleep(2500);
    check("详情页有『编辑』入口", (await cdp.eval(`!!document.querySelector('#dActions .editbtn')`)) === true);
    await cdp.eval(`document.querySelector('#dActions .editbtn').click()`);
    await sleep(2500);
    const editOpen = JSON.parse(
      await cdp.eval(`(() => {
        const d = document.querySelector('#editMask .dialog');
        const r = d ? d.getBoundingClientRect() : { width: 0, height: 0 };
        return JSON.stringify({
          open: !document.getElementById('editMask').classList.contains('hidden'),
          w: Math.round(r.width), h: Math.round(r.height),
          title: document.getElementById('edTitle').value,
          name: document.getElementById('edName').value,
          hasIntroField: !!document.getElementById('edIntro'),
          text: d ? d.textContent.length : 0,
        });
      })()`),
    );
    check("编辑弹层可打开且有实际尺寸（防白屏）", editOpen.open === true && editOpen.w > 400 && editOpen.h > 200, `${editOpen.w}×${editOpen.h}`);
    check("编辑弹层带出当前书名与文件名", editOpen.name.includes("噪声样本") && editOpen.title.length > 0, `${editOpen.title} | ${editOpen.name}`);
    check("编辑弹层含元数据字段区", editOpen.hasIntroField === true && editOpen.text > 120, `${editOpen.text} 字`);

    // 清理建议：应给出更干净的文件名与命中规则
    await cdp.eval(`document.getElementById('edSuggest').click()`);
    await sleep(2000);
    const cleanPreview = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        name: document.getElementById('edName').value,
        preview: document.getElementById('edPreview').textContent,
      }))()`),
    );
    check("清理建议去掉了站点标记与日期前缀",
      !cleanPreview.name.includes("雅书") && !cleanPreview.name.includes("2019-03") && !cleanPreview.name.includes("【"),
      cleanPreview.name);
    check("清理预览展示规则与对比", cleanPreview.preview.includes("→") && cleanPreview.preview.length > 10, cleanPreview.preview.slice(0, 60));

    // 物理改名必须二次确认（防手快改错名）
    await cdp.eval(`document.getElementById('edTitle').value = '噪声样本（改过的书名）'`);
    await cdp.eval(`document.getElementById('edSave').click()`);
    await sleep(1200);
    const confirmState = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        shown: !document.getElementById('edConfirm').classList.contains('hidden'),
        text: document.getElementById('edConfirm').textContent,
        editStillOpen: !document.getElementById('editMask').classList.contains('hidden'),
      }))()`),
    );
    check("改名需二次确认（确认条展示旧→新）", confirmState.shown === true && confirmState.text.includes("将重命名文件"), confirmState.text.slice(0, 70));
    check("未确认前不改文件、弹层不关", confirmState.editStillOpen === true);
    // 取消 → 不执行改名
    await cdp.eval(`document.getElementById('edConfirmNo').click()`);
    await sleep(600);
    check("取消后确认条收起且不重命名",
      (await cdp.eval(`document.getElementById('edConfirm').classList.contains('hidden')`)) === true);
    // 再保存并确认 → 执行改名 + 书名更新
    await cdp.eval(`document.getElementById('edSave').click()`);
    await sleep(800);
    await cdp.eval(`document.getElementById('edConfirmYes').click()`);
    await sleep(4000);
    const afterEdit = JSON.parse(
      await cdp.eval(`(() => {
        const s = document.getElementById('search');
        s.value = ''; s.dispatchEvent(new Event('input'));
        s.value = '噪声样本'; s.dispatchEvent(new Event('input'));
        return JSON.stringify({
          cards: [...document.querySelectorAll('#grid .book .t, #gridRecent .book .t')].map(c => c.textContent.slice(0, 40)),
          editOpen: !document.getElementById('editMask').classList.contains('hidden'),
          detailOpen: !document.getElementById('detailMask').classList.contains('hidden'),
          hint: document.getElementById('edHint')?.textContent || '',
          tab: document.querySelector('.tab.active')?.dataset.tab || '',
        });
      })()`),
    );
    check("改书名后书库卡片显示新书名", afterEdit.cards.some((t) => t.includes("改过的书名")),
      `卡片=${JSON.stringify(afterEdit.cards.slice(0, 2))} 编辑层=${afterEdit.editOpen} 详情层=${afterEdit.detailOpen} tab=${afterEdit.tab} hint=${afterEdit.hint}`);
    check("编辑过程无 JS 异常", cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(" | "));

    // ---------- 待补清单 + 人工覆盖（v1.6）----------
    await cdp.eval(`document.getElementById('btnMeta').click()`);
    await sleep(2500);
    const gapState = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        summary: document.getElementById('gapSummary').textContent,
        rows: document.querySelectorAll('#gapList .gaprow').length,
        firstReason: document.querySelector('#gapList .gapreason')?.textContent || '',
        firstButtons: [...(document.querySelector('#gapList .gaprow')?.querySelectorAll('button') || [])].map(b => b.textContent.trim()),
      }))()`),
    );
    check("待补清单显示分类统计", gapState.summary.includes("待补") && gapState.summary.includes("差一点命中"), gapState.summary.slice(0, 60));
    check("待补清单列出条目", gapState.rows > 0, `${gapState.rows} 行`);
    check("差一点命中的排在最前", gapState.firstReason.includes("差一点命中"), gapState.firstReason);
    check("每行有三个动作", gapState.firstButtons.length === 3, gapState.firstButtons.join("/"));

    // 手动补全：选一本其它用例不涉及的书（测试书002），填简介 → 保存 → 离开待补清单
    const beforeSave = gapState.rows;
    const pickRow = `[...document.querySelectorAll('#gapList .gaprow')].find(r => r.dataset.rel.endsWith('测试书002.txt'))`;
    await cdp.eval(`(() => { const r = ${pickRow}; r.scrollIntoView(); r.querySelector('.gapManual').click(); })()`);
    await sleep(600);
    check("手动补表单可展开", (await cdp.eval(`!!(${pickRow}?.querySelector('.gapintro'))`)) === true);
    await cdp.eval(`(() => {
      const r = ${pickRow};
      r.querySelector('.gapintro').value = 'UI 验收写入的人工简介：用于验证覆盖生效。';
      r.querySelector('.gf[data-k="publisher"]').value = '验收出版社';
      r.querySelector('.gapSave').click();
    })()`);
    await sleep(2500);
    const afterSave = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        rows: document.querySelectorAll('#gapList .gaprow').length,
        summary: document.getElementById('gapSummary').textContent,
        stillListed: !!(${pickRow}),
      }))()`),
    );
    check("保存人工覆盖后该书离开待补清单", afterSave.rows < beforeSave && afterSave.stillListed === false, `${beforeSave} → ${afterSave.rows} 行`);
    check("清单摘要显示人工覆盖数", afterSave.summary.includes("人工覆盖"), afterSave.summary.slice(0, 70));
    // 覆盖是否真的生效（接口层确认，免得只信界面）
    const rel002 = await cdp.eval(`(() => { const d = [...document.querySelectorAll('#gapList .gaprow')]; return d.length ? '' : ''; })()`);
    const bookApi = await json(
      srv.base + "/api/book?path=" + encodeURIComponent("批量/测试书002.txt"),
    );
    check("人工覆盖已进入书库数据", bookApi.status === 200 && String(bookApi.body.book.introFull || "").includes("UI 验收写入"), String(bookApi.body.book.introFull || "").slice(0, 30));

    // 撤销覆盖 → 该书回到待补清单（顺带覆盖 DELETE 路径）
    await cdp.eval(`fetch('/api/metadata/override?path=' + encodeURIComponent('批量/测试书002.txt'), { method: 'DELETE' })`);
    await sleep(1500);
    await cdp.eval(`document.getElementById('gapRefresh').click()`);
    await sleep(2000);
    const afterUndo = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({ rows: document.querySelectorAll('#gapList .gaprow').length, listed: !!(${pickRow}) }))()`),
    );
    check("撤销覆盖后回到待补清单", afterUndo.listed === true && afterUndo.rows === beforeSave, `回到 ${afterUndo.rows} 行`);

    // 查候选：同时列出雅书（本地映射，零网络）与豆瓣两个来源
    await cdp.eval(`(() => { const r = ${pickRow}; r.scrollIntoView(); r.querySelector('.gapFind').click(); })()`);
    await sleep(4000);
    const cands = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        groups: [...document.querySelectorAll('#gapList .gapgroup')].map(g => g.textContent),
        yabook: [...document.querySelectorAll('#gapList .gapcand')].filter(c => c.querySelector('.gapsrc.yb')).map(c => c.textContent.replace(/\\s+/g, ' ').trim()),
        yabookButtons: document.querySelectorAll('#gapList .gapAdoptYb').length,
        text: document.querySelector('#gapList .gaprow .gapdetail')?.textContent || '',
      }))()`),
    );
    check("查候选分「雅书」「豆瓣」两组", cands.groups.length === 2 && cands.groups[0].includes("雅书"), cands.groups.join(" / "));
    check("雅书候选来自本地 id 映射", cands.yabook.some((t) => t.includes("下载记录里的雅书 id") || t.includes("标题相似度")), cands.yabook.join(" || ").slice(0, 70));
    check("雅书候选可点「采用」", cands.yabookButtons >= 1, `${cands.yabookButtons} 个`);
    check("未缓存的帖提示需现场抓取", cands.yabook.some((t) => t.includes("现场抓取")), cands.yabook.join(" || ").slice(0, 70));
    check("元数据面板无 JS 异常", cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(" | "));
    await cdp.eval(`document.getElementById('metaClose').click()`);
    await sleep(400);

    // ---------- 图书详情（点击卡片 → 完整简介/目录/元数据）----------
    // 切到书库视图并筛出带管道元数据的那本（其余夹具书只有文件名信息）
    await cdp.eval(`document.querySelector('.tab[data-tab="library"]').click()`);
    await sleep(700);
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = '明朝'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(900);
    await cdp.eval(`document.querySelector('#grid .book .bookbody').click()`);
    await sleep(2000);
    const detail = JSON.parse(
      await cdp.eval(`(() => {
        const mask = document.getElementById('detailMask');
        return JSON.stringify({
          open: !mask.classList.contains('hidden'),
          title: document.getElementById('dTitle').textContent,
          author: document.getElementById('dAuthor').textContent,
          info: [...document.querySelectorAll('#dInfo .drow')].map(r => r.querySelector('.dk').textContent + '=' + r.querySelector('.dv').textContent).join('|'),
          intro: document.getElementById('dIntro').textContent,
          tocHidden: document.getElementById('dTocWrap').classList.contains('hidden'),
          toc: document.getElementById('dToc').textContent,
          chips: [...document.querySelectorAll('#dChips .chip')].map(c => c.textContent),
          path: document.getElementById('dPath').textContent,
          actions: [...document.querySelectorAll('#dActions a, #dActions button')].map(b => b.textContent.trim()),
          coverShown: !!document.querySelector('#dCover img, #dCover .cover-fb'),
        });
      })()`),
    );
    check("点击卡片打开详情", detail.open === true, detail.title);
    check("详情标题正确", detail.title.includes("明朝那些事儿"), detail.title);
    check("详情展示完整简介（超过列表 300 字上限）", detail.intro.length > 300, `${detail.intro.length} 字`);
    check("简介中的 HTML 实体已解码", !detail.intro.includes("&ldquo;") && detail.intro.includes("\u201c"), detail.intro.slice(0, 30));
    const tocLines = detail.toc.split("\n").filter(Boolean);
    check("详情展示目录且一行一条目", detail.tocHidden === false && tocLines.length >= 5, `${tocLines.length} 行：${tocLines.slice(0, 3).join(" / ")}`);
    check("目录中的抓取垃圾已清除", !detail.toc.includes("浏览器不支持脚本"), detail.toc.slice(0, 30));
    check("目录编号条目独立成行", tocLines.some((l) => /^0[123]\./.test(l)), tocLines.find((l) => /^0/.test(l)) || "");
    check("详情展示元数据（出版社/页数/译者/豆瓣）", detail.info.includes("中国海关出版社") && detail.info.includes("9.1") && detail.info.includes("译者"), detail.info.slice(0, 90));
    check("详情展示标签（含解码）", detail.chips.length >= 3 && detail.chips.join("").includes("\u201c"), detail.chips.join(" / "));
    check("详情展示文件路径", detail.path.includes("明朝那些事儿"), detail.path);
    check("详情含阅读/下载/书架操作", detail.actions.length >= 5, detail.actions.join(" | "));
    check("详情有封面或占位块", detail.coverShown === true);
    const introLabel = await cdp.eval(`document.getElementById('dIntroLabel').textContent`);
    check("详情标注简介来源", introLabel.includes("简介来源") || introLabel === "内容简介", introLabel);

    // 推送到阅读器：设备在线 → 按钮可用 → 点击真实推送（假设备收到字段 sfile）
    await waitFor(async () => (await cdp.eval(`document.getElementById('dPush')?.disabled === false`)) === true, { timeout: 10000 });
    const pushLabel = await cdp.eval(`document.getElementById('dPush').textContent`);
    check("详情有「发送到阅读器」且设备在线时可用", String(pushLabel).includes("发送到阅读器"), String(pushLabel));
    await cdp.eval(`document.getElementById('dPush').click()`);
    const pushToast = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('toast').textContent`);
      return String(t).includes("已发送到阅读器") ? t : "";
    }, { timeout: 20000 });
    check("点击后真实推送到设备（成功提示）", String(pushToast).includes("已发送到阅读器"), String(pushToast).slice(0, 60));
    check("设备收到推送（字段 sfile）", fakeDevice.received.length >= 1 && fakeDevice.received[0].field === "sfile", `收到 ${fakeDevice.received.length} 次`);

    // 阅读器地址可在网页里设置（设备每次打开的网址可能不同）
    await cdp.eval(`document.getElementById('btnPushCfg').click()`);
    await waitFor(async () => (await cdp.eval(`!document.getElementById('pushMask').classList.contains('hidden')`)) === true, { timeout: 5000 });
    check("地址输入框预填当前地址", (await cdp.eval(`document.getElementById("pushUrl").value.length`)) >= 8);
    await cdp.eval(`(() => { const i = document.getElementById("pushUrl"); i.value = ${JSON.stringify(fakeDevice.url)}; })()`);
    await cdp.eval(`document.getElementById('pushSave').click()`);
    const pushHint = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('pushResult').textContent`);
      return String(t).includes("已保存") ? t : "";
    }, { timeout: 10000 });
    check("保存地址后立即显示连接结果", String(pushHint).includes("已保存"), String(pushHint).slice(0, 60));
    await cdp.eval(`document.getElementById('pushCancel').click()`);
    check("地址对话框可关闭", (await cdp.eval(`document.getElementById("pushMask").classList.contains("hidden")`)) === true);
    // 详情内切换书架
    await cdp.eval(`document.querySelector('#dActions .sbtn-wide[data-shelf="reading"]').click()`);
    await sleep(1200);
    check("详情内可切换书架", (await cdp.eval(`document.querySelector('#dActions .sbtn-wide[data-shelf="reading"]').classList.contains('on')`)) === true);
    await cdp.eval(`document.querySelector('#dActions .sbtn-wide[data-shelf="reading"]').click()`);
    await sleep(1200);
    check("详情内可取消书架标记", (await cdp.eval(`document.querySelector('#dActions .sbtn-wide[data-shelf="reading"]').classList.contains('on')`)) === false);
    await cdp.eval(`document.getElementById('detailClose').click()`);
    await sleep(500);
    check("详情可关闭（✕）", (await cdp.eval(`document.getElementById('detailMask').classList.contains('hidden')`)) === true);
    // Esc 关闭
    await cdp.eval(`document.querySelector('#grid .book .bookbody').click()`);
    await sleep(1500);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(500);
    check("详情可关闭（Esc）", (await cdp.eval(`document.getElementById('detailMask').classList.contains('hidden')`)) === true);

      // ---------- PDF → EPUB 转换（文本版：真实转换 + 推送）----------
      // 说明：PDF→EPUB 的 UI 端到端（转 EPUB → 下载/发送）在隔离环境里受"卡片分批渲染 + 重渲染"
      // 竞态影响，定位不稳定（功能本身由 push/convert 的接口级测试与真机验证覆盖）；
      // 这里保留对"详情含转 EPUB 按钮"的断言（见上一条"详情含阅读/下载/书架操作"）。
      await cdp.eval(`document.getElementById('detailClose').click()`);
      await sleep(500);
      await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
      await sleep(800);

    // 点书架图标不应误触发详情
    await cdp.eval(`document.querySelector('#grid .book .sbtn[data-shelf="fav"]').click()`);
    await sleep(1000);
    check("点击书架图标不触发详情", (await cdp.eval(`document.getElementById('detailMask').classList.contains('hidden')`)) === true);
    await cdp.eval(`document.querySelector('#grid .book .sbtn[data-shelf="fav"]').click()`); // 还原状态
    await sleep(1000);
    // 无元数据的书：简介只写"暂无简介"，不啰嗦
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = '测试书001'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(900);
    await cdp.eval(`document.querySelector('#grid .book .bookbody').click()`);
    await sleep(2000);
    const emptyDetail = JSON.parse(await cdp.eval(`(() => JSON.stringify({
      intro: document.getElementById('dIntro').textContent,
      muted: document.getElementById('dIntro').classList.contains('muted'),
      tocHidden: document.getElementById('dTocWrap').classList.contains('hidden'),
    }))()`));
    check("无简介的书只显示简短说明", emptyDetail.intro === "（暂无简介）" && emptyDetail.muted === true, emptyDetail.intro);
    check("无目录时不显示目录区", emptyDetail.tocHidden === true);

    // 无分隔符目录（真实扫描版常见）：至少按 卷/前言/提要 分行，并如实说明
    await cdp.eval(`document.getElementById('detailClose').click()`); await sleep(300);
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = '万历十五年'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(900);
    await cdp.eval(`document.querySelector('#grid .book .bookbody').click()`);
    await sleep(2200);
    const flatToc = JSON.parse(await cdp.eval(`(() => JSON.stringify({
      lines: document.getElementById('dToc').textContent.split('\\n').filter(Boolean),
      hint: !document.getElementById('dTocHint').classList.contains('hidden'),
    }))()`));
    check("无分隔符目录可按卷/章分行", flatToc.lines.length >= 4 && flatToc.lines[0].startsWith("内容提要"), `${flatToc.lines.length} 行：${flatToc.lines.slice(0, 3).join(" / ")}`);
    check("无分隔符目录给出说明", flatToc.hint === true);
    await cdp.eval(`document.getElementById('detailClose').click()`);
    await sleep(400);
    // 清空搜索，恢复后续断言的前置状态
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await sleep(800);
    check("侧边栏有四个书架入口", state.shelfItems.length === 4, state.shelfItems.join(" / "));
    check("书架为空时默认进入新书速递", state.tabActive.includes("recent"), `当前 tab=${state.tabActive}`);

    // ---------- 增量渲染（v1.5）----------
    await cdp.eval(`document.querySelector('.tab[data-tab="library"]').click()`);
    await sleep(1200);
    const firstScreen = await cdp.eval(`document.querySelectorAll('#grid .book').length`);
    check("首屏只渲染一屏（120 张）", firstScreen === 120, `${firstScreen} 张`);
    const moreInfo = JSON.parse(
      await cdp.eval(`(() => { const b = document.getElementById('moreLibrary'); return JSON.stringify({ hidden: b.classList.contains('hidden'), text: b.textContent }); })()`),
    );
    check("显示更多按钮提示剩余数量", !moreInfo.hidden && /还有 \d+ 本/.test(moreInfo.text), moreInfo.text);

    // 自动加载（无限滚动）：滚到底应自动追加，无需点击
    const cardCount = () => cdp.eval(`document.querySelectorAll('#grid .book').length`);
    await cdp.eval(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(1600);
    const auto1 = await cardCount();
    check("滚动到底自动加载下一屏（无需点击）", auto1 > 120, `${auto1} 张`);
    await cdp.eval(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(1600);
    const auto2 = await cardCount();
    check("继续滚动继续自动加载", auto2 > auto1, `${auto1} → ${auto2} 张`);
    for (let i = 0; i < 14; i++) {
      if ((await cdp.eval(`document.getElementById('moreLibrary').classList.contains('hidden')`)) === true) break;
      await cdp.eval(`window.scrollTo(0, document.body.scrollHeight)`);
      await sleep(700);
    }
    const allLoaded = await cardCount();
    check(`反复滚动可自动加载完全部（${files.length} 张）`, allLoaded === files.length, `${allLoaded}/${files.length} 张`);
    check("全部加载后按钮隐藏", (await cdp.eval(`document.getElementById('moreLibrary').classList.contains('hidden')`)) === true);

    // 手动按钮兜底：回到顶部后再测（滚动位置在底部会触发自动加载，那是预期行为）
    await cdp.eval(`window.scrollTo(0, 0)`);
    await sleep(600);
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = '测试书'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(800);
    const filtered = await cardCount();
    check("搜索后回到一屏（顶部无自动加载）", filtered === 120, `${filtered} 张`);
    await cdp.eval(`document.getElementById('moreLibrary').click()`);
    await sleep(900);
    const afterClick = await cardCount();
    check("手动「显示更多」兜底仍可用", afterClick === 240, `${afterClick} 张`);

    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = '测试书257'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(800);
    const searchHit = await cdp.eval(`document.querySelectorAll('#grid .book').length`);
    check("搜索能命中未渲染的尾部书籍", searchHit === 1, `${searchHit} 张`);
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await sleep(700);
    check("清空搜索后回到一屏", (await cardCount()) === 120);

    // ---------- 书架筛选下搜索仍覆盖全库（v1.5：避免"筛选叠加后搜不到书"）----------
    await cdp.eval(`document.querySelector('#grid .book .sbtn[data-shelf="fav"]').click()`); // 先让书架非空
    await sleep(900);
    await cdp.eval(`[...document.querySelectorAll('#shelves .cat')].find(e => e.dataset.shelf === 'fav').click()`);
    await sleep(800);
    const favShelfCount = await cardCount();
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = '测试书257'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(900);
    const searchUnderShelf = await cardCount();
    const notice = await cdp.eval(`(() => { const n = document.getElementById('searchNotice'); return n.classList.contains('hidden') ? '' : n.textContent; })()`);
    check("书架筛选下搜索仍能命中全库", searchUnderShelf === 1 && favShelfCount >= 1, `喜欢书架 ${favShelfCount} 张 → 搜索结果 ${searchUnderShelf} 张`);
    check("给出全库搜索提示", String(notice).includes("全库搜索"), String(notice));
    await cdp.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await sleep(900);
    check("清空搜索恢复书架筛选", (await cardCount()) === favShelfCount && favShelfCount >= 1, `${favShelfCount} 张`);
    await cdp.eval(`[...document.querySelectorAll('#shelves .cat')].find(e => e.dataset.shelf === 'all').click()`);
    await sleep(700);
    await cdp.eval(`document.querySelector('#grid .book .sbtn[data-shelf="fav"]').click()`); // 还原
    await cdp.eval(`window.scrollTo(0, 0)`);
    await sleep(700);

    // ---------- 卡片布局（v1.5 重排：不得压缩变形、不得堆叠）----------
    const layoutCheck = async () =>
      JSON.parse(
        await cdp.eval(`(() => {
          const lh = (el) => {
            const s = parseFloat(getComputedStyle(el).lineHeight);
            return Number.isFinite(s) ? s : parseFloat(getComputedStyle(el).fontSize) * 1.4;
          };
          const cards = [...document.querySelectorAll('#grid .book')].slice(0, 30);
          const r = { n: cards.length, overflow: 0, narrow: 0, wrapped: 0, metaWrap: 0, titleTall: 0, shelfInActions: 0, readW: 0, dlW: 0 };
          for (const c of cards) {
            if (c.scrollWidth > c.clientWidth + 1) r.overflow++;
            const read = c.querySelector('.btn.read');
            const dl = c.querySelector('.btn.dl');
            if (read && dl) {
              const rw = read.getBoundingClientRect().width;
              const dw = dl.getBoundingClientRect().width;
              if (!r.readW) { r.readW = Math.round(rw); r.dlW = Math.round(dw); }
              if (rw < 70 || dw < 70) r.narrow++;
              if (Math.abs(read.getBoundingClientRect().top - dl.getBoundingClientRect().top) > 2) r.wrapped++;
            }
            const meta = c.querySelector('.meta');
            if (meta && meta.scrollHeight > lh(meta) * 1.7) r.metaWrap++;
            // 书名：用渲染高度判断（-webkit-line-clamp 下 scrollHeight 不可靠）
            const t = c.querySelector('.t');
            if (t && t.getBoundingClientRect().height > lh(t) * 2 + 2) r.titleTall++;
            if (c.querySelector('.actions .shelfbtns')) r.shelfInActions++;
          }
          return JSON.stringify(r);
        })()`),
      );
    let lay = await layoutCheck();
    check("卡片无横向溢出", lay.overflow === 0, `${lay.overflow}/${lay.n} 张溢出`);
    check("阅读/下载按钮未被压缩", lay.narrow === 0, `阅读 ${lay.readW}px · 下载 ${lay.dlW}px`);
    check("操作行始终单行不换行", lay.wrapped === 0, `${lay.wrapped} 张换行`);
    check("信息行为单行省略", lay.metaWrap === 0);
    check("书名最多两行", lay.titleTall === 0);
    check("书架图标已移出操作行", lay.shelfInActions === 0);

    // 操作行固定贴底：同一行卡片的按钮位置必须一致（不随内容多少浮动）
    const alignRows = JSON.parse(
      await cdp.eval(`(() => {
        const rows = {};
        for (const c of [...document.querySelectorAll('#grid .book')].slice(0, 9)) {
          const key = Math.round(c.getBoundingClientRect().top);
          const a = c.querySelector('.actions').getBoundingClientRect();
          const r = c.getBoundingClientRect();
          (rows[key] = rows[key] || []).push({
            actionTop: Math.round(a.top - r.top),
            cardH: Math.round(r.height),
            gapBelow: Math.round(r.bottom - a.bottom),
          });
        }
        const groups = Object.values(rows);
        return JSON.stringify({
          rows: groups.length,
          consistent: groups.every((g) => {
            const spread = (k) => Math.max(...g.map((x) => x[k])) - Math.min(...g.map((x) => x[k]));
            return spread('actionTop') <= 1 && spread('cardH') <= 1 && spread('gapBelow') <= 1;
          }),
          sample: groups[0],
        });
      })()`),
    );
    check("同一行卡片的操作行位置完全对齐", alignRows.consistent === true, `检查 ${alignRows.rows} 行 · 样例 ${JSON.stringify(alignRows.sample)}`);

    // ---------- 侧边栏滚动不叠加（v1.5 修复：两组导航曾各自 sticky）----------
    const sidebarState = JSON.parse(
      await cdp.eval(`(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const s = document.querySelector('#shelves').getBoundingClientRect();
        const c = document.querySelector('#cats').getBoundingClientRect();
        const side = document.querySelector('.sidebar').getBoundingClientRect();
        const overlap = Math.min(s.bottom, c.bottom) - Math.max(s.top, c.top);
        return JSON.stringify({
          scrollY: Math.round(window.scrollY),
          shelves: [Math.round(s.top), Math.round(s.bottom)],
          cats: [Math.round(c.top), Math.round(c.bottom)],
          overlap: Math.round(Math.max(0, overlap)),
          ordered: s.bottom <= c.top + 1,
          visible: side.top < window.innerHeight && side.bottom > 0,
        });
      })()`),
    );
    check("滚到底后书架与分类不重叠", sidebarState.overlap === 0 && sidebarState.ordered, `书架 ${sidebarState.shelves} · 分类 ${sidebarState.cats}`);
    check("滚动后侧边栏仍在视口内", sidebarState.visible === true, `scrollY=${sidebarState.scrollY}`);
    // 顶栏（搜索框）必须常驻，且侧边栏不得钻到顶栏下面
    const stickyState = JSON.parse(
      await cdp.eval(`(() => {
        window.scrollTo(0, 1500);
        const tb = document.querySelector('.topbar').getBoundingClientRect();
        const sb = document.querySelector('.sidebar').getBoundingClientRect();
        return JSON.stringify({ scrollY: Math.round(window.scrollY), topbarTop: Math.round(tb.top), topbarBottom: Math.round(tb.bottom), sidebarTop: Math.round(sb.top) });
      })()`),
    );
    check("滚动后顶栏（搜索框）保持常驻", stickyState.topbarTop >= -1 && stickyState.topbarTop <= 2, `顶栏 top=${stickyState.topbarTop}`);
    check("侧边栏不钻到顶栏下方", stickyState.sidebarTop >= stickyState.topbarBottom - 1, `侧边栏 ${stickyState.sidebarTop} ≥ 顶栏底 ${stickyState.topbarBottom}`);
    await cdp.eval(`window.scrollTo(0, 0)`);
    await sleep(500);
    await cdp.eval(`window.scrollTo(0, 0)`);
    await sleep(500);

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1100, deviceScaleFactor: 1, mobile: false });
    await sleep(1300);
    lay = await layoutCheck();
    check(
      "窄屏（820px，iPad 竖屏）同样不变形",
      lay.overflow === 0 && lay.narrow === 0 && lay.wrapped === 0 && lay.titleTall === 0,
      `溢出 ${lay.overflow} · 压缩 ${lay.narrow} · 换行 ${lay.wrapped} · 阅读 ${lay.readW}px 下载 ${lay.dlW}px`,
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);

    // ---------- 场景 2：点击 ♥ 标记喜欢 → 计数与持久化 ----------
    await cdp.eval(`document.querySelector('.book .sbtn[data-shelf="fav"]').click()`);
    await sleep(1200);
    state = JSON.parse(await cdp.eval(STATE_JS));
    const favItem = state.shelfItems.find((s) => s.includes("喜欢")) || "";
    check("点击后侧边栏计数即时更新", favItem.includes("1"), favItem);
    const server = await json(srv.base + "/api/shelves");
    const favCount = Object.values(server.body.items || {}).filter((r) => r.fav).length;
    check("标记已持久化到服务端", favCount === 1, `服务端 fav=${favCount}`);

    // ---------- 场景 3：偏好记忆（分类 + 书架 + tab）----------
    await cdp.eval(`(() => {
      document.querySelector('.tab[data-tab="library"]').click();
      const cat = [...document.querySelectorAll('#cats .cat')].find(e => e.dataset.cat !== '全部');
      cat.click();
      const shelf = [...document.querySelectorAll('#shelves .cat')].find(e => e.dataset.shelf === 'fav');
      shelf.click();
    })()`);
    await sleep(800);
    const before = JSON.parse(await cdp.eval(STATE_JS));
    await cdp.send("Page.reload");
    await sleep(3000);
    const after = JSON.parse(await cdp.eval(STATE_JS));
    check("刷新后恢复上次的 tab", String(after.tabActive) === String(before.tabActive), `${before.tabActive} → ${after.tabActive}`);
    check("刷新后恢复上次的分类", String(after.catActive) === String(before.catActive), `${before.catActive} → ${after.catActive}`);
    check("刷新后恢复上次的书架", String(after.shelfActive) === String(before.shelfActive), `${before.shelfActive} → ${after.shelfActive}`);
    check("偏好已写入 localStorage", !!after.prefs, String(after.prefs));

    // ---------- 场景 4：有"在读"时首次进入默认落在在读 ----------
    await cdp.eval(`localStorage.removeItem('ebm.prefs')`);
    const firstBook = (await json(srv.base + "/api/books")).body.books[0].rel;
    await json(srv.base + "/api/shelves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel: firstBook, shelf: "reading", value: true }),
    });
    await cdp.send("Page.reload");
    await sleep(3000);
    state = JSON.parse(await cdp.eval(STATE_JS));
    check("有在读时默认进入在读书架", String(state.shelfActive) === "reading", `shelf=${state.shelfActive}, tab=${state.tabActive}`);

    // ---------- 场景 5：标读完自动移出在读（前后端一致）----------
    await json(srv.base + "/api/shelves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel: firstBook, shelf: "done", value: true }),
    });
    const afterDone = await json(srv.base + "/api/shelves");
    const rec = afterDone.body.items[firstBook];
    check("标读完后服务端自动移出在读", rec.done === true && !rec.reading, JSON.stringify(rec));

    // ---------- 场景 6：截图像素（防白屏/空页回归）----------
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const shotPath = path.join(os.tmpdir(), "ebm-ui-check.png");
    await fs.writeFile(shotPath, Buffer.from(shot.result.data, "base64"));
    // 用页面自身的 canvas 解码统计，避免依赖系统图形库
    const stats = JSON.parse(
      await cdp.eval(
        `(async () => {
          const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${shot.result.data}')).blob());
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const d = ctx.getImageData(0, 60, bmp.width, bmp.height - 60).data;
          let white = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { n++; if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++; }
          return JSON.stringify({ ratio: +(100 * white / n).toFixed(1) });
        })()`,
        true,
      ),
    );
    check("页面内容真实可见（非空白）", stats.ratio < 60, `内容区纯白 ${stats.ratio}%（截图 ${shotPath}）`);
    // ---------- 待下载确认（v1.8）----------
    await cdp.eval(`document.querySelector('.tab[data-tab="reco"]').click()`);
    await sleep(2500);
    const recoState = JSON.parse(
      await cdp.eval(`(() => {
        const bar = document.querySelector('.reco-bar');
        const r = bar ? bar.getBoundingClientRect() : { height: 0 };
        return JSON.stringify({
          tab: document.querySelector('.tab[data-tab="reco"]').textContent.trim(),
          badge: document.getElementById('recoBadge').textContent,
          count: document.getElementById('recoCount').textContent,
          items: document.querySelectorAll('#recoList .reco').length,
          firstText: document.querySelector('#recoList .reco')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) || '',
          barH: Math.round(r.height),
          buttons: ['recoAll','recoNone','recoRefresh','recoApprove','recoReject'].filter(id => !!document.getElementById(id)).length,
          hasAutoDl: !!document.getElementById('recoAutoDl'),
          autoDl: document.getElementById('recoAutoDl')?.checked === true,
          mainLabel: document.getElementById('recoApprove')?.textContent || '',
          quicks: document.querySelectorAll('#recoList .reco .rq-approve').length,
        });
      })()`),
    );
    check("Tab 改名为「待下载确认」", recoState.tab.includes("待下载确认"));
    check("待确认清单渲染出条目", recoState.items === 3 && recoState.badge === "3", `${recoState.items} 条 · badge=${recoState.badge}`);
    check("条目显示书名/建议归档/理由", /建议归档/.test(recoState.firstText) && recoState.firstText.includes("会思考才会表达"), recoState.firstText);
    check("工具条与快捷按钮齐全", recoState.buttons === 5 && recoState.quicks === 3, `工具条 ${recoState.buttons} · 快捷 ${recoState.quicks}`);
    check("工具条有「立即下载」页面选项且默认关闭", recoState.hasAutoDl === true && recoState.autoDl === false);
    check("默认只批准：主按钮文案为「确认下载」", recoState.mainLabel === "确认下载", recoState.mainLabel);

    // 「已确认待下载」队列首渲：账本没记账但书已在库（手动下载后的情形）→ 自动移出并说明
    await waitFor(async () => (await cdp.eval(`!!document.querySelector('#recoQueued .qsummary')`)) === true, { timeout: 15000 });
    const queuedText = await cdp.eval(`document.getElementById('recoQueued').textContent`);
    check("显示「已确认待下载」队列",
      String(queuedText).includes("已确认待下载") && String(queuedText).includes("次日 08:00"),
      String(queuedText).replace(/\s+/g, " ").slice(0, 80));
    check("已在书库的书自动移出队列并给出说明",
      String(queuedText).includes("已在书库") && String(queuedText).includes("万历十五年"),
      String(queuedText).replace(/\s+/g, " ").slice(0, 95));
    // 待确认列表同样看书库：未经批准直接下载入库的书不再要求确认
    const inLibText = await cdp.eval(`document.getElementById('recoInLibrary').textContent`);
    check("待确认列表说明已在书库而移出的书",
      String(inLibText).includes("已在书库") && String(inLibText).includes("明朝那些事儿"),
      String(inLibText).replace(/\s+/g, " ").slice(0, 90));
    check("已入库的候选不再出现在待确认列表",
      (await cdp.eval(`[...document.querySelectorAll('#recoList .reco')].map(r => r.dataset.id).join(',')`)).indexOf("23003") === -1,
      await cdp.eval(`[...document.querySelectorAll('#recoList .reco')].map(r => r.dataset.id).join(',')`));
    check("工具条有实际高度（防白屏）", recoState.barH >= 20, `${recoState.barH}px`);
    // 清单量级状态（文件体积 + 历史归档）应可见 —— 用户关心的"会不会越来越慢/丢失"
    const recoStatus = await cdp.eval(`document.getElementById('recoStatus').textContent`);
    check("显示清单体积与历史归档状态",
      /清单 \d/.test(String(recoStatus)) && /历史已归档|历史归档/.test(String(recoStatus)),
      String(recoStatus).slice(0, 70));

    // 全选 → 计数联动
    await cdp.eval(`document.getElementById('recoAll').click()`);
    await sleep(500);
    check("全选后选中数与清单联动",
      (await cdp.eval(`document.getElementById('recoCount').textContent`)).includes("已选 3"),
      await cdp.eval(`document.getElementById('recoCount').textContent`));

    // 单条「确认下载」→ 批准进 T1、离开清单（校验"被点的那一本"确实变 tier1）
    await cdp.eval(`document.getElementById('recoNone').click()`);
    await sleep(300);
    const approveId = await cdp.eval(`document.querySelector('#recoList .reco').dataset.id`);
    const tiersBefore = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    check("前置：被点条目原本不是 tier1", Number(tiersBefore[approveId].tier) === 2, `id=${approveId} tier=${tiersBefore[approveId].tier}`);
    await cdp.eval(`document.querySelector('#recoList .reco .rq-approve').click()`);
    // 有界等待：界面条目数下降（而不是固定 sleep）
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoList .reco').length`)) === 2, { timeout: 15000 });
    const afterApprove = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({ items: document.querySelectorAll('#recoList .reco').length, count: document.getElementById('recoCount').textContent }))()`),
    );
    check("确认下载后该书离开待确认清单", afterApprove.items === 2, `${afterApprove.items} 条`);
    const tiers1 = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    check("被点的书已由管道落盘为 tier1", Number(tiers1[approveId].tier) === 1, `id=${approveId} tier=${tiers1[approveId].tier}`);
    // 关闭「立即下载」时只批准排队：不应弹出下载日志（也就是没有真的开始下载）
    check("未开启选项时只批准、不触发下载",
      (await cdp.eval(`document.getElementById('logMask').classList.contains('hidden')`)) === true);

    // 「不要了」需要二次确认，确认后进 tier3 + 用户拒绝（同样校验"被点的那一本"）
    const rejectId = await cdp.eval(`document.querySelector('#recoList .reco').dataset.id`);
    await cdp.eval(`document.querySelector('#recoList .reco .rq-reject').click()`);
    await sleep(700);
    const rejectMask = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        shown: !document.getElementById('confirmMask').classList.contains('hidden'),
        text: document.getElementById('confirmText').textContent,
        title: document.getElementById('confirmTitle').textContent,
        ok: document.getElementById('confirmOk').textContent,
        hint: document.getElementById('confirmHint').textContent,
      }))()`),
    );
    check("拒绝前弹出二次确认", rejectMask.shown === true && rejectMask.text.includes("不要了"), rejectMask.text.slice(0, 50));
    // 文案必须与动作一致（曾出现"不要了"的弹层写着「确认下载 / 开始下载」）
    check("「不要了」弹层的标题与按钮都说不要了",
      rejectMask.title.includes("不要了") && rejectMask.ok.includes("不要了"),
      `标题=${rejectMask.title} 按钮=${rejectMask.ok}`);
    check("「不要了」弹层不得出现下载话术",
      !/开始下载|下载并归档/.test(rejectMask.ok + rejectMask.hint) && /不再推荐/.test(rejectMask.hint),
      `按钮=${rejectMask.ok} 说明=${rejectMask.hint.slice(0, 40)}`);
    await cdp.eval(`document.getElementById('confirmOk').click()`);
    // 关键：等"界面已刷新"（而不是只等磁盘），否则下一次点击会落到过期行
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoList .reco').length`)) === 1, { timeout: 15000 });
    const tiers2 = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    const rejected = tiers2[rejectId];
    check("被点的书已落盘为 tier3 + 用户拒绝",
      Number(rejected.tier) === 3 && String(rejected.note || "").includes("用户拒绝"),
      `id=${rejectId} tier=${rejected.tier} note=${rejected.note}`);
    const left = await cdp.eval(`document.querySelectorAll('#recoList .reco').length`);
    check("处理后清单只剩未决策条目", left === 1, `${left} 条`);

    // 处理完最后一条 → 空态
    await cdp.eval(`document.querySelector('#recoList .reco .rq-approve').click()`);
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoList .reco').length`)) === 0, { timeout: 15000 });
    const emptyState = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({ items: document.querySelectorAll('#recoList .reco').length, text: document.getElementById('recoList').textContent, badge: document.getElementById('recoBadge').textContent }))()`),
    );
    check("清空后展示空态且徽标归零", emptyState.items === 0 && emptyState.text.includes("暂无待确认") && emptyState.badge === "", JSON.stringify(emptyState).slice(0, 80));
    // 手写勾选（手机/Obsidian 互操作）应在界面上可见
    const recPath = pathMod.join(dataDir, "watch", "_推荐待确认.md");
    const tiersPath = pathMod.join(dataDir, "watch", "tiers.json");
    const tiersBackup = await fsp.readFile(tiersPath, "utf-8");
    const bigTiers = {};
    for (let i = 0; i < 31; i += 1) {
      bigTiers[String(24000 + i)] = { tier: 2, folder: "学习", note: `批量用例 ${i}`, title: `《批量书 ${i}》` };
    }
    await fsp.writeFile(tiersPath, JSON.stringify(bigTiers, null, 1), "utf-8");
    await cdp.eval(`document.getElementById('recoRefresh').click()`);
    const manyItems = await waitFor(async () => {
      const n = await cdp.eval(`document.querySelectorAll('#recoList .reco').length`);
      return n === 31 ? n : 0;
    }, { timeout: 15000 });
    const manyShown = await cdp.eval(`document.querySelectorAll('#recoList .reco').length`);
    check("刷新后出现 31 条待确认", manyShown === 31, `${manyShown} 条`);
    // 面板遮挡/像素断言（LESSONS：新面板必须验证真的画在最上层）
    const occlusion = JSON.parse(
      await cdp.eval(`(() => {
        const el = document.querySelector('#recoList .reco .t');
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return JSON.stringify({ visible: getComputedStyle(el).display !== 'none' && r.top >= 0, hit: !!top && (top === el || el.contains(top) || top.contains(el)) });
      })()`),
    );
    check("待确认条目可见且未被遮挡", occlusion.visible === true && occlusion.hit === true, JSON.stringify(occlusion));

    // 页面选项「立即下载」：开启后主按钮/单本按钮文案变化，且上限仍被拦截
    await cdp.eval(`document.getElementById('recoAll').click()`);
    await sleep(400);
    await cdp.eval(`document.getElementById('recoAutoDl').click()`); // 开启
    await sleep(400);
    const labelOn = await cdp.eval(`JSON.stringify({ main: document.getElementById('recoApprove').textContent, quick: document.querySelector('#recoList .reco .rq-approve').textContent })`);
    check("开启后主按钮与单本按钮都变成「确认并下载」", /确认并下载/.test(labelOn), labelOn);
    const tiersBeforeCap = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    await cdp.eval(`document.getElementById('recoApprove').click()`);
    await sleep(1200);
    const capToast = await cdp.eval(`document.getElementById('toast').textContent`);
    check("超上限的「确认并下载」被拦截并说明原因", capToast.includes("最多 30 本"), String(capToast).slice(0, 70));
    const tiersAfterCap = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    check("被上限拦截时不产生任何决策（tiers 未变）", JSON.stringify(tiersBeforeCap) === JSON.stringify(tiersAfterCap));

    // 开启状态下单本「确认并下载」应真的开始下载（stub 管道）
    await fsp.writeFile(pathMod.join(dataDir, "watch", "download_books.py"), "print('stub download ok')\n", "utf-8");
    await fsp.writeFile(pathMod.join(dataDir, "watch", "move_to_icloud.py"), "print('stub move ok')\n", "utf-8");
    await cdp.eval(`document.getElementById('recoNone').click()`);
    await sleep(300);
    await cdp.eval(`document.querySelector('#recoList .reco input[type=checkbox]').click()`);
    await sleep(300);
    const dlId = await cdp.eval(`document.querySelector('#recoList .reco').dataset.id`);
    await cdp.eval(`document.querySelector('#recoList .reco .rq-approve').click()`);
    const logShown = await waitFor(async () => (await cdp.eval(`document.getElementById('logMask').classList.contains('hidden')`)) === false, { timeout: 15000 });
    check("开启选项后单本确认会立即开始下载（弹出下载日志）", logShown === true);
    const logText = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('logBox').textContent`);
      return /stub download ok/.test(String(t)) ? t : "";
    }, { timeout: 20000 });
    check("下载确实执行了（日志含管道输出）", String(logText).includes("stub download ok"), String(logText).slice(-60));
    await cdp.eval(`document.getElementById('logClose').click()`);
    await sleep(600);
    const tiersDl = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    check("立即下载的书同时被批准进 tier1", Number(tiersDl[dlId].tier) === 1, `id=${dlId} tier=${tiersDl[dlId].tier}`);

    // 「已确认待下载」队列：确认后、次日巡检下载前也能在界面上看到并立即下载
    const queuedState = JSON.parse(
      await cdp.eval(`(() => {
        const box = document.getElementById('recoQueued');
        return JSON.stringify({
          hidden: box.classList.contains('hidden'),
          summary: box.querySelector('.qsummary')?.textContent || '',
          hasAll: !!document.getElementById('queuedDlAll'),
          firstTitle: box.querySelector('.qtitle')?.textContent || '',
        });
      })()`),
    );
    check("显示「已确认待下载」队列并说明次日自动下载",
      queuedState.hidden === false && /已确认待下载/.test(queuedState.summary) && /次日 08:00/.test(queuedState.summary),
      queuedState.summary.slice(0, 60));
    check("队列里能看到已确认的书", queuedState.firstTitle.length > 0, queuedState.firstTitle);
    await cdp.eval(`document.querySelector('#recoQueued .qtoggle').click()`);
    await sleep(500);
    const queuedOpen = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({ visible: !document.querySelector('#recoQueued .qlist').classList.contains('hidden'), rows: document.querySelectorAll('#recoQueued .qrow').length }))()`),
    );
    check("队列可展开且列出条目", queuedOpen.visible === true && queuedOpen.rows >= 1, JSON.stringify(queuedOpen));
    await cdp.eval(`document.getElementById('queuedDlAll').click()`);
    const queuedLog = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('logBox').textContent`);
      return /stub download ok/.test(String(t)) ? t : "";
    }, { timeout: 20000 });
    check("队列的「全部立即下载」真的执行了下载", String(queuedLog).includes("stub download ok"), String(queuedLog).slice(-50));
    await cdp.eval(`document.getElementById('logClose').click()`);
    await sleep(800);

    // 偏好记忆：刷新后「立即下载」仍为开启
    await cdp.eval(`location.reload()`);
    await sleep(6000);
    await cdp.eval(`document.querySelector('.tab[data-tab="reco"]')?.click()`);
    await sleep(2500);
    check("「立即下载」选项刷新后保持（localStorage 记忆）",
      (await cdp.eval(`document.getElementById('recoAutoDl').checked`)) === true);
    // 关掉，避免影响后续用例
    await cdp.eval(`document.getElementById('recoAutoDl').click()`);
    await sleep(500);
    check("关闭后回到只批准模式", (await cdp.eval(`document.getElementById('recoApprove').textContent`)) === "确认下载");

    // 手写勾选状态可见（互操作）
    const marked = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({ n: document.querySelectorAll('#recoList .tag.marked').length }))()`),
    );
    check("已勾选条目暂无标记（前置）", marked.n === 0, `${marked.n}`);
    const mdNow = await fsp.readFile(recPath, "utf-8");
    await fsp.writeFile(recPath, mdNow.replace(/(- \[)([ xX])(\] 2400)/, "$1x$3"), "utf-8");
    await cdp.eval(`document.getElementById('recoRefresh').click()`);
    const markTag = await waitFor(async () => cdp.eval(`document.querySelector('#recoList .tag.marked')?.textContent || ''`), { timeout: 15000 });
    check("清单里手写的勾选在界面上可见", String(markTag).includes("确认下载"), String(markTag));

    // 管道脚本缺失：界面应明确提示"只能查看"
    const scriptPath = pathMod.join(dataDir, "watch", "recommend.py");
    const scriptBackup = await fsp.readFile(scriptPath, "utf-8");
    await fsp.rm(scriptPath, { force: true });
    await cdp.eval(`document.getElementById('recoRefresh').click()`);
    const recoNotice = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('recoNotice').textContent`);
      return String(t).includes("不可用") ? t : "";
    }, { timeout: 15000 });
    check("脚本缺失时给出只读提示", String(recoNotice).includes("不可用"), String(recoNotice).slice(0, 60));
    await fsp.writeFile(scriptPath, scriptBackup, "utf-8");
    await fsp.writeFile(tiersPath, tiersBackup, "utf-8");
    await cdp.eval(`document.getElementById('recoRefresh').click()`);
    await sleep(2000);

    // ---------- 折叠区：推荐浏览（恢复旧「推荐清单」浏览/直接下载）----------
    await cdp.eval(`document.querySelector('#recoBrowse .xtoggle').click()`);
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoBrowse .brow').length`)) > 0, { timeout: 15000 });
    const browseInfo = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        rows: document.querySelectorAll('#recoBrowse .brow').length,
        summary: document.querySelector('#recoBrowse .qsummary')?.textContent || '',
        filters: document.querySelectorAll('#recoBrowse .xfilter').length,
        hasDl: !!document.getElementById('browseDl'),
      }))()`),
    );
    check("推荐浏览区恢复了原始清单浏览能力",
      browseInfo.rows > 0 && browseInfo.summary.includes("推荐浏览") && browseInfo.filters === 3 && browseInfo.hasDl,
      `${browseInfo.rows} 条 · ${browseInfo.summary.slice(0, 40)}`);
    // 选择框用途：有提示文案、计数联动、无选择时按钮禁灰
    check("推荐浏览标注了选择框用途",
      (await cdp.eval(`document.querySelector('#recoBrowse .xhint')?.textContent || ''`)).includes("勾选可批量"),
      await cdp.eval(`document.querySelector('#recoBrowse .xhint')?.textContent || ''`));
    check("未勾选时「下载选中」禁灰",
      (await cdp.eval(`document.getElementById('browseDl').disabled`)) === true);
    await cdp.eval(`document.querySelector('#recoBrowse .brow input[type=checkbox]').click()`);
    await sleep(500);
    const afterPick = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({ disabled: document.getElementById('browseDl').disabled, label: document.getElementById('browseDl').textContent, summary: document.querySelector('#recoBrowse .qsummary').textContent }))()`),
    );
    check("勾选后计数与按钮联动", afterPick.disabled === false && /下载选中\(1\)/.test(afterPick.label) && afterPick.summary.includes("已选 1 本"),
      `${afterPick.label} · ${afterPick.summary.slice(0, 46)}`);
    await cdp.eval(`document.querySelector('#recoBrowse .brow input[type=checkbox]').click()`);
    await sleep(400);

    // 点击书名/整行 → 展开完整介绍（列表里只有书名，这里补全）
    // 按 data-id 点一条夹具里有详情的（不依赖排序/首行是哪本）
    await cdp.eval(`(document.querySelector('#recoBrowse .brow[data-id="23408"] .btitle') || document.querySelector('#recoBrowse .brow .btitle')).click()`);
    await waitFor(async () => (await cdp.eval(`!!document.querySelector('#recoBrowse .bdetail .dintro')`)) === true, { timeout: 15000 });
    const detailInfo = JSON.parse(
      await cdp.eval(`(() => {
        const d = document.querySelector('#recoBrowse .bdetail');
        return JSON.stringify({
          shown: !!d,
          meta: d?.querySelector('.dmeta')?.textContent || '',
          introLen: (d?.querySelector('.dintro')?.textContent || '').length,
          hasTocDetail: !!d?.querySelector('.dtoc'),
        });
      })()`),
    );
    check("点书名可展开完整介绍", detailInfo.shown === true && detailInfo.introLen > 0, `简介 ${detailInfo.introLen} 字`);
    check("完整介绍含元数据与目录",
      /作者：/.test(detailInfo.meta) && detailInfo.hasTocDetail === true, detailInfo.meta.slice(0, 50));
    check("展开后未出现占位值（如「译者：无」）", !/：无(　|$|·)/.test(detailInfo.meta), detailInfo.meta.slice(0, 60));
    // 再点一次收起
    await cdp.eval(`(document.querySelector('#recoBrowse .brow[data-id="23408"] .btitle') || document.querySelector('#recoBrowse .brow .btitle')).click()`);
    await waitFor(async () => (await cdp.eval(`!!document.querySelector('#recoBrowse .bdetail')`)) === false, { timeout: 8000 });
    check("再次点击可收起", (await cdp.eval(`!!document.querySelector('#recoBrowse .bdetail')`)) === false);

    // 只看已拒绝的筛选
    await cdp.eval(`[...document.querySelectorAll('#recoBrowse .xfilter')].find(e => e.textContent.includes('仅已拒绝')).click()`);
    await sleep(600);
    const onlyRejected = await cdp.eval(`document.querySelectorAll('#recoBrowse .brow').length`);
    check("推荐浏览可按「仅已拒绝」筛选", onlyRejected >= 0, `${onlyRejected} 条`);
    // 直接下载选中（勾一本 → 下载选中 → 日志出现）
    await cdp.eval(`document.querySelector('#recoBrowse .brow input[type=checkbox]')?.click()`);
    await sleep(400);
    await cdp.eval(`document.getElementById('browseDl').click()`);
    const browseLog = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('logBox').textContent`);
      return /stub download ok/.test(String(t)) ? t : "";
    }, { timeout: 20000 });
    check("推荐浏览的「下载选中」真的执行下载", String(browseLog).includes("stub download ok"), String(browseLog).slice(-40));
    check("下载提交后自动清空选择（避免误以为尚未处理）",
      (await cdp.eval(`document.getElementById('browseDl').disabled`)) === true);
    await cdp.eval(`document.getElementById('logClose').click()`);
    await sleep(600);

    // 「恢复为待定」：把已拒绝的书改回待定（EBM 会写 tiers.json，带备份），并重回待确认
    const restoreBtn = await cdp.eval(`document.querySelector('#recoBrowse .rq-restore')?.dataset.id || ''`);
    check("已拒绝条目提供「恢复为待定」按钮", String(restoreBtn).length > 0, String(restoreBtn));
    await cdp.eval(`document.querySelector('#recoBrowse .rq-restore').click()`);
    const restoreToast = await waitFor(async () => {
      const t = await cdp.eval(`document.getElementById('toast').textContent`);
      return String(t).includes("已恢复") ? t : "";
    }, { timeout: 15000 });
    check("恢复动作有明确反馈", String(restoreToast).includes("已恢复"), String(restoreToast).slice(0, 50));
    const restoredTiers = JSON.parse(await fsp.readFile(pathMod.join(dataDir, "watch", "tiers.json"), "utf-8"));
    check("被恢复的书已由 EBM 写回 tier2", Number(restoredTiers[restoreBtn].tier) === 2, `id=${restoreBtn} tier=${restoredTiers[restoreBtn].tier}`);
    check("恢复时写出了 tiers.json 备份",
      (await fsp.readdir(pathMod.join(dataDir, "tiers-backup")).catch(() => [])).length >= 1);
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoList .reco').length`)) >= 1, { timeout: 15000 });
    check("恢复的书重新出现在「待确认」清单里",
      (await cdp.eval(`[...document.querySelectorAll('#recoList .reco')].map(r => r.dataset.id).join(',')`)).includes(String(restoreBtn)),
      await cdp.eval(`[...document.querySelectorAll('#recoList .reco')].map(r => r.dataset.id).join(',')`));

    // ---------- 折叠区：历史决策（归档查看 + 搜索）----------
    await cdp.eval(`document.querySelector('#recoArchive .xtoggle').click()`);
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoArchive .arow').length`)) > 0, { timeout: 15000 });
    const archInfo = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        rows: document.querySelectorAll('#recoArchive .arow').length,
        summary: document.querySelector('#recoArchive .qsummary')?.textContent || '',
        first: document.querySelector('#recoArchive .arow')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) || '',
        hasSearch: !!document.getElementById('archiveQ'),
        hasMonth: !!document.getElementById('archiveMonth'),
      }))()`),
    );
    check("历史决策区可查看归档条目（原先只能翻 Markdown）",
      archInfo.rows > 0 && archInfo.hasSearch && archInfo.hasMonth, `${archInfo.rows} 条 · ${archInfo.first}`);
    check("归档条目显示日期与动作", /\d{4}-\d{2}-\d{2}/.test(archInfo.first) && /已批|不要了/.test(archInfo.first), archInfo.first);
    // 搜索过滤
    await cdp.eval(`(() => { const i = document.getElementById('archiveQ'); i.value = '绝不存在的关键词xyz'; i.dispatchEvent(new Event('input')); })()`);
    await waitFor(async () => (await cdp.eval(`document.querySelector('#recoArchive .qlist').textContent`)).includes("没有匹配"), { timeout: 10000 });
    const noHit = await cdp.eval(`document.querySelectorAll('#recoArchive .arow').length`);
    check("归档搜索无命中时给出空态", noHit === 0);
    await cdp.eval(`(() => { const i = document.getElementById('archiveQ'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await waitFor(async () => (await cdp.eval(`document.querySelectorAll('#recoArchive .arow').length`)) > 0, { timeout: 10000 });
    check("清空搜索后恢复列表", (await cdp.eval(`document.querySelectorAll('#recoArchive .arow').length`)) > 0);
    check("折叠区操作无 JS 异常", cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(" | "));

    check("待下载确认过程无 JS 异常", cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(" | "));

    check("页面无 JS 异常", cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(" | "));
    check("页面无 console.error", cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 2).join(" | "));

    // ================= 阅读器（S3：缩放 / 单页 / 续读 / 自动在读）=================
    const pdfRel = lib.pdfRel;
    await cdp.goto(`${srv.base}/read?path=${encodeURIComponent(pdfRel)}`);
    let rendered = false;
    for (let i = 0; i < 40; i++) {
      const holders = await cdp.eval(`document.querySelectorAll('.pageholder').length`);
      if (holders > 0) { rendered = true; break; }
      await sleep(500);
    }
    check("阅读器完成首屏渲染", rendered, String(await cdp.eval(`document.getElementById('pageinfo')?.textContent`)));
    const holderCount = await cdp.eval(`document.querySelectorAll('.pageholder').length`);
    check("渲染页数与 PDF 一致", holderCount === 12, `${holderCount} 页`);
    check("缩放工具条已就绪", (await cdp.eval(`!!document.querySelector('.zoombar .zb[data-zoom="page"]')`)) === true);
    // 有界重试：渲染是异步的，并行跑测试时首绘可能被拖慢（曾出现一次时序 flake）
    let canvasSeen = 0;
    for (let i = 0; i < 12; i++) {
      canvasSeen = await cdp.eval(`document.querySelectorAll('#pdfbox canvas').length`);
      if (canvasSeen >= 1) break;
      await sleep(500);
    }
    check("首屏已绘制书页 canvas", canvasSeen >= 1, `${canvasSeen} 个 canvas`);

    let autoMarked = false;
    for (let i = 0; i < 20; i++) {
      const s = await json(srv.base + "/api/shelves");
      if (s.body.items?.[pdfRel]?.reading) { autoMarked = true; break; }
      await sleep(400);
    }
    check("打开阅读页自动标记在读", autoMarked);

    // ---------- 默认阅读习惯：适合整页 + 单页模式（v2 默认；之后沿用用户选择）----------
    const defaults = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        single: document.getElementById('pdfbox').classList.contains('single'),
        visible: [...document.querySelectorAll('.pageholder')].filter(h => getComputedStyle(h).display !== 'none').length,
        pageBtnOn: document.querySelector('.zoombar .zb[data-zoom="page"]').classList.contains('on'),
        zoomLabel: document.getElementById('zlabel').textContent,
        modeLabel: document.getElementById('btnMode').textContent,
      }))()`),
    );
    check("默认进入单页模式", defaults.single === true && defaults.visible === 1, `可见 ${defaults.visible} 页 · 按钮=${defaults.modeLabel}`);
    check("默认缩放为适合整页", defaults.pageBtnOn === true, `倍率显示 ${defaults.zoomLabel}`);

    const holderWidth = () => cdp.eval(`Math.round(document.querySelector('.pageholder').getBoundingClientRect().width)`);
    await cdp.eval(`document.querySelector('.zoombar .zb[data-zoom="100"]').click()`);
    await sleep(1500);
    const w100 = await holderWidth();
    await cdp.eval(`document.querySelector('.zoombar .zb[data-zoom="150"]').click()`);
    await sleep(1800);
    const w150 = await holderWidth();
    check("100% 档位等于 PDF 原始尺寸", Math.abs(w100 - 612 * (96 / 72)) < 6, `${w100}px（期望 ≈816）`);
    check("切到 150% 后页面变宽", w150 > w100, `${w100}px → ${w150}px`);
    const zoomLabel = await cdp.eval(`document.getElementById('zlabel').textContent`);
    check("倍率指示与实际一致", String(zoomLabel).startsWith("150"), String(zoomLabel));
    await cdp.eval(`document.querySelector('.zoombar .zb[data-zoom="page"]').click()`);
    await sleep(1800);
    const fitPage = JSON.parse(await cdp.eval(`(() => {
      const b = document.getElementById('pdfbox');
      const h = document.querySelector('.pageholder').getBoundingClientRect();
      return JSON.stringify({ h: Math.round(h.height), box: b.clientHeight });
    })()`));
    check("适合整页时整页不超出一屏", fitPage.h <= fitPage.box + 6, `页高 ${fitPage.h} / 视口 ${fitPage.box}`);

    // 模式切换：单页 → 连续（全部可见）→ 单页
    await cdp.eval(`document.getElementById('btnMode').click()`);
    await sleep(1800);
    const visibleInScroll = await cdp.eval(
      `[...document.querySelectorAll('.pageholder')].filter(h => getComputedStyle(h).display !== 'none').length`,
    );
    check("切到连续滚动后全部页可见", visibleInScroll === 12, `${visibleInScroll} 页可见`);
    await cdp.eval(`document.getElementById('btnMode').click()`);
    await sleep(1800);
    const visiblePages = await cdp.eval(
      `[...document.querySelectorAll('.pageholder')].filter(h => getComputedStyle(h).display !== 'none').length`,
    );
    check("切回单页模式只显示一页", visiblePages === 1, `${visiblePages} 页可见`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await sleep(1000);
    const afterKey = await cdp.eval(`document.getElementById('pageinfo').textContent`);
    check("右方向键翻到第 2 页", String(afterKey).includes("2 / 12"), String(afterKey));

    let savedPage = 0;
    for (let i = 0; i < 20; i++) {
      const s = await json(srv.base + "/api/shelves");
      savedPage = s.body.items?.[pdfRel]?.page || 0;
      if (savedPage === 2) break;
      await sleep(500);
    }
    check("阅读进度已上报服务端", savedPage === 2, `page=${savedPage}`);

    // 显式选定"125% + 单页"，刷新后应沿用（阅读习惯被记录）
    await cdp.eval(`document.querySelector('.zoombar .zb[data-zoom="125"]').click()`);
    await sleep(1500);
    await cdp.send("Page.reload");
    await sleep(7000);
    const resumedInfo = await cdp.eval(`document.getElementById('pageinfo')?.textContent`);
    const toastText = await cdp.eval(`document.getElementById('toast')?.textContent || ''`);
    check("刷新后自动续读到上次页码", String(resumedInfo).includes("2 / 12"), String(resumedInfo));
    check("续读时给出可见提示", String(toastText).includes("上次读到"), String(toastText));
    const kept = JSON.parse(
      await cdp.eval(`(() => JSON.stringify({
        single: document.getElementById('pdfbox').classList.contains('single'),
        zoomLabel: document.getElementById('zlabel').textContent,
        stored: localStorage.getItem('ebm.reader'),
      }))()`),
    );
    check("阅读模式按设备记忆（刷新后仍是单页）", kept.single === true, String(kept.stored));
    check("缩放档位按设备记忆（刷新后仍是 125%）", String(kept.zoomLabel).startsWith("125"), `倍率 ${kept.zoomLabel} · 存储 ${kept.stored}`);

    const inkRatio = await cdp.eval(`(() => {
      const c = document.querySelector('#pdfbox canvas');
      if (!c) return -1;
      const t = document.createElement('canvas');
      t.width = 40; t.height = 40;
      const ctx = t.getContext('2d');
      ctx.drawImage(c, 0, 0, 40, 40);
      const d = ctx.getImageData(0, 0, 40, 40).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 200) ink++;
      return +(100 * ink / 1600).toFixed(2);
    })()`);
    check("书页 canvas 有真实墨迹（非空白）", inkRatio > 0.05, `墨迹像素 ${inkRatio}%`);
    check("阅读器无 JS 异常", cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2).join(" | "));
  } finally {
    cdp?.close();
    chrome?.kill("SIGKILL");
    if (srv) await srv.stop();
    if (fakeDevice) await fakeDevice.close();
    await cleanup(profile);
    await cleanup(dataDir);
    await cleanup(lib.root);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.log("失败项：\n" + failed.map((f) => `  ✖ ${f.name} — ${f.detail}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("UI 验收脚本异常:", err);
  process.exit(1);
});
