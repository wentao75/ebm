// scanner.ts —— 书库目录扫描 + fs.watch 增量刷新
// 只读访问书库根目录（iCloud eBooks），绝不移动/改名/删除任何文件。
import { EventEmitter } from "events";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/** 书库根目录（设计文档三：唯一真源） */
import { LIBRARY_ROOT } from "./paths";
export { LIBRARY_ROOT };

/** 支持的电子书扩展名 */
const EXTS = new Set([".pdf", ".epub", ".mobi", ".azw3", ".djvu", ".txt"]);

export interface BookFile {
  /** 书库内相对路径（POSIX 风格，作为稳定 id） */
  rel: string;
  abs: string;
  name: string; // 含扩展名
  ext: string; // 小写，含点
  category: string; // 一级目录名；根目录散落文件 → "根目录"
  size: number;
  mtimeMs: number;
  /** iCloud dataless：数据在云端，读取前需取回（st_blocks=0 且 size>0） */
  dataless: boolean;
}

function isHidden(name: string): boolean {
  return name.startsWith(".") || name === "._" + "" || name.startsWith("._");
}

async function walk(dir: string, root: string, out: BookFile[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不可读（iCloud 同步中等）→ 跳过
  }
  for (const ent of entries) {
    if (isHidden(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(abs, root, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (!EXTS.has(ext)) continue;
      // iCloud 未下载占位符（.#filename# 形式）或零字节跳过
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const top = rel.includes("/")
        ? rel.slice(0, rel.indexOf("/"))
        : "根目录";
      out.push({
        rel,
        abs,
        name: ent.name,
        ext,
        category: top,
        size: st.size,
        mtimeMs: st.mtimeMs,
        dataless: st.blocks === 0 && st.size > 0,
      });
    }
  }
}

export class LibraryScanner extends EventEmitter {
  private files: BookFile[] = [];
  private watcher: fs.FSWatcher | null = null;
  private debouceTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private rescanPending = false;
  scanningNow = false;

  /** 全量扫描（805 文件量级，亚秒级） */
  async scan(): Promise<BookFile[]> {
    this.scanningNow = true;
    const out: BookFile[] = [];
    await walk(LIBRARY_ROOT, LIBRARY_ROOT, out);
    out.sort((a, b) => a.rel.localeCompare(b.rel, "zh-Hans-CN"));
    this.files = out;
    this.scanningNow = false;
    return out;
  }

  getFiles(): BookFile[] {
    return this.files;
  }

  /** 启动 fs.watch 递归监听（macOS 支持 recursive），防抖后重扫并广播 */
  async startWatching(): Promise<void> {
    if (this.watcher) return;
    await this.scan();
    try {
      this.watcher = fs.watch(
        LIBRARY_ROOT,
        { recursive: true },
        (_event, filename) => {
          if (filename && (isHidden(filename) || filename === ".DS_Store")) {
            return;
          }
          this.scheduleRescan();
        },
      );
      this.watcher.on("error", (err) => {
        console.error("[scanner] watcher error:", err.message);
      });
      console.log("[scanner] watching", LIBRARY_ROOT);
    } catch (err) {
      console.error("[scanner] fs.watch 启动失败（不影响手动刷新）:", err);
    }
  }

  private scheduleRescan(): void {
    if (this.debouceTimer) clearTimeout(this.debouceTimer);
    this.debouceTimer = setTimeout(() => {
      this.debouceTimer = null;
      void this.rescan();
    }, 600);
  }

  private async rescan(): Promise<void> {
    if (this.scanning) {
      this.rescanPending = true;
      return;
    }
    this.scanning = true;
    try {
      await this.scan();
      this.emit("updated", this.files);
    } finally {
      this.scanning = false;
      if (this.rescanPending) {
        this.rescanPending = false;
        void this.rescan();
      }
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debouceTimer) clearTimeout(this.debouceTimer);
  }
}
