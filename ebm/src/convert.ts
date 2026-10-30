// convert.ts —— 文本版 PDF → EPUB（调用本地 PyMuPDF 转换器）
//
// 转换器：scripts/pdf2epub.py（PyMuPDF 提取带字号文本 → 分章 → 生成 EPUB3）
// 重要：无文字层的页（插图/扫描页）会渲染成图片页内嵌，**整本书按页序完整保留**，不丢内容
// 环境：ebm/.venv（python3 -m venv .venv && .venv/bin/pip install pymupdf）
// 产物：data/converted/<id>.epub + data/converted/index.json（不入书库、不参与扫描）
import { execFile } from "child_process";
import crypto from "crypto";
import fsp from "fs/promises";
import path from "path";
import { DATA_DIR } from "./paths";

export const CONVERT_DIR = path.join(DATA_DIR, "converted");
const INDEX_FILE = path.join(CONVERT_DIR, "index.json");
const SCRIPT = path.join(__dirname, "..", "scripts", "pdf2epub.py");
/** 默认用项目内 venv；可用 EBM_CONVERT_PY 覆盖 */
const PY = process.env.EBM_CONVERT_PY || path.join(__dirname, "..", ".venv", "bin", "python");
const TIMEOUT_MS = 10 * 60 * 1000;

export interface ConvertedRecord {
  id: string;
  srcRel: string;
  title: string;
  file: string;
  kind: "text" | "hybrid" | "scanned-images";
  pages: number;
  textPages: number;
  /** 无文字层、已渲染为图片页保留的页数 */
  imagePages: number;
  chapters: number;
  chars: number;
  sizeBytes: number;
  createdAt: number;
}

export interface ConvertResult {
  ok: boolean;
  kind?: "text" | "hybrid" | "scanned-images" | "error";
  id?: string;
  pages?: number;
  textPages?: number;
  imagePages?: number;
  coverPage?: number;
  hasCover?: boolean;
  note?: string;
  chapters?: number;
  chars?: number;
  sizeBytes?: number;
  error?: string;
}

/** 转换产物 id：按源文件绝对路径哈希（同一本书重复转换复用同一 id） */
export function convertId(abs: string): string {
  return crypto.createHash("sha1").update(abs).digest("hex").slice(0, 12);
}

async function loadIndex(): Promise<Record<string, ConvertedRecord>> {
  try {
    const raw = await fsp.readFile(INDEX_FILE, "utf-8");
    const d = JSON.parse(raw) as Record<string, ConvertedRecord>;
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

async function saveIndex(idx: Record<string, ConvertedRecord>): Promise<void> {
  await fsp.mkdir(CONVERT_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(idx, null, 1), "utf-8");
  await fsp.rename(tmp, INDEX_FILE);
}

/** 查已转换记录（界面下载/推送用） */
export async function findConverted(id: string): Promise<ConvertedRecord | null> {
  const idx = await loadIndex();
  return idx[id] || null;
}

/** 转换产物绝对路径 */
export function convertedAbs(rec: ConvertedRecord): string {
  return path.join(CONVERT_DIR, rec.file);
}

function parseLastJson(stdout: string): Record<string, unknown> | null {
  const lines = String(stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(lines[i]) as Record<string, unknown>;
      if (d && typeof d === "object" && "kind" in d) return d;
    } catch {
      /* 不是 JSON 行，继续往前找 */
    }
  }
  return null;
}

/** 把 PDF 转成 EPUB；返回结构化结果（扫描版返回 needsOcr） */
export async function convertToEpub(abs: string, title: string, author: string, srcRel: string): Promise<ConvertResult> {
  const pyOk = await fsp.stat(PY).catch(() => null);
  if (!pyOk) {
    return {
      ok: false,
      kind: "error",
      error: `转换环境未安装（缺少 ${PY}）：请执行 python3 -m venv .venv && .venv/bin/pip install pymupdf`,
    };
  }
  await fsp.mkdir(CONVERT_DIR, { recursive: true });
  const id = convertId(abs);
  const out = path.join(CONVERT_DIR, `${id}.epub`);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(PY, [SCRIPT, abs, out, title, author], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, out1, err1) => {
      if (out1 && String(out1).trim()) {
        resolve(String(out1));
        return;
      }
      reject(err || new Error(String(err1 || "转换失败")));
    });
  }).catch((err: Error) => {
    return JSON.stringify({ kind: "error", error: err.message || String(err) });
  });

  const d = parseLastJson(stdout);
  if (!d) return { ok: false, kind: "error", error: `转换器无有效输出：${String(stdout).slice(0, 160)}` };
  const kind = String(d.kind || "");
  if (kind === "error") return { ok: false, kind: "error", error: String(d.error || "转换失败").slice(0, 300) };
  if (kind !== "text" && kind !== "hybrid" && kind !== "scanned-images") {
    return { ok: false, kind: "error", error: `未知的转换结果：${kind}` };
  }
  const sizeBytes = Number(d.bytes) || (await fsp.stat(out)).size;
  const rec: ConvertedRecord = {
    id,
    srcRel,
    title,
    file: `${id}.epub`,
    kind: kind as ConvertedRecord["kind"],
    pages: Number(d.pages) || 0,
    textPages: Number(d.textPages) || 0,
    imagePages: Number(d.imagePages) || 0,
    chapters: Number(d.chapters) || 0,
    chars: Number(d.chars) || 0,
    sizeBytes,
    createdAt: Date.now(),
  };
  const idx = await loadIndex();
  idx[id] = rec;
  // 只保留最近 200 条记录（产物文件不自动删，避免误删用户刚生成的）
  const sorted = Object.values(idx).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  await saveIndex(Object.fromEntries(sorted.map((r) => [r.id, r])));
  return {
    ok: true,
    kind: rec.kind,
    id,
    pages: rec.pages,
    textPages: rec.textPages,
    imagePages: rec.imagePages,
    coverPage: (d.coverPage as number) || undefined,
    hasCover: d.hasCover === true,
    note:
      rec.kind === "scanned-images"
        ? `全书以图片页保留（${rec.imagePages} 页），内容完整但不可重排`
        : rec.imagePages > 0
          ? `${rec.imagePages} 页无文字层已渲染为图片页保留`
          : undefined,
    chapters: rec.chapters,
    chars: rec.chars,
    sizeBytes,
  };
}
