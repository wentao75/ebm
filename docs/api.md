# ebm 接口参考

服务默认监听 `0.0.0.0:6722`。所有接口同时可经公网 `https://ebm.example.com`（Basic Auth）访问。
本文件与 `src/server.ts` 的 21 个路由一一对应；改接口时请同步此文件。

---

## 基础查询

### `GET /api/health`
服务与索引自检。
```json
{ "ok": true, "root": "/Users/…/eBooks", "books": 1058 }
```

### `GET /api/books`
书库列表（**轻量版**：简介截断 300 字，不含目录/meta；1058 本约 447KB）。
```json
{ "updated": 1790854826804, "books": [ { "rel": "古文/《荣枯鉴》何必.pdf", "title": "荣枯鉴", "author": "何必",
  "category": "古文", "ext": "PDF", "size": 1180390, "mtimeMs": 1789873154000,
  "douban": "8.9", "intro": "…最多300字…", "tags": ["…"], "publisher": "…", "pubDate": "2017-01",
  "sourceId": 23317, "dataless": true } ] }
```

### `GET /api/book?path=<rel>`
**单本详情**（含完整大字段，按需拉取）。
```json
{ "book": { …同上的全部字段…, "introFull": "…最多6000字…", "toc": "…目录原文…",
  "meta": { "书名": "…", "作者": "…", "出版社": "…", "译者": "…", "出版日期": "…", "页数": "…" } } }
```
- `404` 该书不在索引中
- 目录 `toc` 是**无换行的长字符串**，前端 `formatToc()` 负责分行显示

### `GET /api/categories`
```json
[ { "name": "经济&投资", "count": 130 }, … ]   // 按数量倒序
```

### `GET /api/search?q=<关键词>`
多 token 子串匹配（书名/作者/分类/标签/简介/豆瓣分），按相关度 + 豆瓣分 + 时间排序。
```json
{ "q": "荣枯鉴", "books": [ … ] }
```

### `GET /api/recent?limit=30`
按文件修改时间倒序（`limit` 上限 100）。
```json
{ "books": [ … ] }
```

---

## 书架与阅读进度（服务端持久化，多设备共享）

### `GET /api/shelves`
```json
{ "updated": 1790854826804,
  "items": { "古文/《荣枯鉴》何必.pdf": { "ts": 1790854826804, "reading": true, "fav": true, "done": false, "page": 88 } } }
```

### `POST /api/shelves`
切换书架归属。请求体：
```json
{ "rel": "古文/《荣枯鉴》何必.pdf", "shelf": "fav", "value": true }
```
- `shelf` ∈ `reading` | `fav` | `done`；`value` 缺省为 `true`，传 `false` 取消
- 标 `done:true` 时**服务端自动移除 `reading`**
- 返回 `{ "ok": true, "record": { …该书最新记录… } }`；取消后若记录已无任何标记则被回收（`record: null`）
- `400`：`rel` 非法（空/超 512 字/非字符串）或 `shelf` 非法或请求体非法 JSON

### `POST /api/shelves/progress`
记录阅读进度。请求体：`{ "rel": "…", "page": 88 }`
- `page` 会被收敛到 `[1, 100000]`；非数字 → `400`
- 返回 `{ "ok": true, "record": { … } }`

---

## 文件下载与预览

### `GET /api/file?path=<rel>&disp=inline|attachment`
- **支持 HTTP Range**：`Range: bytes=0-99` → `206` + `Content-Range`；越界 → `416`
- `disp=inline` 用于在线预览，`attachment` 用于下载（带 RFC 5987 文件名）
- `403` 非法路径（路径穿越、不在书库根内）· `404` 不存在
- **`202`**：该书是 iCloud 仅云端占位文件 → 已触发取回；响应体是提示文案，前端轮询 `/api/materialized`

### `GET /api/materialized?path=<rel>`
取回状态探针。
```json
{ "ready": true }                      // 已落地可读
{ "ready": false, "status": "pending" } // 正在取回（前端每 3s 轮询）
{ "ready": false, "status": "failed" }  // 超时/失败
```

