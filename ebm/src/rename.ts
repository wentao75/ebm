// rename.ts —— 书名/文件名编辑：清理建议 + 安全重命名 + 数据迁移 + 路径别名
//
// 为什么需要"路径别名"：rel（书库相对路径）是全系统的键——书架、阅读进度、人工覆盖、
// 管道元数据（book_meta.json / post_details.json）都按它索引。一旦改名，旧键全部落空
// （2026-10-01 批量清理时就踩过：改名后元数据 197 → 133）。
// 这里记录 new → old 的别名链，索引器查元数据时跟随，做到"改名不丢信息"。
import fsp from "fs/promises";
import path from "path";
import { LIBRARY_ROOT } from "./scanner";

const DATA_DIR = process.env.EBM_DATA_DIR || path.resolve(__dirname, "..", "data");
const ALIAS_FILE = path.join(DATA_DIR, "path-aliases.json");
const RENAME_MAP_FILE = path.join(DATA_DIR, "rename-map-manual.json");
const MAX_NAME = 200;
const MAX_HOPS = 8;

/** 站点/格式类标记词：出现在【…】或独立分段里即视为可清理的噪声 */
const MARKER_WORDS = /雅书|文字版|扫描版|精校版|电子书|高清版|全集版|V版|PDF|EPUB|MOBI|AZW3|DJVU|TXT/i;
/** 域名类标记：出现在 […] 里视为站点来源标记 */
const DOMAIN_MARK = /yabook|zlib|libgen|pan\.|www\.|\.org|\.com|\.net|\.top/i;

/**
 * 书名的归一化：**保留空格**，不向文件名看齐。
 * 文件名里用 " - " / "_" 当分隔符是合理的，但书名不该出现这种连接符——
 * 这里把下划线与"两侧空格的连字符"都还原成空格；像 COVID-19 这种词内连字符保持不变。
 */
export function normalizeTitleText(text: string): string {
  return text
    .replace(/_+/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface CleanRule {
  id: string;
  label: string;
  before: string;
  after: string;
}

export interface NameSuggestion {
  /** 原始文件名（含扩展名） */
  current: string;
  /** 建议文件名（含扩展名） */
  suggested: string;
  /** 建议的显示书名（不含扩展名；未做"作者/出版社"剥离，避免误伤） */
  title: string;
  rules: CleanRule[];
  notes: string[];
}

function splitExt(name: string): { base: string; ext: string } {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,6})$/.exec(name);
  return m ? { base: m[1], ext: m[2] } : { base: name, ext: "" };
}

/**
 * 生成文件名清理建议（纯函数，可测）。
 *
 * ⚠️ 两条规则**必须区分**（用户明确要求）：
 *   - **文件名**：不处理下划线 `_`（它是作者/出版/年份的正当分隔符），只给提示
 *   - **书名**（本函数返回的 title，走 normalizeTitleText）：把 `_` 还原为空格、不引入 ` - `
 *
 * 原则：**只清"确定是噪声"的东西**，含糊的一律不动、只给提示，由用户在预览里确认。
 */
