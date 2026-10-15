// overrides.ts —— 人工元数据覆盖（ebm 自己的数据，绝不写管道文件）
//
// 背景：管道侧按"宁可不补也不错"的匹配策略，会把一些**其实就是同一本**但标题有差异的候选
// 拒掉（实测 17 本：如《安全边际》→豆瓣候选"安全边际" 83 分、《接话破冰》86 分）。
// 这里提供一条人工确认通路：把确认后的元数据存在 ebm 自己的文件里，索引器以**最高优先级**合并，
// 管道文件（book_meta.json / post_details.json）保持只读、零改动。
import fsp from "fs/promises";
import path from "path";

export interface MetaOverride {
  title?: string;
  author?: string;
  intro?: string;
  publisher?: string;
  year?: string;
  pages?: string;
  translator?: string;
  douban?: string;
  isbn?: string;
  author_bio?: string;
  toc?: string;
  tags?: string[];
  /** 来源：manual（手工填写）/ douban-adopt（采纳豆瓣候选） */
  source?: string;
  /** 备注：候选标题、匹配分等溯源信息 */
  note?: string;
  at?: number;
}

export interface OverridesFile {
  version: number;
  updated: number;
  items: Record<string, MetaOverride>;
}

const MAX_TEXT = 6000;
type TextField = "title" | "author" | "intro" | "publisher" | "year" | "pages"
  | "translator" | "douban" | "isbn" | "author_bio" | "toc" | "source" | "note";
const TEXT_FIELDS: TextField[] = [
  "title", "author", "intro", "publisher", "year", "pages", "translator",
  "douban", "isbn", "author_bio", "toc", "source", "note",
];

/** 字段白名单 + 长度收敛：只有这些字段能被人工覆盖写入 */
export function sanitizeOverride(input: unknown): MetaOverride | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const out: MetaOverride = {};
  const textOut = out as Record<string, string>;
  for (const f of TEXT_FIELDS) {
    const v = raw[f];
    if (typeof v === "string" && v.trim()) textOut[f] = v.trim().slice(0, MAX_TEXT);
  }
  const tags = raw.tags;
  if (Array.isArray(tags)) {
    const clean = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    if (clean.length) out.tags = clean;
  } else if (typeof tags === "string" && tags.trim()) {
    out.tags = tags.split(/[,，、]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
  }
  out.at = Date.now();
  return Object.keys(out).length > 1 ? out : null;
}

export class OverrideStore {
  private items: Record<string, MetaOverride> = {};
  private updatedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly dir: string;
  private readonly file: string;

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir || process.env.EBM_DATA_DIR || path.resolve(__dirname, "..", "data");
    this.file = path.join(this.dir, "meta_overrides.json");
  }

  get filePath(): string {
    return this.file;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, "utf-8");
    } catch {
      return; // 不存在即空
    }
    try {
      const data = JSON.parse(raw) as OverridesFile;
      this.items = this.sanitizeAll(data?.items);
      this.updatedAt = typeof data?.updated === "number" ? data.updated : 0;
      const n = Object.keys(this.items).length;
      if (n) console.log(`[ebm] 人工元数据覆盖已载入：${n} 条`);
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this.file, backup);
        console.error(`[ebm] 覆盖文件损坏，已隔离为 ${backup}:`, err);
      } catch {
        /* ignore */
      }
      this.items = {};
    }
  }

  private sanitizeAll(input: unknown): Record<string, MetaOverride> {
    const out: Record<string, MetaOverride> = {};
    if (!input || typeof input !== "object") return out;
    for (const [rel, v] of Object.entries(input as Record<string, unknown>)) {
      if (!rel || typeof rel !== "string") continue;
      const clean = sanitizeOverride(v);
      if (clean) out[rel] = clean;
    }
    return out;
  }

  get(rel: string): MetaOverride | undefined {
    return this.items[rel];
  }

  count(): number {
    return Object.keys(this.items).length;
  }

  snapshot(): { updated: number; items: Record<string, MetaOverride> } {
    return { updated: this.updatedAt, items: JSON.parse(JSON.stringify(this.items)) as Record<string, MetaOverride> };
  }

  set(rel: string, patch: MetaOverride): MetaOverride {
    const merged: MetaOverride = { ...(this.items[rel] || {}), ...patch };
    this.items[rel] = merged;
    this.updatedAt = Date.now();
    this.scheduleFlush();
    return merged;
  }

  /** 重命名文件后迁移人工覆盖 */
  migrate(oldRel: string, newRel: string): boolean {
    if (oldRel === newRel) return false;
    const rec = this.items[oldRel];
    if (!rec) return false;
    this.items[newRel] = { ...(this.items[newRel] || {}), ...rec };
    delete this.items[oldRel];
    this.updatedAt = Date.now();
    this.scheduleFlush();
    return true;
  }

  /** 清除指定字段（让索引回落到管道/文件名数据）；条目变空则整条删除 */
  clearFields(rel: string, fields: string[]): MetaOverride | null {
    const cur = this.items[rel];
    if (!cur) return null;
    for (const f of fields) delete (cur as Record<string, unknown>)[f];
    if (Object.keys(cur).filter((k) => k !== "at").length === 0) {
      delete this.items[rel];
      this.updatedAt = Date.now();
      this.scheduleFlush();
      return null;
    }
    this.updatedAt = Date.now();
    this.scheduleFlush();
    return cur;
  }

  remove(rel: string): boolean {
    if (!(rel in this.items)) return false;
    delete this.items[rel];
    this.updatedAt = Date.now();
    this.scheduleFlush();
    return true;
  }

  scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, 300);
    this.timer.unref?.();
  }

  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const payload = JSON.stringify({ version: 1, updated: this.updatedAt, items: this.items }, null, 1);
    this.chain = this.chain.then(async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fsp.writeFile(tmp, payload, "utf-8");
        await fsp.rename(tmp, this.file);
      } catch (err) {
        console.error("[ebm] 覆盖文件写入失败（内存态继续可用）:", err);
      }
    });
    return this.chain;
  }
}

/** 模块级单例：索引器与路由共用同一份内存态 */
export const overrides = new OverrideStore();
