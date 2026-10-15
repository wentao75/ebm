# ebm · 家庭电子书管理器

自建的轻量电子书库服务：把 iCloud Drive 里的书库变成**可搜索、可在线读、可订阅 OPDS、可一键下载新书**的家庭应用。
服务本体跑在 Mac（<mac-host>），ECS 只做公网反代入口。

- 当前书库：**1100 本**；**简介覆盖 795 本（72%）**（五层外部源补全，见 [metadata-enrichment](../docs/metadata-enrichment.md)）
- 访问方式：局域网 `http://<Mac-IP>:6722` · Tailscale `http://<tailscale-ip>:6722` · 公网 `https://ebm.example.com`（Basic Auth）
- 阅读器版本：**v2.5** · 应用版本：**v1.5**（详见 [CHANGELOG](../docs/CHANGELOG.md)）

## 功能一览

| 功能 | 说明 |
|---|---|
| 搜索与浏览 | 书名/作者/分类/标签/简介/豆瓣分；首屏 120 张，**滚到底自动加载**（无限滚动） |
| 我的书架 | 在读 / 喜欢 / 读完（服务端存储，多设备共享）；分类与书架叠加筛选 |
| 阅读记忆 | 记住上次的 tab/书架/分类；**续读**自动跳回上次页码；阅读习惯（缩放/模式）按设备记忆 |
| 在线阅读 | PDF（虚拟化渲染，内存恒定 ~30MB）· EPUB · TXT；缩放档位、单页翻页、目录、续读 |
| 图书详情 | 点击卡片查看完整简介（不截断）、目录、出版社/译者/页数/豆瓣、标签、路径 |
| 下载 | 本地书直下；**云端书自动先取回再下载**（202 + 探针轮询） |
| 封面 | PDF 渲首页 / EPUB 解内嵌图；缓存于 `covers/`；云端书不生成（策略 A 红线） |
| OPDS 1.2 | `/opds` 根/分类/搜索 + OpenSearch，供 Kybook 等客户端订阅 |
| 新书速递 | 按 mtime 倒序的最新 60 本 |
| 待下载确认 | 「待下载确认」Tab：列出每日巡检的 T2 待定书（书名/建议归档/判断理由/简介/豆瓣），单条或批量「确认下载 / 不要了」；工具条 **☑ 立即下载**（记忆偏好）勾选后按钮变「确认并下载」，批准的同时立即下载，不再逐次确认。决策由管道 `recommend.py apply` 落盘（批准→tier1、拒绝→tier3），与本地 Markdown 勾选互通；面板顶部另有「已确认待下载」队列（tier1 未下载），可单本/全部立即下载；Tab 内还有两个折叠区：**📚 推荐浏览**（tier2/3 原始清单+筛选+直接下载，点书名/整行展开完整简介与目录）与 **📜 历史决策**（归档记录，可按月/关键词搜索）；已拒绝的可「恢复为待定」撤销（带拒绝前快照与自动备份） |
| 推荐清单一键下载（legacy API） | `POST /api/pipeline/download` 仍可用（界面「确认并立即下载」走它），但界面已不再单独展示 tier2+3 混合清单 |
| 元数据补全 | 顶栏「🗂 元数据」：登记新书/补简介/重建索引/一键全流程（流式日志）；新书未补简介时书库顶部提示条，一键补全 |
| 书名/文件名编辑 | 详情页「✏ 编辑」：改书名（不动物理文件）、改文件名（带清理建议预览）、改元数据；勾选"同时重命名文件"可一起改；改名会迁移书架/进度/覆盖并用别名保住管道元数据，可一键撤销 |
| 待补清单 + 人工覆盖 | 面板内列出缺信息的书及原因（差一点命中/无候选/…）；对"豆瓣有同书候选但分数不足"的书可**查候选 → 人工确认采纳**，或手动填写；存 `data/meta_overrides.json`，**优先级最高**，可撤销 |

