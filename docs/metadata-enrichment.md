# 书目元数据补全 · 信息获取方式与数据契约

> 面向「在 ebm 管理应用里增加元数据增补功能入口」这个开发任务。
> 本文只描述**信息怎么获取**和**获取到什么**，不含 ebm 侧实现代码。
> 实现请交给熟悉 ebm 的会话；管道侧脚本已经就绪、可独立运行，**不需要改动**。

生成时间：2026-10-05　｜　作者：yabook_watch 会话

---

## 一、要解决的问题

雅书帖子**经常只有书名，没有简介**，下载完不知道这本书讲什么。ebm 里现有元数据来自
雅书管道（`post_details.json`），覆盖率只有 **19%**。

新建了一层「书目元数据」体系，把覆盖率提到 **50%+ 并继续增长**，产出统一落在一个文件
`yabook_watch/book_meta.json`。

ebm 侧要做的事有两件：

1. **消费**这份数据（把书库的简介/作者/出版社覆盖率从 19% 提到 50%+）
2. **触发**增补（给用户一个按钮，跑完即可看到书库里多出简介）

---

## 二、信息获取方式

### 2.1 五层来源与优先级

对外部请求**逐层降级**，前一层拿不到摘要才走下一层。顺序由书名语言决定：

| 层 | 来源 | 端到端地址 | 要不要代理 | 限速 |
|---|---|---|---|---|
| **L1** | 雅书详情页 | 本地 `post_details.json`（627 条已缓存，**零网络请求**） | 否 | 无 |
| **L2** | 豆瓣 | `book.douban.com/j/subject_suggest?q=<词>` → `book.douban.com/subject/<id>/` | **否**（直连更快） | suggest 0.8~1.4s；详情页 1.6~2.6s |
| **L3** | Open Library | `openlibrary.org/search.json?q=` → `openlibrary.org/works/OLxxxW.json` | **是**，直连 `No route to host` | 0.4~0.9s |
| **L3b** | Google Books | `googleapis.com/books/v1/volumes?q=` | 是 | **需要免费 API key** |
| **L4** | arXiv | `export.arxiv.org/api/query?id_list=` / `?search_query=ti:` | 否（直连可用） | 无 |

中文书名走 `L2 → L3 → L3b → L4`；外文书名走 `L3 → L3b → L2 → L4`；文件名里带 arXiv ID
（形如 `2405.18369`）的优先走 `L4` 直接取摘要，取不到再回落 `L3 → L2`。

**本地代理**：国外站点统一用 `http://127.0.0.1:7890`（可用环境变量 `EBM_PROXY` 覆盖）。
豆瓣等国内站点**不走代理**。

### 2.2 三个必须知道的坑（都实测过）

1. **豆瓣 `subject_search` 会被限流，`/j/subject_suggest` 不会。**
   前者几分钟内就返回 `{"error_info":"搜索访问太频繁。","items":[]}`；后者是轻量 JSON
   接口，持续请求不受影响。**必须用 suggest 接口做检索。**

2. **suggest 接口对含空格的查询直接返回空数组。**
   `沈复 浮生六记` → 0 条，`浮生六记` → 3 条。所以检索词必须生成「短的、无空格的、
   中文片段优先」的候选队列（脚本里 `search_queries()` 负责，实测命中率从 44% 提到 87%）。

3. **Google Books 匿名调用 429，换 IP 无效。**
   直连和走代理都返回 `429 Quota exceeded ... consumer 'project_number:624717413613'`
   —— 配额挂在共享的匿名项目上。**必须申请一个免费 API key**，之后
   `googleapis.com` 就能通（已验证：带 key 时返回 `400 API key not valid`，
   说明请求确实到达了 API；带真 key 即出数据）。
   key 放环境变量 `GOOGLE_BOOKS_API_KEY` 或写进 `~/.dsh/google_books_key`，脚本自动启用。

### 2.3 硬约束：绝对不要读书文件内容

iCloud 里大多数书是**仅云端占位文件**，读它会抛
`OSError: [Errno 11] Resource deadlock avoided`。

所以整套元数据**只来自文件名 + 网络**，不解析 PDF/EPUB 内容。ebm 侧若要做
「从 PDF 里抽简介」的功能，必须先 `brctl download` 单本取回（违反策略 A 红线，不要做）。

### 2.4 缓存与断点续跑

