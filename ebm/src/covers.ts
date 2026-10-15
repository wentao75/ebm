// covers.ts —— 图书封面生成与缓存（设计文档 v1.3 增补）
// 约束（策略 A）：dataless 云端书绝不因封面而触发取回 —— 调用方必须先确认文件在本地。
// 来源：PDF → macOS sips 渲染首页（实测可用）；EPUB → 解出内嵌封面图（container.xml → OPF → cover-image）。
// 缓存：ebm/covers/<sha1(rel|mtime)>.<ext>，mtime 变化自动失效（新书/新版本重新生成）。
import { spawn } from "child_process";
import crypto from "crypto";
import fsp from "fs/promises";
import path from "path";

const COVER_DIR = path.resolve(__dirname, "..", "covers");
const MAX_CONCURRENT = 2;
const MAX_DIM = 400; // 长边像素

export interface CoverParams {
  rel: string;
  mtimeMs: number;
  abs: string;
  ext: string; // "PDF" | "EPUB" | ...
}

export interface CoverResult {
  buf: Buffer;
  type: string;
}

function cachePath(rel: string, mtimeMs: number, ext = "img"): string {
  const h = crypto.createHash("sha1").update(`${rel}|${mtimeMs}`).digest("hex").slice(0, 20);
  return path.join(COVER_DIR, `${h}.${ext}`);
}

function mimeFromMagic(b: Buffer): string {
  if (b.length > 4 && b.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (b.length > 8 && b.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length > 3 && b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (b.length > 12 && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function extFromMime(m: string): string {
  return m.split("/")[1]?.replace("jpeg", "jpg") || "img";
}

function run(cmd: string, args: string[], timeoutMs = 30000): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) }));
    child.on("error", () => resolve({ code: 1, stdout: Buffer.alloc(0) }));
  });
}

/** PDF：sips 渲染首页并缩放到 MAX_DIM（macOS 原生，实测可用） */
async function pdfCover(abs: string, out: string): Promise<boolean> {
  const r = await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(MAX_DIM), abs, "--out", out], 45000);
  if (r.code !== 0) return false;
  try {
    const st = await fsp.stat(out);
    return st.size > 500;
  } catch {
    return false;
  }
}

function xmlAttr(tag: string, attr: string): string | undefined {
  const m = tag.match(new RegExp(`${attr}=["']([^"']*)["']`));
  return m?.[1];
}

/** EPUB：container.xml → OPF → cover-image（properties 或 <meta name=cover>）→ 图片字节 */
async function epubCover(abs: string): Promise<Buffer | null> {
  const c = await run("/usr/bin/unzip", ["-p", abs, "META-INF/container.xml"]);
  if (c.code !== 0) return null;
  const rootfile = c.stdout.toString("utf-8").match(/full-path=["']([^"']+)["']/)?.[1];
  if (!rootfile) return null;
  const o = await run("/usr/bin/unzip", ["-p", abs, rootfile]);
  if (o.code !== 0) return null;
  const opf = o.stdout.toString("utf-8");

  const items = new Map<string, { href: string; properties: string; media: string }>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0];
    const id = xmlAttr(tag, "id");
    const href = xmlAttr(tag, "href");
    if (id && href) {
      items.set(id, { href, properties: xmlAttr(tag, "properties") || "", media: xmlAttr(tag, "media-type") || "" });
    }
  }
  // 优先级：properties 含 cover-image > meta name=cover > 第一个图片 item
  let pick: { href: string } | undefined;
  for (const it of items.values()) {
    if (/\bcover-image\b/.test(it.properties)) {
      pick = it;
      break;
    }
  }
  if (!pick) {
    const metaId = opf.match(/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/)?.[1]
      || opf.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']cover["']/)?.[1];
    if (metaId && items.has(metaId)) pick = items.get(metaId);
  }
  if (!pick) {
    for (const it of items.values()) {
      if (it.media.startsWith("image/")) {
        pick = it;
        break;
      }
    }
  }
  if (!pick) return null;

  const dir = path.posix.dirname(rootfile);
  const inner = decodeURIComponent(
    pick.href.startsWith("/") ? pick.href.slice(1) : path.posix.join(dir === "." ? "" : dir, pick.href),
  );
  const img = await run("/usr/bin/unzip", ["-p", abs, inner]);
  if (img.code !== 0 || img.stdout.length < 200) return null;
  const mime = mimeFromMagic(img.stdout);
  return mime.startsWith("image/") ? img.stdout : null;
}

async function generate(p: CoverParams): Promise<CoverResult | null> {
  const { rel, mtimeMs } = p;
  const tmpOut = cachePath(rel, mtimeMs, "tmp");
  try {
    await fsp.mkdir(COVER_DIR, { recursive: true }); // 缓存目录幂等创建
    if (p.ext === "PDF") {
      const ok = await pdfCover(p.abs, tmpOut);
      if (!ok) return null;
      const buf = await fsp.readFile(tmpOut);
      const type = mimeFromMagic(buf);
      await fsp.rename(tmpOut, cachePath(rel, mtimeMs, extFromMime(type)));
      return { buf, type };
    }
    if (p.ext === "EPUB") {
      const img = await epubCover(p.abs);
      if (!img) return null;
      const type = mimeFromMagic(img);
      await fsp.writeFile(cachePath(rel, mtimeMs, extFromMime(type)), img);
      return { buf: img, type };
    }
    return null;
  } catch {
    return null;
  } finally {
    fsp.unlink(tmpOut).catch(() => {});
  }
}

// —— 请求合并 ——
const inflight = new Map<string, Promise<CoverResult | null>>();

/** 查缓存（不生成） */
export async function cachedCover(rel: string, mtimeMs: number): Promise<CoverResult | null> {
  const prefix = path.basename(cachePath(rel, mtimeMs).replace(/\.img$/, ""));
  let files: string[];
  try {
    files = (await fsp.readdir(COVER_DIR)).filter((f) => f.startsWith(prefix + "."));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const buf = await fsp.readFile(path.join(COVER_DIR, files[0]));
  return { buf, type: mimeFromMagic(buf) };
}

/** 获取封面：缓存 → 生成 → 合并并发请求。仅限本地文件（调用方保证 dataless 已排除）。 */
export function requestCover(p: CoverParams): Promise<CoverResult | null> {
  const key = `${p.rel}|${p.mtimeMs}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = (async () => {
    const hit = await cachedCover(p.rel, p.mtimeMs);
    if (hit) return hit;
    return generate(p);
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

// —— 后台批量补齐（扫描/取回落地后调用；幂等） ——
const queue: CoverParams[] = [];
let active = 0;

export function eagerGenerate(params: CoverParams[]): void {
  queue.push(...params);
  void pump();
}

async function pump(): Promise<void> {
  while (active < MAX_CONCURRENT && queue.length) {
    const p = queue.shift()!;
    active++;
    void (async () => {
      try {
        const hit = await cachedCover(p.rel, p.mtimeMs);
        if (!hit) await requestCover(p);
      } catch {
        /* 单本失败不影响队列 */
      } finally {
        active--;
        void pump();
      }
    })();
  }
}
