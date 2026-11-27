// device.ts —— 阅读器「传书页」的文件管理（列清单 / 删除 / 下载）
//
// 两种传书页能力不同，这里按协议能力做能力降级：
//   讯飞阅读（默认端口固定 50006）：
//     GET  /fils                 → {code,data:[{name,size,path,date}]}   列「书架」
//     POST /dodelete fname&path  → {code:200,msg:"成功"}                 删书（幂等）
//     GET  /sdcard/<path>/<name> → 文件本体（静态直出，可下载）
//   起点阅读器（端口每次变）：
//     GET  /files → ["[号码]书名.pdf", …]（只有名字，**没有删除接口**）
//
// 约定：任何一步失败都返回结构化错误而不是抛异常 —— 页面要能自己解释为什么不可用。
import fsp from "fs/promises";
import net from "net";
import http from "http";
import path from "path";
import { DATA_DIR } from "./paths";
import { bookKey, listDeviceFiles, probeDevice, pushTarget } from "./push";

/** 按扩展名给下载响应定 Content-Type（设备静态服务不一定会给） */
export function deviceContentType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    epub: "application/epub+zip",
    mobi: "application/x-mobipocket-ebook",
    azw3: "application/vnd.amazon.ebook",
    txt: "text/plain; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

/** 直接连设备（不经环境代理；LAN 地址走代理会 502） */
function deviceRequest(
  url: URL,
  timeoutMs: number,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || "GET",
        timeout: timeoutMs,
        headers: init.headers,
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new Error(`连接超时（${timeoutMs}ms）`)));
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** 读完整个响应体（小 JSON 用） */
function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    res.setEncoding("utf-8");
    res.on("data", (c: string) => (body += c));
    res.on("end", () => resolve(body));
    res.on("error", reject);
  });
}

/** 单个路径段的安全校验：不允许分隔符、不允许 ..（防目录穿越） */
export function safeSegment(s: string): boolean {
  return !!s && !/[\/\\]/.test(s) && !s.includes("..") && s.length <= 255;
}

export interface DeviceFileRow {
  name: string;
  size?: number;
  path?: string;
  date?: number;
  /** 书名键（去号码前缀/站标，含扩展名） */
  key: string;
  /** 设备上是否还有同名的另一份 */
  duplicate: boolean;
}

export interface DeviceFilesView {
  ok: boolean;
  reachable: boolean;
  target: string;
  mode?: "stock" | "iflytek";
  /** 当前通道是否支持删除（只有讯飞阅读的 /dodelete 支持） */
  canDelete: boolean;
  files: DeviceFileRow[];
  /** 重复项分组（同名同格式多份） */
  duplicateGroups: Array<{ key: string; names: string[] }>;
  error?: string;
}

export interface DeviceActionResult {
  ok: boolean;
  target: string;
  message?: string;
  error?: string;
}

/** 设备文件清单 + 重复分组（页面主数据） */
export async function deviceFiles(timeoutMs = 5000, url?: string): Promise<DeviceFilesView> {
  const st = await probeDevice(timeoutMs, url);
  // probeDevice 只在讯飞通道给 mode；能连通但没标 iflytek 的就是起点（stock）
  const mode: "stock" | "iflytek" | undefined = st.mode === "iflytek" ? "iflytek" : st.reachable ? "stock" : undefined;
  const base: DeviceFilesView = {
    ok: false,
    reachable: st.reachable,
    target: st.target,
    mode,
    canDelete: mode === "iflytek",
    files: [],
    duplicateGroups: [],
  };
  if (!st.reachable) {
    return { ...base, error: st.error || "阅读器未连接：请先在阅读器上打开「传书」页面" };
  }
  const entries = await listDeviceFiles(st.target, timeoutMs, mode);
  if (!entries) {
    return { ...base, error: "这个传书页没有提供文件清单接口（只有讯飞阅读支持）" };
  }
  const rows: DeviceFileRow[] = entries.map((e) => ({ ...e, key: bookKey(e.name), duplicate: false }));
  const byKey = new Map<string, DeviceFileRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.key) || [];
    list.push(r);
    byKey.set(r.key, list);
  }
  const duplicateGroups: Array<{ key: string; names: string[] }> = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    for (const r of list) r.duplicate = true;
    duplicateGroups.push({ key, names: list.map((r) => r.name) });
  }
  return { ...base, ok: true, files: rows, duplicateGroups };
}