所有外部检索结果按 `层:书名|作者|arxivID` 为 key 落盘到 `meta_cache.json`，
**失败也缓存**（记录 `note` 原因）。再次运行直接读缓存，不重复请求。
脚本每 25 本 flush 一次，中途中断不丢已完成的进度，直接重跑即可续上。

`meta_enrich.py --retry-failed` 可强制重试上次失败的条目。

---

## 三、获取到的内容：数据契约

### 3.1 `yabook_watch/book_meta.json`（主产出）

```jsonc
{
  "generated_at": "2026-10-05T15:01:34",
  "library_root": "~/Library/Mobile Documents/com~apple~CloudDocs/eBooks",
  "counts": { "files": 1119, "matched": 353, "weak": 7, "none": 759 },
  "enrich": { "ok": 9, "fail": 11, "source": "all", "at": "2026-10-05T15:32:47" },

  "books": {
    "<相对书库根的路径>": {           // key 就是 ebm 里的 rel，如 "AI/《大模型技术30讲》塞巴斯蒂安·拉施卡.pdf"
      "path": "AI/《大模型技术30讲》塞巴斯蒂安·拉施卡.pdf",
      "sources": { "douban": "37258887" },   // 数据来自哪一层；L1 是 {"yabook": 22898}

      "title": "大模型技术30讲",
      "author": "塞巴斯蒂安·拉施卡",
      "publisher": "人民邮电出版社",
      "translator": "叶文滔",
      "year": "2025-2-27",
      "pages": "182",
      "douban": "7.0",                 // "0.0" = 抓不到评分，按无评分处理
      "intro": "本书采用独特的一问一答式风格……",
      "author_bio": "塞巴斯蒂安·拉施卡（Sebastian Raschka）……",
      "original_title": "Machine Learning and AI Beyond the Basics",
      "isbn": "9787115659835",

      "douban_id": "37258887",         // L2
      "openlibrary_key": "/works/OLxxxW",  // L3
      "arxiv_id": "2309.07864v3",      // L4
      "source_url": "https://arxiv.org/abs/2309.07864",
      "enriched_at": "2026-10-05T15:10:04",
      "search_title": "大模型技术30讲",   // 检索时实际用的书名，排查用

      // —— 仅 L1（雅书命中）才有 ——
      "yabook_id": 22898,
      "match_score": 100,
      "toc": "第1章 …… 结语 397",
      "review": "",
      "tags": ["人工智能", "机器学习", "数学"],

      // —— 状态标记（三者互斥，同一个 key 只会出现其一）——
      "needs_review": true,    // L1 匹配置信度偏低（<62 分），已人工抽检，可视为"弱匹配"
      "enrich_partial": true,  // 只补到作者/年份，所有源都没有摘要
      "enrich_failed": true    // 所有源都没命中，下次运行自动跳过（--retry-failed 除外）
    }
  }
}
```

> 上面为了说明字段把 L1/L3/L4 的字段都堆在同一条示例里。**真实记录只会有其中一层**：
> `sources` 里是哪个 key（`yabook` / `douban` / `openlibrary` / `arxiv` / `arxiv_search` /
> `googlebooks`），就只带那一层的标识字段。

**字段实测填充率**（2026-10-05 16:12 快照；补全任务仍在跑，每约 5 本/分钟增长）：

| 字段 | 条数 | 覆盖率 |
|---|---|---|
| `path` / `sources` / `title` / `author` | 1119 | 100% |
| `intro` | 580 | 51% ↗ |
| `publisher` | 571 | 51% |
| `year` | 566 | 50% |
| `author_bio` | 551 | 49% |
| `pages` | 537 | 47% |
| `douban` | 527 | 47% |
| `translator` | 485 | 43% |
| `toc` / `tags` / `review`（仅 L1） | 353 | 31% |
| `isbn` / `douban_id` | 223 | 19% |
| `arxiv_id` | 15 | 1% |
| `openlibrary_key` | 2 | 0% |

**来源覆盖**（补全仍在进行中，每约 5 本/分钟增长）：
`yabook` 353 本（349 带简介）· `douban` **223 本（211 带简介，命中率 95%）** ·
`arxiv` + `arxiv_search` 16 本（全部带简介）· `openlibrary` 2 本（外文书排在队尾，尚未跑完）。

### 3.2 其余产出

