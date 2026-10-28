// metaLink.ts —— 用户提供豆瓣链接/ID 时，直接抓取并更新该书元数据
//
// 为什么要它：自动匹配偶尔会把"同名不同书"配错（例：《更壮 更瘦 更强》撞上《身体革命》）。
// 用户既然能找到正确的豆瓣页面，就直接按页面抓，跳过模糊匹配；抓取结果写回 book_meta.json
// 并标记 pinned=true（后续自动 enrich 不再覆盖）。
//
// 实现：复用管道侧脚本 yabook_watch/repair_mismatched_meta.py --douban-id <id> --json
//   - 解析/限流/字段提取都在 Python 里（单一实现，避免两套解析逻辑漂移）
//   - EBM_BOOK_META 可指定 book_meta.json 路径（测试用）
import { execFile } from "child_process";
import path from "path";

/** 从用户输入里解析豆瓣 subject id：支持链接 / 裸 ID */
export function parseDoubanId(input: string): string | null {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^\d{4,}$/.test(s)) return s; // 裸 ID
  const m = /book\.douban\.com\/subject\/(\d+)/i.exec(s) || /douban\.com\/subject\/(\d+)/i.exec(s);
  return m ? m[1] : null;
}

export interface MetaLinkResult {
  ok: boolean;
  doubanId?: string;
  title?: string;
  author?: string;
  publisher?: string;
  year?: string;
  douban?: string;
  pinned?: boolean;
  introLen?: number;
  error?: string;
}

/** 本地管道脚本路径：<workspace>/yabook_watch/repair_mismatched_meta.py */
function scriptPath(): string {
  return path.join(__dirname, "..", "..", "yabook_watch", "repair_mismatched_meta.py");
}

/** 按豆瓣 ID 抓取并写回该书元数据 */
export async function updateMetaByDouban(rel: string, doubanId: string, timeoutMs = 60_000): Promise<MetaLinkResult> {
  const script = scriptPath();
  return new Promise<MetaLinkResult>((resolve) => {
    execFile(
      "python3",
      [script, rel, "--douban-id", doubanId, "--json"],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const out = `${stdout || ""}\n${stderr || ""}`.trim();
        // 脚本最后一行是 JSON（成功/失败都会输出）
        const lines = out.split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const d = JSON.parse(lines[i]) as Record<string, unknown>;
            if (d && typeof d === "object" && "ok" in d) {
              return resolve({
                ok: d.ok === true,
                doubanId: d.douban_id ? String(d.douban_id) : undefined,
                title: d.title ? String(d.title) : undefined,
                author: d.author ? String(d.author) : undefined,
                publisher: d.publisher ? String(d.publisher) : undefined,
                year: d.year ? String(d.year) : undefined,
                douban: d.douban ? String(d.douban) : undefined,
                pinned: d.pinned === true,
                introLen: Number(d.intro_len) || 0,
                error: d.error ? String(d.error) : undefined,
              });
            }
          } catch {
            /* 不是 JSON 行 */
          }
        }
        resolve({ ok: false, error: (err?.message || out || "脚本无输出").slice(0, 300) });
      },
    );
  });
}

export interface AuditSuspect {
  rel: string;
  similarity: number;
  matchedTitle: string;
  fileTitle: string;
  author: string;
  doubanId: string;
  pinned: boolean;
}

/** 元数据体检：列出"匹配到的豆瓣标题与文件标题差异很大"的可疑记录 */
export async function auditMeta(timeoutMs = 120_000): Promise<{ ok: boolean; suspects: AuditSuspect[]; total: number; error?: string }> {
  const script = scriptPath();
  return new Promise((resolve) => {
    execFile("python3", [script, "--audit", "--json"], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const out = `${stdout || ""}\n${stderr || ""}`.trim();
      const lines = out.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i]) as { ok?: boolean; suspects?: AuditSuspect[]; total?: number };
          if (d && typeof d === "object" && "ok" in d) {
            return resolve({ ok: d.ok === true, suspects: Array.isArray(d.suspects) ? d.suspects : [], total: Number(d.total) || 0 });
          }
        } catch {
          /* 非 JSON 行 */
        }
      }
      resolve({ ok: false, suspects: [], total: 0, error: (err?.message || out || "体检脚本无输出").slice(0, 300) });
    });
  });
}

/** 用修复后的匹配器重新匹配单本书（不需要链接） */
export async function rematchMeta(rel: string, timeoutMs = 90_000): Promise<MetaLinkResult> {
  const script = scriptPath();
  return new Promise((resolve) => {
    execFile("python3", [script, rel, "--json"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const out = `${stdout || ""}\n${stderr || ""}`.trim();
      const lines = out.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i]) as Record<string, unknown>;
          if (d && typeof d === "object" && "ok" in d) {
            return resolve({
              ok: d.ok === true,
              doubanId: d.douban_id ? String(d.douban_id) : undefined,
              title: d.title ? String(d.title) : undefined,
              publisher: d.publisher ? String(d.publisher) : undefined,
              year: d.year ? String(d.year) : undefined,
              douban: d.douban ? String(d.douban) : undefined,
              pinned: d.pinned === true,
              introLen: Number(d.intro_len) || 0,
              error: d.error ? String(d.error) : undefined,
            });
          }
        } catch {
          /* 非 JSON 行 */
        }
      }
      resolve({ ok: false, error: (err?.message || out || "脚本无输出").slice(0, 300) });
    });
  });
}
