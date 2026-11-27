// push.ts —— 把书推送到局域网墨水屏阅读器
//
// 目标设备：科大讯飞 × 起点联名阅读器（彩屏 1299 版，Android 11）。
// 它在局域网启动一个官方传书页（默认 http://192.168.3.74:50071），接口：
//   GET  /config  → {"fileSizeLimit": 200}        （pdf/mobi/azw3 上限，单位 MB）
//   POST /upload  → multipart 字段名 sfile        → {"msg":"上传成功"}
//   支持 .txt/.epub/.pdf/.mobi/.azw3；txt/epub 上限 200MB
//
// 实现要点：
//   - 用 Node 核心 http 直连（不经任何环境代理；LAN 地址不该走代理）
//   - 文件用流式发送（200MB 的书不会整本读进内存）
//   - multipart 分片头用 UTF-8 字节写出（设备按 UTF-8 解析中文文件名，与 curl 行为一致）
//   - 地址可在网页「📤 阅读器」里粘贴保存（设备每次打开的地址可能不同），写入 data/push-target.json
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import http from "http";
import path from "path";
import { DATA_DIR } from "./paths";
import { appendPushLog } from "./pushlog";

/** 未配置时的默认设备地址（用户实际设备，可在 data/push-target.json 覆盖） */
export const DEFAULT_TARGET = "http://192.168.3.74:50071";

/** 推送目标：env EBM_PUSH_TARGET > data/push-target.json > 默认地址 */
export async function pushTarget(): Promise<string> {
  const env = (process.env.EBM_PUSH_TARGET || "").trim();
  if (env) return env.replace(/\/+$/, "");
  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, "push-target.json"), "utf-8");
    const d = JSON.parse(raw) as { url?: unknown };
    const url = typeof d.url === "string" ? d.url.trim() : "";
    if (url) return url.replace(/\/+$/, "");
  } catch {
    /* 未配置：用默认地址 */
  }
  return DEFAULT_TARGET;
}