| 文件 | 内容 |
|---|---|
| `yabook_watch/meta_cache.json` | 检索缓存，key = `层:书名\|作者\|arxivID`，值 = `{ok, note, data, at}`。失败也缓存 |
| `iCloud/eBooks/书库索引.md` | 按 23 个分类的 Markdown 表格，含简介摘要 + 文末「待补充简介的书」清单 |
| `iCloud/eBooks/library.html` | 单文件网页目录：1119 张卡片，搜索/分类/5 种排序，可展开完整简介。已验证 Chrome 渲染正常 |
| `yabook_watch/reports/YYYY-MM-DD.md` | 日报，每本书带「内容简介（来源 雅书/豆瓣/arXiv）」 |
| `iCloud/eBooks/_推荐待确认.md` | 勾选清单，每条下面附**作者 · 出版日期**和一行 120 字简介 |

### 3.3 匹配安全规则（重要：宁可不补，也不补错）

每条候选按下列优先级打分，取最高分；同分取**更靠后**的标题片段
（「系列名 分册名」里靠后的那个才是具体这本书）：

| 分 | 规则 |
|---|---|
| 100 | 完整标题归一后完全一致 |
| 95 | 文件名主标题（副标题前，如 `AI阅读力:解锁6大学习超能力` → `AI阅读力`）与候选一致 |
| 94 | 候选主标题与文件名一致 |
| 92 | 候选等于文件名的某个中文片段（≥2 字） |
| 92 | 一方标题被另一方包含，覆盖度 ≥50% |
| 89 | 同长度且来自书名片段（处理繁简差异，如 `金文編` → `金文编`） |
| 90 | 两条归一标题互相包含，覆盖度 ≥50%、短串 ≥6 字 |
| 88 | 相似度 ≥88；或 ≥75 且有作者佐证 |

低于阈值**留空并计入「待补充」，绝不塞一个可能是别的书的简介**。
已抽检 94 条：81 条 100 分、10 条 90+、2 条 80+、1 条 79，无一条错配。

> ⚠️ 已知瑕疵（可接受）：命中外围丛书条目时 `title` 可能被写成丛书名
> （如「天下无谋之秘卷八书 仕经（第八部）」的 title 变成「仕经」是**对的**，
> 但少数条目会写成系列名），而 `intro` 是正确的那一本。

---

## 四、脚本与调用方式（管道侧，已就绪）

全部在 `<repo>/yabook_watch/`，用 `python3` 调用，
工作目录必须是该目录。

| 脚本 | 作用 | 实测耗时 | 典型命令 |
|---|---|---|---|
| `book_meta.py` | 公共底座（扫描/打分/读写），不单独运行 | — | — |
| `meta_build.py` | **L1 登记**：把雅书详情页匹配到每本书。零网络请求 | **约 27 秒**（全量 1119 本 × 627 条详情逐对打分，纯 CPU） | `python3 meta_build.py` |
| `meta_enrich.py` | **L2~L4 补简介**：外部源逐层降级 | **约 5 本/分钟**（瓶颈是豆瓣限速） | `python3 meta_enrich.py --source all --limit 80` |
| `meta_catalog.py` | **重建索引**：生成 `书库索引.md` + `library.html` | **< 1 秒** | `python3 meta_catalog.py` |

> 「补简介 80 本」= 约 16 分钟；点击按钮后要有明确的「运行中」状态，别让用户以为卡死。
> 单本耗时 3~12 秒（取决于要试几个源），缓存命中时 < 0.1 秒。

`meta_enrich.py` 的开关：

| 参数 | 含义 |
|---|---|
| `--source all\|douban\|openlibrary\|arxiv` | 限定来源，默认 `all` |
| `--limit N` | 本次最多处理 N 本 |
| `--retry-failed` | 重试缓存里标记为失败的条目 |
| `--force` | 连已有简介的也重跑 |
| `--dry-run` | 只检索不落盘（不写 `book_meta.json` / 缓存） |

**退出码**：三个脚本都是 `0`（进度信息走 stdout，逐本打印 `✅ / ◐ / ❌`）。

### 三者的关系与推荐调用顺序

```
meta_build.py     ← 登记（~27 秒，纯本地，先跑：让新书进入 book_meta.json）
   ↓
meta_enrich.py    ← 补简介（慢，3~12 秒/本，用 --limit 限时）
   ↓
meta_catalog.py   ← 重建索引（< 1 秒）
```

三者都是**幂等**的：重复跑不会重复请求（有缓存），不会覆盖已有简介
（只在字段为空时填充）。

### 日常自动化的接入点