### `GET /api/cover?path=<rel>&v=<mtimeMs>`
- 命中缓存或成功生成 → `200` + `image/png` + `Cache-Control: public, max-age=604800, immutable`
- 云端书（dataless）→ `404 "no cover (cloud book)"`，**绝不触发取回**（策略 A）
- 非 PDF/EPUB → `404`；生成失败 → `404`；非法路径 → `403`
- 仅本地 PDF（`sips` 渲首页）/ EPUB（解内嵌封面）会真正生成

---

## 书目元数据补全

> 数据契约与来源说明见 [metadata-enrichment.md](metadata-enrichment.md)（管道侧三个脚本已就绪，ebm 只负责消费与触发）。

### `GET /api/metadata/status`
覆盖率、来源分布、任务状态与"待补清单"。
```json
{ "running": false, "externalMeta": false, "total": 1119, "withIntro": 795, "missing": 324,
  "bySource": { "douban": 407, "yabook": 353, "arxiv": 58, "openlibrary": 11, "arxiv_search": 2 },
  "partial": 32, "failed": 85, "needsReview": 7,
  "lastRunAt": "2026-10-05T15:32:47", "generatedAt": "2026-10-05T15:01:34",
  "metaMtime": 1791189952373,
  "catalog": { "mdAt": 0, "htmlAt": 0 },
  "missingRels": ["历史/某本新书.pdf"] }
```
- `missingRels` = 书库里有、`book_meta.json` 里还没有的书 → 前端据此显示「📥 检测到 N 本新书还没有简介」
- `externalMeta` = 检测到**非本应用启动**的管道元数据进程（每日巡检等）；此时触发会 `409`

### `POST /api/metadata/run`
触发补全任务，**流式日志**（`text/plain` 分块，与 `/api/pipeline/download` 同构）。
```json
{ "tasks": ["build", "enrich", "catalog"], "limit": 80 }
```
- `tasks` ∈ `build`（登记新书，~27s）| `enrich`（补简介，~5 本/分钟）| `catalog`（重建索引，<1s）；省略则全部
- `limit` 仅对 `enrich` 生效，上限 200
- `409`：本应用已有任务在跑（共用互斥锁）**或**检测到外部元数据进程（防两个 enrich 互相覆盖 `book_meta.json`）
- `400`：`tasks` 非数组/无有效值、`limit` 非正数
- 任务结束后服务端会自动重扫重建索引，新简介立刻生效

### `GET /api/metadata/gaps`
**待补清单**：哪些书缺简介、原因是什么（原因来自管道 `meta_cache.json` 的真实说明）。
```json
{ "total": 258, "overrides": 1,
  "byReason": { "low_score": 85, "partial": 60, "other": 46, "no_candidate": 36, "near_miss": 31 },
  "items": [ { "rel": "运动&健康/《给久坐者的12堂体态纠正课》荣·范.pdf", "title": "给久坐者的12堂体态纠正课",
    "author": "荣·范", "reason": "near_miss", "score": 73,
    "candidates": ["给久坐者的12堂体态课"], "note": "候选不匹配(73分: 给久坐者的12堂体态课、…)",
    "overridden": false } ] }
```
- `reason`：`near_miss`（豆瓣有同书候选但分数不足 88/75）· `low_score`（<70，疑似不同书）· `no_candidate`（豆瓣无候选）· `partial`（只补到作者/年份）· `throttled`（被限流）· `no_entry`（未登记进 `book_meta.json`）· `other`
- 排序：`near_miss` 优先、按分数倒序；**已有简介的书与已人工覆盖的书不进清单**

