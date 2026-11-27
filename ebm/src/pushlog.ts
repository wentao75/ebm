// pushlog.ts —— 推送历史（解决「不记得这本书传过没有」）
//
// 每次推送成功后在 data/push-log.json 追加一条；书详情页据此显示
// 「已推送 N 次 · 设备上是 [号码]书名.pdf」，推送前查重也能给出提示。
// 只记文件名与设备侧收到的名字，不记书内容；保留最近 1000 条，原子写。
import fsp from "fs/promises";
import path from "path";
import { DATA_DIR } from "./paths";

/** 日志文件路径（跟随 EBM_DATA_DIR，测试用临时目录互不串） */
function logFile(): string {
  return path.join(DATA_DIR, "push-log.json");
}

/** 单条推送记录 */
export interface PushLogEntry {
  /** 本地文件名（不含目录，如 《书名》作者.pdf） */
  name: string;
  /** 设备实际保存的文件名（带 [号码] 前缀，上传后回读设备清单得到） */
  deviceName?: string;
  /** 本次发送字节数 */
  bytes: number;
  /** 推送时间（epoch ms） */
  at: number;
  /** 设备是否回报成功 */
  ok: boolean;
}

/** 最多保留条数：够回溯，又不至于无界增长 */
const MAX_ENTRIES = 1000;

/** 读取全部记录；文件不存在或损坏时当作空历史，绝不抛错 */
export async function readPushLog(): Promise<PushLogEntry[]> {
  try {
    const raw = await fsp.readFile(logFile(), "utf-8");
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is PushLogEntry => !!e && typeof (e as PushLogEntry).name === "string");
  } catch {
    return [];
  }
}

/** 追加一条记录（临时文件 + rename 原子写；写失败静默，不影响推送本身） */
export async function appendPushLog(entry: PushLogEntry): Promise<void> {
  try {
    const all = await readPushLog();
    all.push(entry);
    const file = logFile();
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(all.slice(-MAX_ENTRIES), null, 2), "utf-8");
    await fsp.rename(tmp, file);
  } catch {
    /* 日志是辅助信息：写不进去也不该让推送失败 */
  }
}