`daily_finish.py`（每日收尾）末尾已经接好了这三步，所以**每天 8:00 的自动巡检跑完
下载归档后，会自动补一次**（`--limit 80`，最多 80 本，防止某天积压太多拖太久）。
写 ebm 的入口时，等价于手动触发同一串命令即可，不必改管道。

---

## 五、给 ebm 的集成建议（信息层面）

### 5.1 消费：把索引源切到 `book_meta.json`

`src/indexer.ts` 现在只读 `post_details.json` + `state.json`（覆盖率 19%）。
建议改成：

1. 先读 `book_meta.json`，用 **`books[rel]` 直接按路径命中**。
   ✅ **已实测：key 就是 ebm 里的 `rel`，1100/1100 直接命中，100%，不需要任何归一化。**
2. 命不中再回落到现有的 `post_details.json` 逻辑（保留兼容）。

> `book_meta.json` 比 ebm 索引多 19 条（1119 vs 1100），差异**全部是 `.zip` / `.rar` 压缩包**
> ——ebm 的扫描器不索引这两种扩展名。若以后 ebm 支持压缩包再处理，否则忽略即可。

字段映射：

| `book_meta.json` | `BookEntry` |
|---|---|
| `title` / `author` | `title` / `author`（为空时才覆盖文件名解析结果） |
| `intro` | `intro`（列表用，截断 300 字）+ `introFull`（详情用，截断 6000 字） |
| `toc` | `toc` |
| `tags` | `tags` |
| `douban` | `douban`（`"0.0"` 要当成无评分） |
| `year` | `pubDate` |
| `publisher` | `publisher` |
| `translator` / `pages` / `original_title` / `isbn` / `author_bio` | `meta` 对象（详情页展示） |

⚠️ **`book_meta.json` 里的 `intro` / `author_bio` / `toc` 仍带 HTML 实体**
（来自 L1 雅书详情页，如 `&middot;` `&ldquo;`）。indexer 里已有的
`htmlUnescape()` 直接复用即可；L2/L3/L4 的文本是干净的。

⚠️ **json 体积**：`book_meta.json` 目前 **1.98 MB**（1119 本，含最长 6000 字级的 `intro`）。
建议**启动时读一次进内存**，跟现在 `loadMeta()` 的时机一致；不要每请求读盘。

### 5.2 触发：建议的两个接口

沿用 `src/pipeline.ts` 的模式（`spawn` + `onChunk` 流式回传 + 全局互斥），
因为交互和现有的「一键下载」几乎一样。

**`GET /api/metadata/status`** —— 给面板显示覆盖率（建议 5 秒缓存或按需刷新）

```jsonc
{
  "running": false,              // 是否有增补任务在跑
  "total": 1119,
  "withIntro": 576,
  "missing": 543,
  "bySource": { "yabook": 353, "douban": 223, "arxiv": 15, "arxiv_search": 1, "openlibrary": 2 },
  "partial": 14,                 // 有资料但没摘要
  "failed": 40,                  // 所有源都没命中
  "lastRunAt": "2026-10-05T15:32:47",
  "metaMtime": 1791245400000,    // book_meta.json 的 mtime，前端可据此判断新鲜度
  "catalog": { "mdAt": 1791245000000, "htmlAt": 1791245000000 }
}
```

**`POST /api/metadata/run`** —— 与 `/api/pipeline/download` 完全同构：
`content-type: text/plain; charset=utf-8` 流式日志，`cache-control: no-cache`。

请求体：

```jsonc
{
  "tasks": ["build", "enrich", "catalog"],  // 默认全部；也允许只跑 ["enrich"]
  "limit": 80                                // 只对 enrich 生效
}
```

- 已有任务在跑 → **409**（和 `/api/pipeline/download` 一致）
- `tasks` 为空或非法 → **400**
- 任务跑完 → 兜底再刷一次 `scanner.scan()` / `index.build()`，让新简介立刻生效
  （与 `/api/pipeline/download` 的收尾一致）

**互斥要跨模块，而且必须真互斥**：`meta_build.py` 和 `meta_enrich.py` 都是
「**读整个 `book_meta.json` → 内存里改 → 整份写回**」。`meta_enrich.py` 补 80 本要跑
十几分钟，期间内存里一直攥着开跑那一刻的快照。如果这中间 `meta_build.py` 跑完并写盘，
它的结果会在 enrich 下一次 flush（每 25 本一次）时被**整份覆盖丢掉**——反之亦然。

所以：