### `POST /api/metadata/candidates`
同时返回**雅书（L1，最可靠）**与**豆瓣**两组候选，供人工确认。
- 请求 `{ "rel": "…" }`
- 响应：
```jsonc
{ "ok": true,
  // 雅书候选：① 标题相似度命中缓存 ② 书库下载记录里的雅书 id（uncat_match.json / state.json）
  "yabook": [ { "id": 22638, "title": "《改变世界的物理发现…》…", "score": 96, "introLen": 257,
                "hasToc": true, "cached": true, "from": "score" } ],
  // 豆瓣候选
  "best": null, "score": 73, "auth": false,
  "top": [ { "id": "36255869", "title": "量子物理如何改变世界", "author": "…", "year": "…" } ] }
```
- `yabook[].from`：`score`（标题相似度）/ `map`（**书库下载记录里的雅书 id**，即"书确实来自雅书但详情未缓存"的情形）
- `yabook[].cached=false` → 采纳时会**现场抓取**该帖详情（约 2~5 秒，抓到的详情同时成为 L1 层的长期资产）
- `400` rel 非法 · `404` 书不在索引 · `502` 管道脚本/网络不可用（响应带 `log`）
- 说明：分数低于自动采纳门槛（88 分，或有作者佐证 75 分）时 `best` 为 `null`，但 `top` 仍会列出候选供人工判断

### `POST /api/metadata/adopt`
采纳某个豆瓣条目 → 抓详情 → 写入**人工覆盖**（ebm 自己的 `data/meta_overrides.json`，**不改管道数据**）。
- 请求 `{ "rel": "…", "doubanId": "36538507", "score": 73 }`（`doubanId` 必须为纯数字，防注入）
- `400` 参数非法 · `404` 书不在索引 · `502` 豆瓣详情抓取失败（限流/条目不可用）
- 采纳后立即重建索引，书库与详情页马上生效，来源标记为 `douban（人工确认）`

### `POST /api/metadata/adopt-yabook`
采纳雅书帖（L1）：详情已缓存则直接读取，**未缓存则现场抓取**（调用管道自带 `fetch_details.py <id>`）。
- 请求 `{ "rel": "…", "yabookId": "22638" }`（id 必须为纯数字）
- `400` 参数非法 · `404` 书不在索引 · `502` 抓取失败或无该帖
- **不会覆盖书名**（雅书帖标题带 `【文字版_PDF电子书_雅书】` 等标记，会污染书库显示）；作者字段 >40 字视为作者简介

### `POST /api/metadata/override`
手工填写（可只填部分字段）：`{ "rel": "…", "fields": { "intro": "…", "publisher": "…", "douban": "8.8", "tags": "甲,乙" } }`
- 字段白名单：`title/author/intro/publisher/year/pages/translator/douban/isbn/author_bio/toc/tags`
- **清除字段**（修正污染数据）：`{ "rel": "…", "clear": ["author"] }` → 清掉后回落到管道/文件名数据
- **优先级最高**：显式覆盖已解析/已补全的值；`400` 无有效字段 · `404` 书不在索引

### `DELETE /api/metadata/override?path=<rel>`
撤销人工覆盖，恢复到管道补全的数据。响应 `{ ok, removed }`

## 书名 / 文件名 / 元数据编辑

> 界面入口：图书详情 → 「✏ 编辑」。设计原则：**只 rename，绝不读取文件内容**（iCloud 只读占位文件也能安全改名）；扩展名一律沿用原文件。

### `GET /api/book/rename/suggest?path=<rel>`
清理建议（纯本地、零网络）：给出建议文件名、**建议书名**、命中的规则与提示。
```json
{ "ok": true, "rel": "运动&健康/2018-05《健身笔记…》[yabook.org].pdf",
  "current": "2018-05《健身笔记：如何成为一个身材有料的人》[yabook.org].pdf",
  "suggested": "《健身笔记：如何成为一个身材有料的人》.pdf",
  "title": "健身笔记：如何成为一个身材有料的人",
  "rules": [ { "id": "bracket-domain", "label": "去掉 [yabook.org] 等站点域名", "before": "…", "after": "…" } ],
  "notes": [], "blocked": null }
```
- 清理范围：站点标记（`【文字版_PDF电子书_雅书】`、`[yabook.org]`、`[V版]`/`[PDF]`）、URL 编码（`%2B`→`+`）、`+-+`/`+.+`/`++` 连接噪声、开头日期前缀、结尾"下载地址/更多资源"、多余空格与"空格+句点"
- **只提示不自动改**：`(1)/(2)` 副本序号、英文下划线文件名
- **⚠ 两条规则严格区分**（用户明确要求）：
  - **文件名**：`_` **一律不动**（它是"作者_出版_年份"的正当分隔符），仅在 `notes` 里提示
  - **书名**（响应里的 `title`）：把 `_` 还原为**空格**、不引入 ` - ` 连接符；像 `COVID-19` 这类词内连字符不动