export function suggestFileName(filename: string): NameSuggestion {
  const { base: rawBase, ext } = splitExt(filename);
  let base = rawBase;
  const rules: CleanRule[] = [];
  const notes: string[] = [];
  const apply = (id: string, label: string, re: RegExp, to: string | ((sub: string) => string)): void => {
    re.lastIndex = 0; // 带 /g 的正则 test() 会推进 lastIndex，必须先复位（否则 replace 会跳过头）
    const hit = re.test(base);
    re.lastIndex = 0;
    if (!hit) return;
    const before = base;
    base = typeof to === "string" ? base.replace(re, to) : base.replace(re, to);
    if (base !== before) rules.push({ id, label, before, after: base });
  };

  // 1) URL 编码（%2B → +、%20 → 空格 等）
  if (/%[0-9A-Fa-f]{2}/.test(base)) {
    const before = base;
    base = base.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => {
      try {
        return decodeURIComponent(`%${h}`);
      } catch {
        return `%${h}`;
      }
    });
    rules.push({ id: "urldecode", label: "解码 URL 编码（%2B→+）", before, after: base });
  }
  // 2) 【站点/格式标记】
  apply("bracket-marker", "去掉【文字版/雅书】等站点标记", /【[^】]*】/g, "");
  // 3) [域名] 标记（只清含域名的方括号，避免误伤《…》里的正常方括号）
  apply("bracket-domain", "去掉 [yabook.org] 等站点域名", /\[[^\]]*\]/g, (m: string) => (DOMAIN_MARK.test(m) ? "" : m));
  // 4) [V版]/[PDF] 等版本/格式标记
  apply("bracket-marker2", "去掉 [V版]/[PDF] 等版本标记", /\[[^\]]*\]/g, (m: string) => (MARKER_WORDS.test(m) ? "" : m));
  // 5) 开头日期前缀（2018-05《…》）
  apply("date-prefix", "去掉开头日期前缀", /^\d{4}\s*[-._年]\s*\d{1,2}(\s*[-._月]\s*\d{1,2})?\s*/, "");
  // 6) 独立分段的格式标记（书名.扫描版 → 书名）；反复执行，处理“.文字版电子书”这类连环标记
  for (let i = 0; i < 4; i += 1) {
    const before = base;
    apply("marker-segment", "去掉独立的“扫描版/文字版”分段", /[._\-\s+]*[（(]?(扫描版|文字版|精校版|电子书)[）)]?[._\-\s+]*(?=$|[【\[（(《])/g, " ");
    apply("tail-junk", "去掉结尾的“下载地址/更多资源”等", /[-_\s+.]*(下载地址|更多资源|关注公众号|扫描二维码|免费下载|更多电子书)[-_\s+.]*$/g, "");
    apply("tail-marker", "去掉结尾的“扫描版/文字版”", /[-_\s+.]*(扫描版|文字版|精校版|电子书)[-_\s+.]*$/g, "");
    apply("tail-ti", "去掉结尾的“(替)”", /[（(]替[）)]\s*$/g, "");
    if (base === before) break;
  }
  // 7) + 号噪声：+--+/+.+/++ → " - "；仅一侧贴中文的 + → 空格（两侧都是中文时保持原样，不篡改书名）
  apply("plus-noise", "把 ++/+--+/+.+ 之类的连接噪声换成 -", /\s*\+[-+.·]?\s*\+/g, " - ");
  apply("plus-cjk-right", "把紧接中文的 + 换成空格", /(?<![\u4e00-\u9fff])\+(?=[\u4e00-\u9fff])/g, " ");
  apply("plus-cjk-left", "把中文后紧跟的 + 换成空格", /(?<=[\u4e00-\u9fff])\+(?![\u4e00-\u9fff])/g, " ");
  // 9) 空白与分隔符收尾
  apply("spaces", "压缩多余空格", /\s{2,}/g, " ");
  apply("space-dot", "去掉句点/顿号前的空格", /\s+([.．·、])/g, "$1");
  const trimmed = base.replace(/^[\s\-_+.]|[\s\-_+.]+$/g, "");
  if (trimmed !== base) {
    rules.push({ id: "trim", label: "去掉首尾多余的分隔符", before: base, after: trimmed });
    base = trimmed;
  }
  if (!base) base = rawBase; // 兜底：清空了就保持原样

  // 含糊的内容只提示，不自动改
  if (/[（(]\d+[）)]$/.test(base)) notes.push("结尾像副本序号（如 (1)），未自动修改，请自行确认是否重复文件");
  // 下划线只在"书名"里归一化为空格（见 normalizeTitleText）；**文件名一律不动**（用户明确要求）
  if (/_/.test(base)) notes.push("文件名里的下划线保持不变（仅书名建议会把下划线还原为空格）");

  // 建议书名：与列表解析保持一致的提取方式（《…》取内层；"A - B" 取 A）
  const bm = /^《(.+?)》\s*(.*)$/.exec(base);
  const dm = !bm && /^(.+?)\s+-\s+(.+)$/.exec(base);
  const title = normalizeTitleText((bm ? bm[1] : dm ? dm[1] : base).trim() || base);
  return {
    current: filename,
    suggested: `${base}${ext}`,
    title,
    rules,
    notes,
  };
}

/** 校验新文件名是否安全（不允许路径分隔符、空名、纯占位符） */
export function validateName(newName: string): string | null {
  const name = (newName || "").trim();
  if (!name) return "文件名不能为空";
  if (name.length > MAX_NAME) return `文件名过长（最多 ${MAX_NAME} 字）`;
  if (/[/\\\0]/.test(name)) return "文件名不能包含路径分隔符 / \\";
  if (name === "." || name === "..") return "文件名非法";
  return null;
}

// ---------- 路径别名（改名后仍能查到旧键下的元数据）----------

interface AliasFile {
  version: number;
  updated: number;
  /** newRel → oldRel */
  items: Record<string, string>;
}

export class PathAliasStore {
  private items: Record<string, string> = {};
  private updatedAt = 0;
  private readonly file: string;

  constructor(file = ALIAS_FILE) {
    this.file = file;
  }

  get filePath(): string {
    return this.file;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, "utf-8")) as AliasFile;
      this.items = data?.items && typeof data.items === "object" ? data.items : {};
      this.updatedAt = Number(data?.updated) || 0;
    } catch {
      this.items = {};
    }
  }

  /** 记录 new → old，并让旧别名指向新键（A→B→C 链也能跟随） */
  add(newRel: string, oldRel: string): void {
    for (const [k, v] of Object.entries(this.items)) {
      if (v === newRel) this.items[k] = oldRel; // 保持链指向最原始的名字
    }
    if (newRel !== oldRel) this.items[newRel] = oldRel;
    this.updatedAt = Date.now();
    void this.flushNow();
  }

  remove(newRel: string): void {
    delete this.items[newRel];
    this.updatedAt = Date.now();
    void this.flushNow();
  }

  raw(): Record<string, string> {
    return this.items;
  }

  /** 跟随别名链拿到最原始的 rel（用于查元数据） */
  resolve(rel: string): string {
    let cur = rel;
    for (let i = 0; i < MAX_HOPS; i += 1) {
      const next = this.items[cur];
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  }

  async flushNow(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, updated: this.updatedAt, items: this.items }, null, 1), "utf-8");
      await fsp.rename(tmp, this.file);
    } catch (err) {
      console.error("[ebm] 路径别名写入失败:", err);
    }
  }
}