- ebm 侧要维护一个全局 `running` 标志，`build` / `enrich` / `catalog` 串行执行；
- **下载管道与元数据任务也建议互斥**（两者都会改书库与 `book_meta.json`）；
- 任务进行中再次点击 → **409**，前端明确提示「已有任务在执行」；
- 别在服务启动时自动跑 `meta_build.py`（27 秒 CPU），按需触发即可。

### 5.3 UI 入口建议

**入口位置**：顶栏右侧一个「🗂 元数据」按钮（和搜索框同行），或在侧栏「分类」下面加一组。
点开一个弹层，内容三块：

```
┌─ 书目元数据 ─────────────────────────────┐
│ 576 / 1119 本有简介（51%）                │
│ 来源：雅书 353 · 豆瓣 223 · arXiv 16 …    │  ← 一行小字
│ □ 只补没有简介的（默认勾选）               │
│ 本次最多补 [80] 本                        │
│                                          │
│ [登记新书] [补简介] [重建索引] [一键全流程] │
│                                          │
│ ┌ 日志（流式，复用 #logBox 那个 pre）──┐  │
│ │ $ python3 meta_enrich.py --source … │  │
│ │   [ 12/80] ✅ douban 大模型技术30讲   │  │
│ └─────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

- **「补简介」是最常用的**，建议做成主按钮（`.btn.primary`）
- 「一键全流程」= `["build","enrich","catalog"]`
- 日志弹层可以**直接复用**现有的 `#logMask` / `#logBox` / `startPipeline()` 那套流式读取
- 跑完刷新 `/api/metadata/status` 和书库列表

**「检测到新书」提示条**（对应「补充外部书籍后快速增补」）：
ebm 已经有 `fs.watch` + `scanner.on("updated")`。可以在重新索引后比对
`book_meta.json` 的 key 集合，发现有文件不在里面 → 在书库顶部显示一条
`📥 检测到 3 本新书还没有简介 [立即补全]`（复用 `#searchNotice` 那类样式）。
**由用户点击触发，不要在 fs.watch 回调里自动跑**——避免用户大批拖书进来时
自动发起几百次外部请求。

### 5.4 不要做的事

1. **不要改管道侧的 `.py` 脚本**：它们被每日自动任务共享，改动会影响 8:00 的巡检。
2. **不要在 ebm 里重新实现匹配/请求逻辑**：外部源的限速、限流规避、缓存、
   匹配规则都在 `meta_enrich.py` 里调好了，重写一遍会踩同样的坑。
3. **不要并发跑两个 `meta_enrich.py`**：会互相覆盖 `book_meta.json`。
4. **不要为了元数据取回 iCloud 文件**：违反策略 A 红线。
5. **不要把 `introFull` 放进 `/api/books`**：`book_meta.json` 的完整简介很长，
   必须沿用现在「列表轻量 + `/api/book` 单本按需」的做法。

---

## 六、验收清单（给实现方）

- [ ] `npm test` 通过（新增接口的契约测试要进 `test/api.test.js`）
- [ ] `npm run test:ui` 通过（新弹层要有几何/像素断言，别白屏）
- [ ] 测试夹具要**新增 `book_meta.json`**（`test/helper.js` 里 `META_FIXTURE` 旁边加一份），
      并覆盖：有 `intro` 的、只有 `yabook` 的、`douban: "0.0"` 的、`enrich_failed` 的
- [ ] 手动点「补简介」能跑完并把新简介显示在书库卡片和详情页
- [ ] 任务运行中再点一次 → 409，前端有明确提示
- [ ] 测试期间**不触碰真实书库与 `yabook_watch`**（沿用 `EBM_WATCH_DIR` 隔离）
- [ ] 同步更新 `docs/api.md`（新增 2 个路由）与 `docs/CHANGELOG.md`

---

## 七、可直接复制的验证命令

```bash
cd <repo>/yabook_watch

# 看当前覆盖率与来源分布
python3 meta_catalog.py --md

# 手动跑一遍三步（不写盘，先看会命中什么）
python3 meta_build.py --report
python3 meta_enrich.py --source all --limit 5 --dry-run

# 只补简介（这就是 ebm 里「补简介」按钮要做的事）
python3 meta_enrich.py --source all --limit 80

# 重建两份目录
python3 meta_catalog.py
```

管道侧正在跑的批量补全任务：`pgrep -fl meta_enrich.py`，
日志在 `/tmp/enrich_full2.log`。


---

## 八、ebm 会话的改动记录（2026-10-05，已获用户批准）

> 本文原约定"管道脚本不需要改动"。以下改动经用户确认后由 ebm 会话执行，留痕以便 yabook_watch 会话知情。