- 物理改名需前端**二次确认**（确认条展示"旧名 → 新名"），接口本身不做二次确认
- `404` 书不在索引 · `blocked` 非空表示目标名不可用（如已存在同名文件）

### `POST /api/book/rename`
执行重命名：物理改名 + 迁移书架/阅读进度/人工覆盖 + 记**路径别名**（改名不丢元数据）+ 记日志（可回滚）。
- 请求 `{ "rel": "…", "newName": "新文件名.pdf" }`（`newName` 省略则用清理建议）
- 返回 `{ ok, oldRel, newRel, extForced, migrated: { shelf, override } }`
- `400`：名称非法（空/含 `/`、`\`）、同目录已存在同名文件、新名与原名相同
- 扩展名：不写或写错都会**自动沿用原扩展名**（`extForced=true`），避免把书改成别的格式

### `POST /api/book/rename/undo`
撤销该书最近一次重命名（文件与数据一并还原）：`{ "rel": "<新 rel>" }`

### `GET /api/book/rename/history?path=<rel>`
是否可撤销：`{ ok, undoable, last: { old, new, at } }`

**数据文件**：`data/path-aliases.json`（new→old 别名链，索引器据此查回管道元数据）、`data/rename-map-manual.json`（重命名日志，格式与批量清理的 `rename-map-*.json` 一致，可直接用 `scripts/revert-rename.py` 回滚）。

## 待下载确认（每日巡检的 T2 待定书）

> 清单由管道 `recommend.py` 生成在 `~/iCloud/eBooks/_推荐待确认.md`；**决策仍由管道 `recommend.py apply` 落盘**
> （批准→tier1、拒绝→tier3+「用户拒绝」）。EBM 只做"翻转勾选 + 调脚本"，管道脚本零改动，手机/Obsidian 手写勾选依然有效。

### `GET /api/recommend/pending`
读取清单。**默认纯读取（无副作用）**；带 `?sync=1` 时先让管道 `sync` 重建清单（保留手写勾选）——界面的进入/刷新走这条。
```json
{ "ok": true, "scriptAvailable": true, "synced": true, "syncOk": true,
  "fileExists": true, "readable": true, "maxDownload": 30, "fileBytes": 25756,
  "archive": { "total": 135, "months": ["2026-10"], "lastAt": 1791811000000, "dir": "…/ebm/data/reco-archive" },
  // 已确认但还没下载的队列（tier1 且未下载/未失效，口径同管道 candidates()）
  "queued": [ { "id": 23408, "title": "《存钱心理学》埃玛·爱德华兹", "folder": "经济&投资", "note": "…", "douban": "6.3" } ],
  // 账本（state.downloads，仅每日流程记账）没记到、但书已在书库的（例如界面手动下载后）
  "queuedInLibrary": [ { "id": 23421, "title": "《故事里的心理学》钟颖", "folder": "心理学" } ],
  "file": "…/eBooks/_推荐待确认.md", "processedCount": 131,
  "items": [ { "id": 23408, "mark": "pending", "title": "《存钱心理学》埃玛·爱德华兹",
               "folder": "经济&投资", "note": "消费/金钱心理学科普…，豆瓣6.3，拿不准",
               "author": "[澳]埃玛·爱德华兹", "date": "2025-7-1", "intro": "你是否总在月底对着账单懊悔?…",
               "douban": "6.3" } ] }
