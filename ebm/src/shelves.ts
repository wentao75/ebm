// shelves.ts —— 书架（在读/喜欢/读完）与阅读进度持久化
// 设计要点（长期稳定性优先）：
//   1. 单文件 JSON，内存态为准 + 去抖落盘，避免频繁写盘
//   2. tmp + rename 原子写：进程被杀不会留下半截文件
//   3. 损坏文件自动隔离为 shelves.json.corrupt-<ts>，服务照常起来，绝不因数据问题停摆
//   4. 写盘失败只记录日志，不影响请求响应与服务存活
//   5. 空记录自动回收，防止长年使用后文件无界膨胀
import fsp from "fs/promises";
import path from "path";

export type ShelfName = "reading" | "fav" | "done";
export const SHELF_NAMES: readonly ShelfName[] = ["reading", "fav", "done"];
export const MAX_REL_LEN = 512;
export const MAX_PAGE = 100000;
const DEBOUNCE_MS = 300;

export interface ShelfRecord {
  /** 正在读 */
  reading?: boolean;
  /** 喜欢（待读） */
  fav?: boolean;
  /** 已读完 */
  done?: boolean;
  /** 上次读到第几页（1 起） */
  page?: number;
  /** 最近一次操作时间，用于"在读"倒序 */
  ts: number;
}

export interface ShelvesSnapshot {
  updated: number;
  items: Record<string, ShelfRecord>;
}

export function isShelfName(v: unknown): v is ShelfName {
  return typeof v === "string" && (SHELF_NAMES as readonly string[]).includes(v);
}

export function validRel(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_REL_LEN;
}

/** 规范化页码：非数字返回 null；合法则收敛到 [1, MAX_PAGE] */
export function normPage(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(n)));
}

/** 过滤掉形状非法的记录（手改文件、旧版本残留都不至于让服务出错） */
function sanitize(input: unknown): Record<string, ShelfRecord> {
  const out: Record<string, ShelfRecord> = {};
  if (!input || typeof input !== "object") return out;
  for (const [rel, rec] of Object.entries(input as Record<string, unknown>)) {
    if (!validRel(rel) || !rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const item: ShelfRecord = { ts: typeof r.ts === "number" && r.ts > 0 ? r.ts : Date.now() };
    if (r.reading === true) item.reading = true;
    if (r.fav === true) item.fav = true;
    if (r.done === true) item.done = true;
    const page = normPage(r.page);
    if (page != null && r.page != null) item.page = page;
    if (item.reading || item.fav || item.done || item.page != null) out[rel] = item;
  }
  return out;
}

export class ShelfStore {
  private items: Record<string, ShelfRecord> = {};
  private updatedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly dir: string;
  private readonly file: string;

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir || process.env.EBM_DATA_DIR || path.resolve(__dirname, "..", "data");
    this.file = path.join(this.dir, "shelves.json");
  }

  get filePath(): string {
    return this.file;
  }

  /** 读取持久化数据；文件缺失视为空，损坏则隔离后从空开始 */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[ebm] 书架文件读取失败（按空处理）:", err);
      }
      return;
    }
    try {
      const data = JSON.parse(raw) as ShelvesSnapshot;
      this.items = sanitize(data?.items);
      this.updatedAt = typeof data?.updated === "number" ? data.updated : 0;
      const n = Object.keys(this.items).length;
      if (n) console.log(`[ebm] 书架已载入：${n} 条记录`);
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this.file, backup);
        console.error(`[ebm] 书架文件损坏，已隔离为 ${backup}:`, err);
      } catch (renameErr) {
        console.error("[ebm] 书架文件损坏且隔离失败:", renameErr);
      }
      this.items = {};
      this.updatedAt = 0;
    }
  }

  snapshot(): ShelvesSnapshot {
    return { updated: this.updatedAt, items: JSON.parse(JSON.stringify(this.items)) as Record<string, ShelfRecord> };
  }

  get(rel: string): ShelfRecord | undefined {
    return this.items[rel];
  }

  count(): number {
    return Object.keys(this.items).length;
  }

  /** 切换书架归属；标"读完"时自动移出"在读" */
  set(rel: string, shelf: ShelfName, value: boolean): ShelfRecord | null {
    const rec: ShelfRecord = { ...(this.items[rel] || { ts: Date.now() }) };
    if (value) rec[shelf] = true;
    else delete rec[shelf];
    if (shelf === "done" && value) delete rec.reading;
    rec.ts = Date.now();
    return this.put(rel, rec);
  }

  /** 记录阅读进度 */
  setProgress(rel: string, page: number): ShelfRecord | null {
    const rec: ShelfRecord = { ...(this.items[rel] || { ts: Date.now() }) };
    rec.page = normPage(page) ?? 1;
    rec.ts = Date.now();
    return this.put(rel, rec);
  }

  /** 重命名文件后迁移记录（书架 + 阅读进度一并搬过去） */
  migrate(oldRel: string, newRel: string): boolean {
    if (oldRel === newRel) return false;
    const rec = this.items[oldRel];
    if (!rec) return false;
    if (this.items[newRel]) {
      // 目标已有记录：合并（布尔取或，进度取较大值），避免丢数据
      const target = this.items[newRel];
      target.reading = target.reading || rec.reading;
      target.fav = target.fav || rec.fav;
      target.done = target.done || rec.done;
      if (rec.page && (!target.page || rec.page > target.page)) target.page = rec.page;
      target.ts = Math.max(target.ts || 0, rec.ts || 0);
    } else {
      this.items[newRel] = rec;
    }
    delete this.items[oldRel];
    this.updatedAt = Date.now();
    this.scheduleFlush();
    return true;
  }

  clear(rel: string): void {
    delete this.items[rel];
    this.updatedAt = Date.now();
    this.scheduleFlush();
  }

  /** 空记录（无任何标记且无进度）自动回收，防止文件无界增长 */
  private put(rel: string, rec: ShelfRecord): ShelfRecord | null {
    if (rec.reading || rec.fav || rec.done || rec.page != null) {
      this.items[rel] = rec;
      this.updatedAt = Date.now();
      this.scheduleFlush();
      return rec;
    }
    delete this.items[rel];
    this.updatedAt = Date.now();
    this.scheduleFlush();
    return null;
  }

  scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** 立即落盘（等待去抖窗口内的写入；进程退出前调用可保证不丢最后几次操作） */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const payload = JSON.stringify({ version: 1, updated: this.updatedAt, items: this.items }, null, 0);
    this.chain = this.chain.then(async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fsp.writeFile(tmp, payload, "utf-8");
        await fsp.rename(tmp, this.file);
      } catch (err) {
        console.error("[ebm] 书架写入失败（内存态继续可用，下次重试）:", err);
      }
    });
    return this.chain;
  }
}
