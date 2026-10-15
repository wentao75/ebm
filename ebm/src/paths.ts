// paths.ts —— 运行路径的唯一来源（env 优先，默认值不含任何个人信息）
//
// 之前 6 个模块各自写死了同一个绝对路径，且带上了开发者本机的用户名；
// 对外发布时这类信息不该出现，重复的默认值也容易改漏。统一到这里：
//   - 环境变量优先（部署时用 EBM_* 覆盖）
//   - 默认值用「相对本仓库」与 `os.homedir()` 推导，因此在原开发机上解析结果完全一致
import os from "os";
import path from "path";

/**
 * 可选集成的管道数据目录（yabook_watch：推荐清单/详情/下载脚本）。
 * 默认取仓库根下的同名目录；不存在时相关功能自动降级，不影响书库管理本身。
 */
export const WATCH_DIR =
  process.env.EBM_WATCH_DIR || path.resolve(__dirname, "..", "..", "yabook_watch");

/** iCloud 书库根目录（目录名即分类） */
export const LIBRARY_ROOT =
  process.env.EBM_LIBRARY_ROOT ||
  path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/eBooks");

/** 应用自身数据目录（书架、人工覆盖、归档、恢复快照等） */
export const DATA_DIR = process.env.EBM_DATA_DIR || path.resolve(__dirname, "..", "data");

/**
 * 待确认清单文件（由管道 recommend.py 维护，放在 iCloud 根目录便于手机端勾选）。
 * 保留历史环境变量名 YABOOK_RECFILE（管道与测试都用它）。
 */
export const REC_FILE =
  process.env.YABOOK_RECFILE || process.env.EBM_RECO_FILE || path.join(LIBRARY_ROOT, "_推荐待确认.md");