```
- `mark`：`pending`（未决策）/ `approve` / `reject`
- 豆瓣 `0.0` 与空值都按"无评分"处理（不返回 `douban` 字段，与索引器一致）
- `scriptAvailable=false`：管道脚本缺失（决策不可用，界面只读提示）
- `readable=false`：文件缺失/读不出/**内容不完整**（缺 `^##` 章节标记，例如 sync 被中途杀掉）——此时 `ok=false`，界面只读报错而**不是**"暂无待确认"
- `syncOk=false`：本次同步失败（界面提示"显示的可能是过期数据"）
- `syncSkipped=true`：请求了刷新但**有任务在执行中**，为安全起见跳过（同步会抓详情并重写 `post_details.json`，必须与下载/元数据任务互斥）；界面会提示"本次未刷新清单"
- `maxDownload`：后端一键下载的单次上限（当前 30），界面据此拦截超限的立即下载
- `fileBytes` / `archive`：清单体积与**历史归档**状态（管道只保留最近 200 条已处理，EBM 会把旧记录按月归档到 `data/reco-archive/`，界面据此显示量级与阈值提示）
- `itemsInLibrary`：候选里**书已在书库**的（按书名归一化与书库比对；避免"未经批准直接下载后还反复要求确认"）
- `queuedInLibrary`：**书已在书库**（按书名归一化与书库比对；手动下载不写 `state.downloads`，靠它避免"明明下过还挂在队列里"）
- `queued`：**已确认待下载**队列（批准后、次日巡检下载前）。它由 `tiers.json`(tier=1) + `state.json`(排除 downloads/unavailable) 推导，界面里可直接「立即下载」

### `POST /api/recommend/decide`
`{ "approve": [23415], "reject": [23408] }` → 翻转清单勾选 → 调 `recommend.py apply`
- 响应 `{ ok, approved, rejected, log, remaining: [ …同 pending 结构… ] }`（`log` 是管道脚本输出）
- **`409`**：已有任务在执行中（与下载/元数据任务共用互斥锁，避免并发写 `tiers.json`）
- **`502`**：未找到管道 `recommend.py`
- **`400`**：没有任何决策 / 同一本既批准又拒绝 / 单次超过 100 本 / **id 已不在待确认清单里**（防"幽灵提交"）

### 一键下载（既有接口，配合使用）
`POST /api/pipeline/download { "ids": [...] }` —— 界面上的「确认并立即下载」= decide(approve) 成功后立刻调用它（**单次上限 30 本**，由 `maxDownload` 告知前端）。

### `GET /api/push/status`
探测局域网阅读器是否在线（讯飞起点阅读器：设备只在「传书」页面打开时监听）。
- 响应 `{ target, reachable, fileSizeLimit?, ms, error? }`；`fileSizeLimit` 为 pdf/mobi/azw3 单文件上限（MB）

### `POST /api/push/send`
把书库里的书推送到阅读器。
- 请求 `{ "rel": "心理学/《某书》某人.pdf" }`
- 响应 `{ ok, target, bytes, ms, message?, error? }`；`message` 通常是设备返回的"上传成功"
- 实现：multipart 字段 **`sfile`** 推送到 `POST <target>/upload`；iCloud 云端书先取回（最多等 60s，未完成返回 **202** + `pendingMaterialize: true`）
- 错误：设备离线/地址不对 → **502**（提示"请先在阅读器上打开「传书」页面"）· 超过设备上限 → 502 并说明 · 文件不存在 → 404 · 路径非法 → 403

### `GET /api/reco/detail?id=<帖 id>`
推荐条目的**完整详情**（列表接口只有书名/目录/评分）。
- 响应 `{ ok, id, title, author, author_bio, intro, toc, tags, publisher, year, pages, translator, douban }`
- 数据来自 `post_details.json`；**不在缓存时现场抓取**（`fetch_details.py`，与服务内其它抓取共用串行队列）
- `400` id 非法 · `502` 缓存没有且抓取失败/脚本不可用
- 豆瓣 `0.0`（"抓不到评分"哨兵值）按无评分返回