## 架构

```
   iPad / 手机 / 浏览器                     公网
        │                                   │
        │ 局域网 / Tailscale                │ https://ebm.example.com + Basic Auth
        ▼                                   ▼
   ┌────────────────────┐            ┌──────────────────────┐
   │  Mac (<mac-host>)      │◀──Tailscale─│  ECS (<ecs-host>)        │
   │  ebm:6722          │  反代       │  nginx 1.24 + 限速    │
   │  launchd 常驻      │            └──────────────────────┘
   └─────────┬──────────┘
             │ 读取（按需取回，绝不批量下载）
             ▼
   iCloud Drive/…/eBooks  ◀── 归档 ── yabook_watch（自动下载管道）
```

**核心约束（策略 A）**：iCloud 里多数书是"仅云端"占位文件，服务**绝不批量下载**——只有你真正打开/下载某一本时，才用 `brctl download` 取回那一本。

## 快速上手

```bash
cd ebm
npm run build            # TypeScript 编译（后端 → dist/，前端 → src/web/*.js）
npm test                 # 构建 + 26 项：存储层单元测试 + HTTP 契约/稳定性测试
npm run test:ui          # 浏览器验收（当前 140 项：像素/几何/交互，无头 Chrome + 隔离实例，不碰真实数据）
launchctl kickstart -k gui/$(id -u)/com.ebm.server   # 重启线上服务（先 build）
tail -f logs/ebm.log     # 看服务日志
```

> 测试用临时书库 + 临时数据目录 + 独立端口，`EBM_EAGER_COVERS=0`，**不会触碰真实书库与 yabook_watch**。

## 目录结构

```
ebm/
├── src/
│   ├── server.ts        # Hono 入口 + 全部路由
│   ├── scanner.ts       # 目录扫描 + fs.watch 增量刷新（含 dataless 标记）
│   ├── indexer.ts       # 文件名解析 + 管道元数据 join（含实体解码、标记归一化）
│   ├── materialize.ts   # iCloud dataless 按需取回协调器（策略 A）
│   ├── covers.ts        # 封面生成与缓存（sips / EPUB 内嵌图）
│   ├── shelves.ts       # 书架与阅读进度持久化（原子写 + 去抖 + 损坏隔离）
│   ├── opds.ts          # OPDS 1.2 feed
│   ├── recommend.ts     # 待下载确认：解析/翻转 _推荐待确认.md + 调 recommend.py apply
│   ├── pipeline.ts      # 一键下载：subprocess 调雅书管道
│   ├── metadata.ts      # 书目元数据：状态/待补清单/候选查询/采纳 + 触发 build/enrich/catalog
│   ├── overrides.ts     # 人工元数据覆盖（优先级最高，独立于管道数据）
│   ├── rename.ts        # 文件名清理规则 + 安全重命名 + 路径别名 + 重命名日志
│   ├── jobs.ts          # 全局任务互斥锁（下载与元数据串行）
│   └── web/             # 原生 TS 前端（无框架）
│       ├── index.html   # 书库页：侧栏书架/分类 + 三视图 + 详情弹层
│       ├── read.html    # 阅读页：缩放工具条 + 目录抽屉 + 单页模式
│       ├── app.ts / read.ts / style.css
│       └── vendor/      # 本地打包 pdf.js + epub.js（内网不依赖 CDN）
├── test/                # node --test：helper / shelves.test.js / api.test.js
├── scripts/
│   ├── ui-check.mjs     # 浏览器端验收（隔离实例 + 像素检查）
│   └── revert-rename.py # 文件名清理回滚
├── data/                # shelves.json、rename-map-*.json（gitignore）
├── covers/              # 封面缓存（gitignore）
├── logs/                # launchd 输出（gitignore）
├── docs/                # 界面截图（验收留档）
└── deploy/              # launchd plist / ECS nginx 配置 / DEPLOY.md
```

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `EBM_PORT` | `6722` | 监听端口 |
| `EBM_HOST` | `0.0.0.0` | 监听地址（局域网 + Tailscale 双通） |
| `EBM_LIBRARY_ROOT` | iCloud `…/eBooks` | 书库根目录（测试时指向临时目录） |
| `EBM_DATA_DIR` | `ebm/data` | 书架数据目录 |
| `EBM_WATCH_DIR` | `…/yabook_watch` | 管道元数据目录（post_details.json/state.json） |
| `EBM_EAGER_COVERS` | 未设 | 设为 `0` 则跳过启动时的批量封面生成（测试用） |