/** 删除设备上的一本书（讯飞阅读：POST /dodelete，fname + path） */
export async function deleteDeviceFile(
  name: string,
  dir: string,
  timeoutMs = 8000,
  url?: string,
): Promise<DeviceActionResult> {
  const target = url || (await pushTarget());
  if (!safeSegment(name) || !safeSegment(dir)) {
    return { ok: false, target, error: "文件名或目录不合法" };
  }
  const body = `fname=${encodeURIComponent(name)}&path=${encodeURIComponent(dir)}`;
  try {
    const res = await deviceRequest(new URL(`${target}/dodelete`), timeoutMs, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    const text = await readBody(res);
    let code = 0;
    let msg = "";
    try {
      const obj = JSON.parse(text) as { code?: unknown; msg?: unknown };
      code = Number(obj.code) || 0;
      msg = String(obj.msg || "");
    } catch {
      msg = text.slice(0, 120);
    }
    if ((res.statusCode || 0) === 200 && code === 200) return { ok: true, target, message: msg || "已删除" };
    return { ok: false, target, error: msg || `设备返回 HTTP ${res.statusCode}` };
  } catch (err) {
    return { ok: false, target, error: (err as Error)?.message || String(err) };
  }
}

/** 打开设备上的文件流，用于从浏览器下载（设备静态服务：GET /sdcard/<dir>/<name>） */
export async function openDeviceFile(
  name: string,
  dir: string,
  timeoutMs = 15_000,
  url?: string,
): Promise<{ stream: http.IncomingMessage; length?: string } | null> {
  if (!safeSegment(name) || !safeSegment(dir)) return null;
  const target = url || (await pushTarget());
  const fileUrl = new URL(`${target}/sdcard/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`);
  try {
    const res = await deviceRequest(fileUrl, timeoutMs);
    if ((res.statusCode || 0) !== 200) {
      res.destroy();
      return null;
    }
    return { stream: res, length: res.headers["content-length"] as string | undefined };
  } catch {
    return null;
  }
}

/** 已知的传书页地址（一个文件，按 url 去重；讯飞端口固定，起点每次变 → 记住最近一次） */
export interface DeviceTarget {
  url: string;
  label?: string;
}

function targetsFile(): string {
  return path.join(DATA_DIR, "device-targets.json");
}

/** 读取已登记的传书页（不含当前推送目标；读取失败当作空） */
export async function readDeviceTargets(): Promise<DeviceTarget[]> {
  try {
    const raw = await fsp.readFile(targetsFile(), "utf-8");
    const obj = JSON.parse(raw) as { targets?: unknown };
    if (!Array.isArray(obj.targets)) return [];
    return (obj.targets as DeviceTarget[]).filter((t) => t && typeof t.url === "string");
  } catch {
    return [];
  }
}

/** 登记一个传书页（同 url 覆盖 label；最多留 5 个，最近的优先） */
export async function rememberDeviceTarget(url: string, label?: string): Promise<void> {
  try {
    const all = (await readDeviceTargets()).filter((t) => t.url !== url);
    all.unshift({ url, label });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const file = targetsFile();
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ targets: all.slice(0, 5) }, null, 2), "utf-8");
    await fsp.rename(tmp, file);
  } catch {
    /* 记录失败不影响主流程 */
  }
}

/** 页面数据：当前推送目标 + 已登记的历史地址，逐个探测后一起返回 */
export async function deviceFilesAll(timeoutMs = 4000): Promise<{ groups: DeviceFilesView[] }> {
  const primary = await pushTarget();
  const saved = await readDeviceTargets();
  const urls: string[] = [];
  for (const u of [primary, ...saved.map((t) => t.url)]) {
    if (u && !urls.includes(u)) urls.push(u);
  }
  const groups: DeviceFilesView[] = [];
  for (const u of urls.slice(0, 4)) {
    const view = await deviceFiles(timeoutMs, u);
    groups.push(view);
    // 起点这类端口会变的通道：探测成功就记住，下次页面还能看到
    if (view.ok && view.mode === "stock" && u !== primary) await rememberDeviceTarget(u, "起点阅读器");
  }
  return { groups };
}

/** 单端口连通性探测（LAN 内关闭的端口会立刻 RST，所以整段扫描很快） */
export function probePort(ip: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, ip);
  });
}

/** 并发扫一段端口，返回其中处于监听状态的 */
export async function scanPorts(
  ip: string,
  from: number,
  to: number,
  concurrency = 200,
  timeoutMs = 400,
): Promise<number[]> {
  const ports: number[] = [];
  for (let p = from; p <= to; p++) ports.push(p);
  const open: number[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, ports.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= ports.length) return;
      const port = ports[i];
      if (await probePort(ip, port, timeoutMs)) open.push(port);
    }
  });
  await Promise.all(workers);
  return open.sort((a, b) => a - b);
}