### `POST /api/reco/restore`
把误判「不要了」的书恢复为**待定**（tier=2）。
- 请求 `{ "ids": [23415] }`（单次最多 50 本）
- 响应 `{ ok, restored: [{id, folder, note, fromSnapshot}], skipped: [{id, reason}], backup }`
- **EBM 唯一写 `tiers.json` 的路径**：只改指定 id 的 tier/folder/note，优先用"拒绝前的快照"还原原目录与理由；**原子写 + 写入 `data/tiers-backup/`（保留最近 5 份）**；与下载/元数据任务共用互斥锁
- `400` 没有可恢复条目（非拒绝状态 / 记录不存在）· `409` 有任务在执行中

### `GET /api/reco/restore/status`
`{ snapshots: 3, history: [{id,action,at,detail}], backupDir }` —— 有多少条可精确还原、最近操作、备份位置。

### `GET /api/reco/archive`
查看**已归档的决策历史**（主清单只保留最近 200 条已处理，旧的由 EBM 按月归档到 `data/reco-archive/`）。
- 查询参数：`month`（`all` 或 `YYYY-MM`）· `q`（书名/ID/理由关键词）· `limit`（默认 200，上限 1000）
- 响应 `{ months: [{month,count}], items: [{date,action,id,title,folder,note,month}], total, matched, truncated }`
- `action`：`approve`（已批，原 `[x]`）/ `reject`（不要了，原 `[-]`）；排序为日期新→旧
- 只读接口，不会改动任何数据

### `GET /api/recommendations`（legacy：界面已不再单独展示，但「推荐浏览」折叠区在用）

返回 tier2+3 的原始条目（含已拒绝/已淘汰），保留给程序化调用；**界面已改为只展示真正的待确认清单**（`/api/recommend/pending`）。

## 推荐清单与一键下载

### `GET /api/recommendations`
读取管道 `tiers.json` + `post_details.json`。
```json
{ "max": 30, "running": false, "items": [ { "id": 3709, "tier": 2, "title": "…", "author": "…",
  "douban": "8.9", "folder": "社会&历史", "note": "…", "intro": "…", "downloaded": false } ] }
```
管道数据缺失 → `500` + `{ "error": "…" }`（服务不崩）

### `POST /api/pipeline/download`
请求体 `{ "ids": [3709, 3710] }`
- **流式响应**（`text/plain` 分块），前端在弹层里实时展示日志
- `409` 已有任务在执行（全局互斥）· `400` 请求体非法 / 未选书 / 超过单次上限 30 本

---

## OPDS 1.2（供 Kybook / Chunky 等客户端）

| 路径 | 说明 |
|---|---|
| `GET /opds` | 导航 feed：全部分类 + 搜索入口 |
| `GET /opds/category/:name` | 某分类的 acquisition feed（`_all` 表示全部） |
| `GET /opds/search?q=` | 搜索结果 feed |
| `GET /opds/opensearch.xml` | OpenSearch 描述文档 |

- Content-Type：导航 `application/atom+xml;profile=opds-catalog;kind=navigation`，书目 `…;kind=acquisition`
- 条目含 `<link rel="http://opds-spec.org/acquisition">`；**仅本地书**附 `rel="http://opds-spec.org/image"` 封面链接（防客户端批量拉图触发取回）
- 分类不存在 → `404`

---

## 静态页面

| 路径 | 说明 |
|---|---|
| `GET /` | 书库页（`src/web/index.html`） |
| `GET /read` | 阅读页（`src/web/read.html`） |
| `GET /app.js` `/read.js` `/style.css` `/vendor/*` | 前端资源；**壳文件带 `Cache-Control: no-cache`**，vendor 允许缓存 |

---

## 错误约定

| 状态码 | 含义 |
|---|---|
| `400` | 参数非法（JSON 解析失败、字段类型/取值错误） |
| `403` | 路径非法（穿越或不在书库根内） |
| `404` | 资源不存在（文件/书/分类/封面不可用） |
| `409` | 冲突（下载任务已在执行） |
| `202` | 已接受：iCloud 取回中，稍后重试 |
| `416` | Range 越界 |
| `429` | 公网入口限速（仅匿名请求；带 Basic Auth 不受限） |
| `500` | 服务端异常（如管道数据缺失，已结构化返回，不会崩服务） |
