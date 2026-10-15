// jobs.ts —— 全局任务互斥锁
// 背景（来自 docs/metadata-enrichment.md 第五节）：
//   下载管道会改书库；元数据的 build/enrich/catalog 都是"读整份 book_meta.json → 内存改 → 整份写回"，
//   两者并发会互相覆盖（enrich 跑十几分钟，中途 build 写盘的结果会在下次 flush 时被丢掉）。
//   因此所有会写书库或元数据的任务必须共用一个互斥锁，串行执行。
let current: string | null = null;

/** 当前占用锁的任务名（null = 空闲），如 "pipeline" / "metadata:enrich" */
export function currentJob(): string | null {
  return current;
}

export function isBusy(): boolean {
  return current !== null;
}

/** 尝试获取锁；已被占用返回 false（调用方负责返回 409 与提示） */
export function tryAcquire(name: string): boolean {
  if (current) return false;
  current = name;
  return true;
}

export function release(): void {
  current = null;
}