/** 判断某个 HTTP 端口是不是传书页，并识别是哪一种协议 */
async function classifyPage(ip: string, port: number, timeoutMs = 1500): Promise<"stock" | "iflytek" | null> {
  const base = `http://${ip}:${port}`;
  try {
    const files = await deviceRequest(new URL(`${base}/files`), timeoutMs);
    if ((files.statusCode || 0) === 200) {
      const text = await readBody(files);
      if (Array.isArray(JSON.parse(text))) return "stock";
    }
  } catch {
    /* 不是起点传书页 */
  }
  try {
    const fils = await deviceRequest(new URL(`${base}/fils`), timeoutMs);
    if ((fils.statusCode || 0) === 200) {
      const obj = JSON.parse(await readBody(fils)) as { data?: unknown };
      if (Array.isArray(obj.data)) return "iflytek";
    }
  } catch {
    /* 不是讯飞传书页 */
  }
  return null;
}

export interface DiscoverResult {
  ip: string;
  /** fast = 只探已知端口（固定 50006 / 已登记地址 / 当前推送目标）；full = 扫了整段端口 */
  stage: "fast" | "full";
  scanned: number;
  openPorts: number[];
  pages: Array<DeviceTarget & { mode: "stock" | "iflytek" }>;
  ms: number;
}

/** 讯飞阅读的传书页端口是固定的，永远先试它 */
export const IFLYTEK_PORT = 50006;

/**
 * 自动发现传书页。两级策略：
 *   1) 先探「已知端口」：固定 50006 + 已登记地址 + 当前推送目标 —— 讯飞开着时 1 秒内返回，不扫全端口
 *   2) 以上都没命中才扫 1024–65535（起点的端口每次打开都变，只能扫）
 * deep=true 时即使快速命中也会继续全端口扫描（用于同时找起点）。
 */
export async function discoverTransferPages(
  opts: {
    ip?: string;
    from?: number;
    to?: number;
    concurrency?: number;
    timeoutMs?: number;
    /** 覆盖"已知端口"列表（测试用） */
    knownPorts?: number[];
    /** 强制全端口扫描（找到起点这类随机端口） */
    deep?: boolean;
  } = {},
): Promise<DiscoverResult> {
  const t0 = Date.now();
  const primary = await pushTarget();
  let ip = (opts.ip || "").trim();
  if (!ip) {
    try {
      ip = new URL(primary).hostname;
    } catch {
      throw new Error("当前推送地址无效，无法确定设备 IP");
    }
  }

  // ---- 1) 快速通道：只探已知端口，不发一个 SYN 扫描包 ----
  const knownPorts = new Set<number>(opts.knownPorts ?? [IFLYTEK_PORT]);
  for (const t of await readDeviceTargets()) {
    try {
      const u = new URL(t.url);
      if (u.hostname === ip) knownPorts.add(Number(u.port || 80));
    } catch {
      /* 忽略坏地址 */
    }
  }
  try {
    const u = new URL(primary);
    if (u.hostname === ip) knownPorts.add(Number(u.port || 80));
  } catch {
    /* 忽略 */
  }

  const pages: Array<DeviceTarget & { mode: "stock" | "iflytek" }> = [];
  const fastHits: number[] = [];
  for (const port of [...knownPorts].sort((a, b) => a - b)) {
    const mode = await classifyPage(ip, port, 1200);
    if (!mode) continue;
    const url = `http://${ip}:${port}`;
    pages.push({ url, label: mode === "iflytek" ? "讯飞阅读" : "起点阅读器", mode });
    fastHits.push(port);
    await rememberDeviceTarget(url, mode === "iflytek" ? "讯飞阅读" : "起点阅读器");
  }
  if (pages.length && !opts.deep) {
    return { ip, stage: "fast", scanned: knownPorts.size, openPorts: fastHits, pages, ms: Date.now() - t0 };
  }

  // ---- 2) 全端口扫描（快速通道没命中，或用户明确要深扫）----
  const from = opts.from ?? 1024;
  const to = opts.to ?? 65535;
  const openPorts = await scanPorts(ip, from, to, opts.concurrency ?? 200, opts.timeoutMs ?? 400);
  for (const port of openPorts) {
    if (fastHits.includes(port)) continue;
    const mode = await classifyPage(ip, port);
    if (!mode) continue;
    const url = `http://${ip}:${port}`;
    pages.push({ url, label: mode === "iflytek" ? "讯飞阅读" : "起点阅读器", mode });
    await rememberDeviceTarget(url, mode === "iflytek" ? "讯飞阅读" : "起点阅读器");
  }
  return { ip, stage: "full", scanned: to - from + 1, openPorts, pages, ms: Date.now() - t0 };
}