export const pathAliases = new PathAliasStore();

// ---------- 重命名日志（沿用既有 rename-map 格式，现成的 CLI 回滚脚本可直接用）----------

interface RenameEntry {
  old: string;
  new: string;
  at: string;
}

interface RenameMapFile {
  created: string;
  renames: RenameEntry[];
  skipped: Array<{ from: string; to: string; reason: string }>;
}

export class RenameLog {
  private readonly file: string;
  constructor(file = RENAME_MAP_FILE) {
    this.file = file;
  }

  async read(): Promise<RenameMapFile> {
    try {
      const d = JSON.parse(await fsp.readFile(this.file, "utf-8")) as RenameMapFile;
      return { created: d.created || "", renames: Array.isArray(d.renames) ? d.renames : [], skipped: d.skipped || [] };
    } catch {
      return { created: "", renames: [], skipped: [] };
    }
  }

  async append(entry: RenameEntry): Promise<void> {
    const data = await this.read();
    if (!data.created) data.created = new Date().toISOString();
    data.renames.unshift(entry); // 最新的在前
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 1), "utf-8");
    await fsp.rename(tmp, this.file);
  }

  /** 取某本书最近一次重命名（用于撤销） */
  async lastFor(rel: string): Promise<RenameEntry | null> {
    const data = await this.read();
    return data.renames.find((r) => r.new === rel) || null;
  }

  /** 撤销：把日志里的这条标记为已回滚（从数组移除） */
  async dropEntry(entry: RenameEntry): Promise<void> {
    const data = await this.read();
    data.renames = data.renames.filter((r) => !(r.old === entry.old && r.new === entry.new));
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 1), "utf-8");
    await fsp.rename(tmp, this.file);
  }
}