### 8.1 已消费（只读，未改管道）

- `src/indexer.ts` 读 `book_meta.json`（按 `rel` 精确命中、只填空不覆盖、随 mtime 自动重载）
- 新增 `GET /api/metadata/status`、`POST /api/metadata/run`；互斥锁 `src/jobs.ts`；外部进程护栏（`ps -Ao command` + 只认以 python 开头的行）
- 新增**待补清单与人工覆盖**（不写管道数据）：`GET /api/metadata/gaps`、`POST /api/metadata/candidates`（**调用本仓库的 `meta_enrich.search_queries/douban_pick`**，不重写匹配逻辑）、`POST /api/metadata/adopt`、`POST /api/metadata/override`、`DELETE /api/metadata/override`
- ebm 自己的覆盖文件：`ebm/data/meta_overrides.json`（优先级最高，可撤销）

### 8.2 修改了 `meta_enrich.py`（1 处，已备份）

**问题**：L3b Google Books 层长期无效。用户配好 key 后实测：
- `q=intitle:"<书名>"`（带引号）→ **HTTP 200 但 items=0**（The RLHF Book 宽松查询 totalItems=12，精确查询 0）
- 缓存里**没有任何 `googlebooks:` 记录** → 该层此前没被真正调用过

**改动**（`googlebooks_lookup` 及其两个新辅助函数）：
1. `gb_query()`：查询逐级放宽 `intitle:<书名> [inauthor:<作者>]` → 纯书名（保留 `maxResults=5`、`country=US`）
2. `gb_title_ok()`：**标题完整度守卫**——候选标题归一化后长度须 ≥ 查询标题的 70%。原因：`score_match("Introduction to Agents", "Introduction") = 88`，与合法缩写 `Sous Vide at Home → Sous Vide` 同分，仅靠阈值无法区分，会把泛化条目错配进来
3. 失败原因区分「候选不匹配(N分)」与「候选标题过短(N分: xxx)」，便于排查

**实测效果**：`Deep Learning` → 简介 2036 字、`Large Language Models` → "A Deep Dive" 3560 字、`Grokking Algorithms` → 命中；`Introduction to Agents` 正确拒绝（避免错配）；`The RLHF Book` Google Books 确实没有。

**备份**：`yabook_watch/meta_enrich.py.bak-20261005-222301`（如需回滚：`cp` 回来即可）。
**对每日巡检的影响**：只影响 Google Books 层的召回与准确性（更严、更准），其余来源与退出码不变。

### 8.3 ebm 侧新增：自动感知元数据更新

服务现在监听 `book_meta.json`，文件变化后（去抖 2 秒）自动重建索引 → 每日 8:00 巡检补完简介后，网页无需任何手动操作即可看到。

### 8.4 雅书（L1）候选与现场抓取（v1.7.2）

用户反馈"雅书明明有这本书，候选里却没有"。追查结论：
1. ebm 的"查候选"最初**只查豆瓣**——雅书候选从未在界面出现；
2. 雅书层只覆盖 `post_details.json` 的 **627 条已抓详情**，而站点帖子远多于此；
3. 部分书的帖**在 `uncat_match.json`（文件名→帖 id 映射）里有记录，但详情从未抓取**（用户举例的《改变世界的物理发现…》= 帖 22638，正是此类）。

因此 ebm 侧新增（仍不改管道文件，只调用其 CLI）：
- **雅书候选来源**：① `post_details.json` 标题相似度（复用 `book_meta.score_match`）② `uncat_match.json` / `state.json.downloads` 里的**下载时记录的权威 id**
- **现场抓取**：`ensureYabookDetail()` 在详情缺失时调用 `python3 fetch_details.py <id>`（串行化），抓到的详情会写回 `post_details.json`——**这同时扩大了你们的 L1 覆盖**，后续 `meta_build.py` 增量跑就能自动利用
- **字段守卫**：雅书帖 `author` > 40 字改记为 `author_bio`（实测帖 22638 的 `author` 是 345 字的作者简介）
- **不覆盖书名**：雅书帖标题带 `【文字版_PDF电子书_雅书】` 标记

建议管道侧后续可选改进：把 `meta_build.py` 的匹配也纳入 id 映射（现在只靠标题相似度，阈值 62 会漏掉 55~61 的那批，实测 5 本）；以及继续扩大 `fetch_details.py` 的抓取范围（L1 是最优质来源）。
