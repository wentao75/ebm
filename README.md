# EBM · 家庭电子书管理器

把 iCloud Drive（或任意本地目录）里的电子书库，变成一个**可搜索、可在线阅读、可订阅 OPDS** 的自建服务。
零前端框架（原生 TypeScript + 浏览器原生渲染）、单进程 Node 服务，适合跑在家里的一台常开 Mac/小主机上。

> 应用代码位于 [`ebm/`](ebm/README.md)，设计与变更记录见 [`docs/`](docs/)。

## 功能

| 功能 | 说明 |
|---|---|
| 书库索引与搜索 | 递归扫描书库目录（目录名即分类），解析 `《书名》作者.ext` 命名，支持中文分词搜索、分类/书架筛选、排序 |
| 在线阅读 | 内置 PDF.js 与 epub.js 阅读器（`pdf.js 3.32.2` / `epub.js`，见 [第三方声明](THIRD_PARTY_NOTICES.md)） |
| 书目元数据 | 简介/作者/出版社/译者/页数/豆瓣评分/标签/目录；多源自动补全（豆瓣 → OpenLibrary → Google Books → arXiv），支持人工编辑覆盖 |
| 书架与批注 | 喜欢/想读/在读/已读等书架状态，本地持久化 |
| 重命名与清理 | 按规则清理下载站标记（`【文字版_PDF电子书_…】`）、书名/文件名分离编辑、改名历史与回滚 |
| OPDS 目录 | 供 KyBook/Thorium 等阅读器订阅浏览与下载 |
| 可选：推荐/下载联动 | 与外部脚本管道对接（推荐清单、待确认决策、一键下载、历史归档）——**该管道不在本仓库内**，缺失时相关功能自动隐藏 |
| 手机可用 | 响应式布局，局域网/Tailscale/反代均可访问 |

## 快速开始

```bash
# 依赖：Node.js 20+（开发使用 24.x）
cd ebm
npm install
npm run build
npm start          # 默认监听 0.0.0.0:6722
```

打开 `http://localhost:6722`。

### 环境变量（全部可选）

| 变量 | 默认值 | 用途 |
|---|---|---|
| `EBM_LIBRARY_ROOT` | `~/Library/Mobile Documents/com~apple~CloudDocs/eBooks` | 书库根目录（一级目录即分类） |
| `EBM_WATCH_DIR` | 仓库根下的 `yabook_watch/` | 可选管道数据目录（推荐清单、帖子详情、下载脚本） |
| `EBM_DATA_DIR` | `ebm/data/` | 应用数据（书架、人工覆盖、归档、快照） |
| `EBM_PORT` / `EBM_HOST` | `6722` / `0.0.0.0` | 监听端口与地址 |
| `EBM_PUBLIC_BASE` | 空 | 反代/公网部署时的对外地址（用于 OPDS 链接） |
| `YABOOK_RECFILE` | 书库根下 `_推荐待确认.md` | 推荐清单文件路径 |

## 开发与验证

```bash
npm run build      # TypeScript 编译（服务端 + 前端）
npm test           # 构建 + 单元/接口测试（node --test）
npm run test:ui    # 无头 Chrome 端到端 UI 检查（几何/遮挡/像素级断言）
npm run dev        # 构建并前台运行
```

`npm test` 使用临时目录与真实脚本副本，**不会触碰你的真实书库数据**；`npm run test:ui` 会自动拉起隔离实例。

## 与下载管道的关系（可选）

原本的个人部署里，另有一组 Python 脚本（对某书籍站点做推荐分级、下载、归档）。
考虑到目标站点的服务条款与版权因素，**这组脚本不包含在本仓库内**；缺少它时，EBM 仍是一个完整的本地书库管理器（索引/搜索/阅读/OPDS/元数据），
仅"推荐清单""一键下载"等联动入口会自动隐藏。接入方式见 [`docs/metadata-enrichment.md`](docs/metadata-enrichment.md) 与 [`ebm/README.md`](ebm/README.md)。

## 文档

- [应用说明](ebm/README.md) — 功能、API、数据文件、部署结构
- [接口文档](docs/api.md) · [设计方案](docs/ebook-manager-design.md) · [元数据补全](docs/metadata-enrichment.md)
- [变更记录](docs/CHANGELOG.md) · [工程经验](docs/LESSONS.md)

## 许可

本项目以 **MIT License** 发布，见 [LICENSE](LICENSE)。随仓库分发的第三方库（PDF.js / epub.js）遵循各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