## 数据与产物

| 路径 | 说明 |
|---|---|
| `data/shelves.json` | 书架 + 阅读进度（服务端权威数据） |
| `data/meta_overrides.json` | 人工确认的图书元数据（优先级最高，可撤销） |
| `data/path-aliases.json` | 改名别名链（new→old，用于改名后仍能查到管道元数据） |
| `data/reco-restore.json` / `data/tiers-backup/` | 「恢复为待定」的拒绝前快照 与 tiers.json 自动备份（EBM 唯一写 tiers.json 的路径） |
| `data/reco-archive/reco-archive-YYYY-MM.md` | 推荐决策历史归档（按月分片，主清单只保留最近 200 条） |
| `data/rename-map-manual.json` | 界面重命名日志（兼容 `scripts/revert-rename.py` 回滚） |
| `data/rename-map-*.json` | 文件名清理的 old→new 映射（410 条，可回滚） |
| `data/shelves.json.test-backup-*` | 一次性测试数据备份 |
| `.snapshot-2026-10-01/` | v1.5 变更前的源码快照（本仓库非 git，唯一回滚保险） |
| `covers/` | 封面缓存（key = rel\|mtime） |
| `docs/*.png` | 各功能界面实拍（卡片布局、详情、目录、侧栏修复等） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [设计文档](../docs/ebook-manager-design.md) | 需求、决策记录（Q1–Q11 与 v1.2–v1.5 各条）、架构、风险 |
| [变更记录](../docs/CHANGELOG.md) | 每个版本做了什么、如何验证、出过什么事故 |
| [运维手册](../docs/RUNBOOK.md) | 服务/数据/ECS 操作、故障排查、回滚手册 |
| [经验教训](../docs/LESSONS.md) | 踩过的坑与工程约定（写代码前值得一读） |
| [接口参考](../docs/api.md) | 全部 HTTP 接口与 OPDS 端点 |
| [部署手册](deploy/DEPLOY.md) | Mac launchd、ECS nginx、证书、密码、限速 |

## 红线（改代码前必读）

1. **不要批量取回 iCloud 文件**：只在用户打开/下载单本时取回；封面、书架、目录等任何自动行为都不得触发取回
2. **不要引入"改了没生效"**：应用壳文件必须带 `Cache-Control: no-cache`，脚本引用带版本号
3. **改前端后必须跑 `npm run test:ui`**：它包含像素级断言（防白屏回归）与几何断言（防布局变形）
4. **数据文件必须先备份再批量改**：`data/shelves.json` 与书名批量重命名都要有映射/备份与回滚脚本
5. **人工覆盖优先于一切**：`data/meta_overrides.json` 的值会覆盖文件名解析与管道补全（这是"人工确认"的语义），改动后立即重建索引生效
6. **重命名只做 `rename`、绝不读文件内容**：iCloud 只读占位文件也能安全改名；扩展名一律沿用原文件；改名必须同时迁移书架/进度/覆盖并记录别名，否则会丢元数据
7. **元数据任务不可并发**：`meta_build.py`/`meta_enrich.py` 都是"读整份 → 改 → 整份写回"，两个同时跑会互相覆盖 `book_meta.json`；ebm 已用全局锁 + 外部进程检测（409）拦这件事，手动在终端跑之前也要先 `pgrep -f meta_enrich.py` 确认