// ---------- 重命名执行 ----------

/** 把 rel 解析为书库内的绝对路径，并确保不越界 */
export function safeResolveRel(rel: string): string | null {
  if (!rel || typeof rel !== "string") return null;
  if (rel.includes("\0") || path.isAbsolute(rel)) return null;
  const abs = path.resolve(LIBRARY_ROOT, rel);
  const root = path.resolve(LIBRARY_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export interface RenamePlan {
  ok: boolean;
  error?: string;
  oldRel: string;
  newRel: string;
  /** 是否强制保留了原扩展名 */
  extForced: boolean;
}

/** 只做校验与推导，不落盘（便于先展示预览、也便于测试） */
export async function planRename(rel: string, newNameRaw: string): Promise<RenamePlan> {
  const err = validateName(newNameRaw);
  if (err) return { ok: false, error: err, oldRel: rel, newRel: rel, extForced: false };
  const oldAbs = safeResolveRel(rel);
  if (!oldAbs) return { ok: false, error: "路径非法", oldRel: rel, newRel: rel, extForced: false };
  const dir = path.dirname(oldAbs);
  const oldName = path.basename(oldAbs);
  const { ext: oldExt } = splitExt(oldName);
  let name = newNameRaw.trim();
  // 扩展名一律沿用原文件的（避免把 .pdf 改成 .txt 之类把书弄坏）
  const { ext: givenExt } = splitExt(name);
  let extForced = false;
  if (!givenExt) {
    name = `${name}${oldExt}`;
    extForced = Boolean(oldExt);
  } else if (givenExt.toLowerCase() !== oldExt.toLowerCase()) {
    name = `${name.slice(0, -givenExt.length)}${oldExt}`;
    extForced = true;
  }
  const newAbs = path.join(dir, name);
  const root = path.resolve(LIBRARY_ROOT);
  if (!newAbs.startsWith(root + path.sep)) return { ok: false, error: "目标路径越界", oldRel: rel, newRel: rel, extForced };
  if (newAbs === oldAbs) return { ok: false, error: "新文件名与原名相同", oldRel: rel, newRel: rel, extForced };
  try {
    await fsp.stat(newAbs);
    return { ok: false, error: `目标已存在：${name}`, oldRel: rel, newRel: rel, extForced };
  } catch {
    /* 目标不存在，正常 */
  }
  const newRel = path.relative(root, newAbs).split(path.sep).join("/");
  return { ok: true, oldRel: rel, newRel, extForced };
}

export interface RenameDeps {
  /** 迁移书架记录（含阅读进度） */
  migrateShelf: (oldRel: string, newRel: string) => void;
  /** 迁移人工元数据覆盖 */
  migrateOverride: (oldRel: string, newRel: string) => void;
  /** 迁移完成后刷盘 */
  flush: () => Promise<void>;
}

export interface RenameResult {
  ok: boolean;
  error?: string;
  oldRel: string;
  newRel: string;
  extForced: boolean;
  migrated: { shelf: boolean; override: boolean };
}

/**
 * 执行重命名：物理改名 → 迁移书架/覆盖 → 记别名与日志。
 * 只做 rename，**绝不读取文件内容**（iCloud 只读占位文件也能安全改名）。
 */
export async function performRename(
  rel: string,
  newNameRaw: string,
  deps: RenameDeps,
  log = new RenameLog(),
): Promise<RenameResult> {
  const plan = await planRename(rel, newNameRaw);
  if (!plan.ok) {
    return { ok: false, error: plan.error, oldRel: rel, newRel: rel, extForced: plan.extForced, migrated: { shelf: false, override: false } };
  }
  const oldAbs = safeResolveRel(plan.oldRel);
  const newAbs = safeResolveRel(plan.newRel);
  if (!oldAbs || !newAbs) {
    return { ok: false, error: "路径非法", oldRel: rel, newRel: rel, extForced: plan.extForced, migrated: { shelf: false, override: false } };
  }
  try {
    await fsp.rename(oldAbs, newAbs);
  } catch (err) {
    return { ok: false, error: `重命名失败：${String(err)}`, oldRel: rel, newRel: plan.newRel, extForced: plan.extForced, migrated: { shelf: false, override: false } };
  }
  // 物理改名成功后再迁移数据；每步独立 try，避免一步失败导致整体不可用
  let shelf = false;
  let override = false;
  try {
    deps.migrateShelf(plan.oldRel, plan.newRel);
    shelf = true;
  } catch (err) {
    console.error("[ebm] 书架记录迁移失败:", err);
  }
  try {
    deps.migrateOverride(plan.oldRel, plan.newRel);
    override = true;
  } catch (err) {
    console.error("[ebm] 人工覆盖迁移失败:", err);
  }
  pathAliases.add(plan.newRel, plan.oldRel);
  await log.append({ old: plan.oldRel, new: plan.newRel, at: new Date().toISOString() });
  try {
    await deps.flush();
  } catch {
    /* ignore */
  }
  return { ok: true, oldRel: plan.oldRel, newRel: plan.newRel, extForced: plan.extForced, migrated: { shelf, override } };
}

/** 撤销最近一次重命名（把文件改回原名并迁移回去） */
export async function undoRename(rel: string, deps: RenameDeps, log = new RenameLog()): Promise<RenameResult> {
  const entry = await log.lastFor(rel);
  if (!entry) {
    return { ok: false, error: "没有找到这本书的重命名记录", oldRel: rel, newRel: rel, extForced: false, migrated: { shelf: false, override: false } };
  }
  const curAbs = safeResolveRel(entry.new);
  const backAbs = safeResolveRel(entry.old);
  if (!curAbs || !backAbs) {
    return { ok: false, error: "路径非法", oldRel: entry.old, newRel: entry.new, extForced: false, migrated: { shelf: false, override: false } };
  }
  try {
    await fsp.stat(backAbs);
    return { ok: false, error: `原文件名已存在：${path.basename(backAbs)}`, oldRel: entry.old, newRel: entry.new, extForced: false, migrated: { shelf: false, override: false } };
  } catch {
    /* 原名不存在，可以还原 */
  }
  try {
    await fsp.rename(curAbs, backAbs);
  } catch (err) {
    return { ok: false, error: `还原失败：${String(err)}`, oldRel: entry.old, newRel: entry.new, extForced: false, migrated: { shelf: false, override: false } };
  }
  let shelf = false;
  let override = false;
  try {
    deps.migrateShelf(entry.new, entry.old);
    shelf = true;
  } catch (err) {
    console.error("[ebm] 书架记录还原失败:", err);
  }
  try {
    deps.migrateOverride(entry.new, entry.old);
    override = true;
  } catch (err) {
    console.error("[ebm] 人工覆盖还原失败:", err);
  }
  pathAliases.remove(entry.new);
  await log.dropEntry(entry);
  try {
    await deps.flush();
  } catch {
    /* ignore */
  }
  return { ok: true, oldRel: entry.old, newRel: entry.new, extForced: false, migrated: { shelf, override } };
}