/** 规范化用户输入的设备地址（允许省略 http://、去掉尾部斜杠） */
export function normalizeTarget(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) throw new Error("地址不能为空");
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withProto);
  } catch {
    throw new Error("地址格式不对，例如 http://192.168.3.74:50071");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http / https 地址");
  if (!u.hostname) throw new Error("地址缺少主机名");
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path === "/" ? "" : path}`;
}

/** 保存推送目标到 data/push-target.json（原子写） */
export async function setPushTarget(raw: string): Promise<string> {
  const url = normalizeTarget(raw);
  const file = path.join(DATA_DIR, "push-target.json");
  const tmp = `${file}.tmp`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify({ url }, null, 2), "utf-8");
  await fsp.rename(tmp, file);
  return url;
}

export interface DeviceStatus {
  /** 传书服务类型：stock=原厂传书（/config + /upload, 字段 sfile）；iflytek=讯飞阅读传书（/doupload, 字段 file） */
  mode?: "stock" | "iflytek";
  /** iflytek 模式下的上传地址（含 id 参数） */
  uploadUrl?: string;
  target: string;
  reachable: boolean;
  /** 设备声明的 pdf/mobi/azw3 单文件上限（MB） */
  fileSizeLimit?: number;
  ms: number;
  error?: string;
}

/** 直连 GET（不经过代理），带超时 */
function httpGetJson(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`连接超时（${timeoutMs}ms）`)));
    req.on("error", reject);
  });
}

/**
 * 解析讯飞阅读「WiFi 传书」页面的上传地址。
 * 该页面没有 /config；上传配置在 common.js 里：url = /doupload?dir=/sdcard/&id=<uuid>
 * （端口每次打开传书页面可能变，id 也可能变 → 每次都从页面现取）
 */
async function resolveIflytekUpload(target: string, timeoutMs: number): Promise<string | null> {
  try {
    const page = await httpGetJson(`${target}/`, timeoutMs);
    if (page.status !== 200) return null;
    if (!/doupload|WiFi\s*传书|传书/i.test(page.body)) return null;
    let js = "";
    const m = page.body.match(/<script[^>]+src="([^"]*common\.js)"/i);
    if (m) {
      const src = /^https?:/i.test(m[1]) ? m[1] : `${target}${m[1].startsWith("/") ? "" : "/"}${m[1]}`;
      const r = await httpGetJson(src, timeoutMs);
      if (r.status === 200) js = r.body;
    }
    const hit = js.match(/\/doupload\?[^"'\s<>]+/i) || page.body.match(/\/doupload\?[^"'\s<>]+/i);
    return hit ? `${target}${hit[0]}` : null;
  } catch {
    return null;
  }
}

/** 探测设备是否在线 + 读取其文件大小上限 */
export async function probeDevice(timeoutMs = 3000, targetOverride?: string): Promise<DeviceStatus> {
  const target = targetOverride || (await pushTarget());
  const t0 = Date.now();
  try {
    const r = await httpGetJson(`${target}/config`, timeoutMs);
    if (r.status !== 200) {
      // 讯飞阅读的传书没有 /config → 探测其 WiFi 传书页面
      const up = await resolveIflytekUpload(target, timeoutMs);
      if (up) return { target, reachable: true, mode: "iflytek", uploadUrl: up, ms: Date.now() - t0 };
      return { target, reachable: false, ms: Date.now() - t0, error: `设备返回 HTTP ${r.status}` };
    }
    let limit: number | undefined;
    try {
      const n = Number((JSON.parse(r.body) as { fileSizeLimit?: unknown }).fileSizeLimit);
      if (Number.isFinite(n) && n > 0) limit = n;
    } catch {
      /* /config 不是 JSON：忽略上限 */
    }
    return { target, reachable: true, fileSizeLimit: limit, ms: Date.now() - t0 };
  } catch (err) {
    // /config 请求异常（讯飞阅读传书对未知路径直接断开 → socket hang up）→ 也尝试识别其传书页面
    const up = await resolveIflytekUpload(target, timeoutMs);
    if (up) return { target, reachable: true, mode: "iflytek", uploadUrl: up, ms: Date.now() - t0 };
    const raw = (err as Error)?.message || String(err);
    // 设备只有在「传书」页面打开时才监听端口；ECONNREFUSED 通常就是这个原因
    const hint = /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|超时/.test(raw)
      ? "设备未连接：请先在阅读器上打开「传书」页面（设备只在页面打开时监听），再重试"
      : raw;
    return { target, reachable: false, ms: Date.now() - t0, error: hint };
  }
}

/**
 * 书名键：把设备上的文件名（带 `[号码]` 前缀）与本地文件名归一成同一个键。
 * 规则：去 `[号码]` 前缀 → 去【…】站标 → 去扩展名 → 去空白与标点 → 小写。
 * 用来判断「这本书是不是已经在设备上了」，不受前缀、格式、标点差异影响。
 */
export function bookKey(name: string): string {
  let s = String(name || "");
  s = s.replace(/^\[\d+\]/, "");
  s = s.replace(/【[^】]*】/g, "");
  const dot = s.lastIndexOf(".");
  // 扩展名参与比对：同名不同格式（PDF / EPUB）不算重复；`.sdr` 进度目录也不会误判成书
  const ext = dot > 0 ? s.slice(dot + 1).toLowerCase() : "";
  const base = dot > 0 ? s.slice(0, dot) : s;
  const key = base.replace(/[\s\-_·.,，。：:;；!！?？"“”'’()（）\[\]【】]/g, "").toLowerCase();
  return ext ? `${key}.${ext}` : key;
}

/** 设备侧的一本书（两种传书页返回的结构不同，统一成这个形状） */
export interface DeviceFileEntry {
  /** 文件名（起点传书带 `[号码]` 前缀；讯飞阅读不带） */
  name: string;
  /** 字节数（只有讯飞阅读的 `/fils` 给） */
  size?: number;
  /** 设备侧分组（讯飞阅读返回「书架」） */
  path?: string;
  /** 设备侧时间戳（ms，讯飞阅读给） */
  date?: number;
}

/**
 * 读取设备传书页的文件清单。设备只在传书页面打开时监听，失败返回 null 而不是抛错。
 * 两种传书页协议不同，依次尝试：
 *   起点阅读器：GET /files → ["[3369225]《…》作者.pdf", …]（只有名字）
 *   讯飞阅读：  GET /fils  → {code:200, data:[{name,size,path,date}, …]}（带体积/分组）
 * mode 已知时只探对应的那个，省掉一次必失败的请求。
 */
export async function listDeviceFiles(
  target: string,
  timeoutMs = 4000,
  mode?: "stock" | "iflytek",
): Promise<DeviceFileEntry[] | null> {
  const isBook = (n: string): boolean => !n.endsWith(".sdr"); // `.sdr` 是阅读进度目录，不是书
  if (mode !== "iflytek") {
    try {
      const r = await httpGetJson(`${target}/files`, timeoutMs);
      if (r.status === 200) {
        const arr: unknown = JSON.parse(r.body);
        if (Array.isArray(arr)) {
          return arr
            .filter((x): x is string => typeof x === "string" && isBook(x))
            .map((name) => ({ name }));
        }
      }
    } catch {
      /* 讯飞传书对未知路径直接断开 → 落到 /fils */
    }
  }
  if (mode === "stock") return null;
  try {
    const r = await httpGetJson(`${target}/fils`, timeoutMs);
    if (r.status !== 200) return null;
    const obj = JSON.parse(r.body) as { data?: unknown };
    if (!Array.isArray(obj.data)) return null;
    return (obj.data as DeviceFileEntry[]).filter(
      (e) => e && typeof e.name === "string" && isBook(e.name),
    );
  } catch {
    return null;
  }
}

/** 设备上已有的同名文件（返回设备侧原始文件名，含 `[号码]` 前缀） */
export async function findDeviceDuplicates(
  filename: string,
  target: string,
  timeoutMs = 4000,
  mode?: "stock" | "iflytek",
): Promise<{ checked: boolean; matches: string[]; details: DeviceFileEntry[] }> {
  const files = await listDeviceFiles(target, timeoutMs, mode);
  if (!files) return { checked: false, matches: [], details: [] };
  const key = bookKey(filename);
  const details = files.filter((f) => bookKey(f.name) === key);
  return { checked: true, matches: details.map((d) => d.name), details };
}

/** 上传后回读设备清单，找出这笔记录对应的设备文件名（带 `[号码]` 前缀） */
async function learnDeviceName(
  target: string,
  filename: string,
  before: DeviceFileEntry[] | null,
  mode?: "stock" | "iflytek",
): Promise<string | undefined> {
  const after = await listDeviceFiles(target, 4000, mode);
  if (!after) return undefined;
  const key = bookKey(filename);
  const cands = after.filter((f) => bookKey(f.name) === key);
  if (!cands.length) return undefined;
  if (before) {
    const seen = new Set(before.map((b) => b.name));
    const fresh = cands.filter((f) => !seen.has(f.name));
    if (fresh.length) return fresh[fresh.length - 1].name;
  }
  return cands[cands.length - 1].name;
}

export interface PushResult {
  ok: boolean;
  target: string;
  bytes: number;
  ms: number;
  /** 设备返回的提示（成功时通常是"上传成功"） */
  message?: string;
  /** 设备实际保存的文件名（带 `[号码]` 前缀；回读失败时缺省） */
  deviceName?: string;
  /** true = 因为设备上已有同名书而没有上传（force 可跳过） */
  duplicate?: boolean;
  /** duplicate 为 true 时，设备上已存在的文件名 */
  existing?: string[];
  error?: string;
}

/** 把本地文件作为 multipart 字段 sfile 推送到设备 */
export interface PushOptions {
  /** true = 即使设备上已有同名书也照传（用户在界面上确认过） */
  force?: boolean;
}

export async function pushFile(
  abs: string,
  filename: string,
  timeoutMs = 180_000,
  opts: PushOptions = {},
): Promise<PushResult> {
  const target = await pushTarget();
  const t0 = Date.now();
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, target, bytes: 0, ms: 0, error: `找不到文件：${abs}` };
  if (st.size === 0) return { ok: false, target, bytes: 0, ms: 0, error: "文件为空" };

  const device = await probeDevice();
  if (!device.reachable) {
    return { ok: false, target, bytes: st.size, ms: Date.now() - t0, error: device.error || `阅读器未连接（${target}）` };
  }
  if (device.fileSizeLimit && st.size > device.fileSizeLimit * 1024 * 1024) {
    return {
      ok: false,
      target,
      bytes: st.size,
      ms: Date.now() - t0,
      error: `文件 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过阅读器上限 ${device.fileSizeLimit}MB`,
    };
  }

  // 推送前查重：设备上书名键相同就算「已经传过」（设备给新文件加 [号码] 前缀，必须去前缀比对）
  const before = await listDeviceFiles(target, 4000, device.mode);
  if (before && !opts.force) {
    const key = bookKey(filename);
    const dups = before.filter((f) => bookKey(f.name) === key);
    if (dups.length) {
      const dups_ = dups.map((d) => (d.size ? `${d.name}（${(d.size / 1024 / 1024).toFixed(1)}MB）` : d.name));
      return {
        ok: false,
        duplicate: true,
        existing: dups.map((d) => d.name),
        target,
        bytes: st.size,
        ms: Date.now() - t0,
        error: `阅读器上已有同名书：${dups_.join("、")}`,
      };
    }
  }

  // 按设备类型选择上传地址与表单字段名
  let uploadUrl = `${target}/upload`;
  let fieldName = "sfile";
  if (device.mode === "iflytek") {
    const up = device.uploadUrl || (await resolveIflytekUpload(target, 5000));
    if (!up) return { ok: false, target, bytes: st.size, ms: Date.now() - t0, error: "未能从讯飞阅读传书页面解析上传地址" };
    uploadUrl = up;
    fieldName = "file";
  }
  const boundary = `----ebm${crypto.randomBytes(8).toString("hex")}`;
  const safeName = filename.replace(/[\r\n"]/g, "_");
  // 分片头用 UTF-8 字节（与 curl 一致）：设备按 UTF-8 显示中文文件名
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf-8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  const url = new URL(uploadUrl);

  return new Promise<PushResult>((resolve) => {
    let settled = false;
    const done = (r: PushResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(head.length + st.size + tail.length),
          accept: "application/json",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", async () => {
          let msg = "";
          try {
            msg = String((JSON.parse(body) as { msg?: unknown }).msg || "");
          } catch {
            msg = body.slice(0, 120);
          }
          const ok = (res.statusCode || 0) === 200;
          if (!ok) {
            done({
              ok: false,
              target,
              bytes: st.size,
              ms: Date.now() - t0,
              message: msg || undefined,
              error: `设备返回 HTTP ${res.statusCode}${msg ? "：" + msg : ""}`,
            });
            return;
          }
          // 回读设备清单拿到带 [号码] 前缀的真实文件名，再记一笔推送历史
          const deviceName = await learnDeviceName(target, filename, before, device.mode);
          await appendPushLog({ name: filename, deviceName, bytes: st.size, at: Date.now(), ok: true });
          done({ ok: true, target, bytes: st.size, ms: Date.now() - t0, message: msg || undefined, deviceName });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("推送超时")));
    req.on("error", (err) => done({ ok: false, target, bytes: st.size, ms: Date.now() - t0, error: err.message || String(err) }));

    req.write(head);
    const stream = fs.createReadStream(abs);
    stream.on("error", (err) => {
      req.destroy(err);
    });
    stream.on("end", () => req.end(tail));
    stream.pipe(req, { end: false });
  });
}
