// pipeline.ts —— 一键下载桥接：subprocess 调用雅书管道（设计文档四-8）
// 管道文件零改动：download_books.py --ids … → move_to_icloud.py → 扫描自动刷新
import { spawn } from "child_process";
import fsp from "fs/promises";
import path from "path";
import { currentJob, release, tryAcquire } from "./jobs";

import { WATCH_DIR } from "./paths";
const DOWNLOAD_SCRIPT = path.join(WATCH_DIR, "download_books.py");
const MOVE_SCRIPT = path.join(WATCH_DIR, "move_to_icloud.py");

const PYTHON = "python3";
/** 单次最多勾选数量（设计文档风险表：每次上限提示） */
export const MAX_IDS_PER_RUN = 30;

/** 是否有下载任务在执行（含元数据任务——两者共用同一把锁，防止互相覆盖书库/元数据） */
export function isRunning(): boolean {
  return currentJob() === "pipeline";
}

function runScript(
  script: string,
  args: string[],
  onChunk: (s: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [script, ...args], { cwd: WATCH_DIR });
    onChunk(`$ ${PYTHON} ${path.basename(script)} ${args.join(" ")}\n`);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => onChunk(d));
    child.stderr.on("data", (d: string) => onChunk(d));
    child.on("close", (code) => {
      onChunk(`\n[exit ${code ?? "null"}] ${path.basename(script)}\n`);
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      onChunk(`[spawn error] ${err.message}\n`);
      resolve(1);
    });
  });
}

export interface PipelineResult {
  ok: boolean;
  log: string;
}

/**
 * 执行一次"下载 → 归档"流水，onChunk 实时回传输出（前端流式日志）。
 * 全局互斥：同一时间只允许一个流水在跑（防误触发叠加消耗雅书账号）。
 */
export async function runPipeline(
  ids: number[],
  onChunk: (s: string) => void,
): Promise<PipelineResult> {
  if (!tryAcquire("pipeline")) {
    return { ok: false, log: `已有任务在执行中（${currentJob()}），请稍候` };
  }
  if (!ids.length) {
    release();
    return { ok: false, log: "未选择任何书目" };
  }
  if (ids.length > MAX_IDS_PER_RUN) {
    release();
    return { ok: false, log: `单次最多 ${MAX_IDS_PER_RUN} 本，当前 ${ids.length} 本` };
  }
  // 下载脚本存在性预检（管道未就位时给出明确错误）
  try {
    await fsp.access(DOWNLOAD_SCRIPT);
  } catch {
    release();
    return { ok: false, log: `未找到 ${DOWNLOAD_SCRIPT}` };
  }
  let log = "";
  const collect = (s: string) => {
    log += s;
    onChunk(s);
  };
  try {
    const code = await runScript(
      DOWNLOAD_SCRIPT,
      ["--ids", ids.join(",")],
      collect,
    );
    if (code !== 0) {
      collect("\n[warn] 下载脚本非零退出，仍尝试归档已完成的文件…\n");
    }
    await runScript(MOVE_SCRIPT, [], collect);
    return { ok: true, log };
  } finally {
    release();
  }
}
