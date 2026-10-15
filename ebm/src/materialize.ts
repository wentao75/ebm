// materialize.ts —— iCloud dataless 文件按需取回协调器（策略 A，设计文档 v1.1 增补）
// 背景：书库 805 本中约 85% 数据在 iCloud 云端（st_blocks=0）。
// 流程：检测 dataless → brctl download 触发取回 → 后台探针轮询 → 就绪后正常出流。
// 服务以 launchd 常驻（非沙箱）运行；若系统允许，普通 read 也会触发透明取回，双保险。
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";

const PROBE_INTERVAL_MS = 3000;
const PROBE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟上限（大 PDF + 慢网）
const MAX_CONCURRENT_JOBS = 3;

type Status = "materializing" | "ready" | "failed";

const jobs = new Map<string, { status: Status; startedAt: number }>();
const queue: string[] = [];
let active = 0;

export function statusOf(abs: string): Status | undefined {
  return jobs.get(abs)?.status;
}

export function isDataless(st: { size: number; blocks: number }): boolean {
  return st.size > 0 && st.blocks === 0;
}

async function probeOnce(abs: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fsp.open(abs, "r");
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, 0);
    return true;
  } catch {
    return false;
  } finally {
    // 无论成败都显式关闭，避免 fd 泄漏到 GC（Node DEP0137）
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* already closed */
      }
    }
  }
}

function kickBrctl(abs: string): void {
  try {
    const child = spawn("/usr/bin/brctl", ["download", abs], { stdio: "ignore" });
    child.on("error", () => {
      /* brctl 不可用时依赖透明取回 */
    });
  } catch {
    /* ignore */
  }
}

async function worker(abs: string): Promise<void> {
  const job = jobs.get(abs)!;
  kickBrctl(abs);
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeOnce(abs)) {
      job.status = "ready";
      active--;
      void pump();
      return;
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  job.status = "failed";
  active--;
  void pump();
}

async function pump(): Promise<void> {
  while (active < MAX_CONCURRENT_JOBS && queue.length) {
    const next = queue.shift()!;
    active++;
    void worker(next);
  }
}

/** 请求取回：返回当前状态；首次调用会入队并触发 brctl */
export function requestMaterialize(abs: string): Status {
  const existing = jobs.get(abs);
  if (existing && existing.status !== "failed") return existing.status;
  if (existing?.status === "failed") {
    // 允许失败后重试
    jobs.delete(abs);
  }
  jobs.set(abs, { status: "materializing", startedAt: Date.now() });
  queue.push(abs);
  void pump();
  return "materializing";
}

/** 快速探测：文件现在是否可直接读取 */
export async function quickReady(abs: string): Promise<boolean> {
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return false;
  if (!isDataless(st)) return true;
  return probeOnce(abs);
}
