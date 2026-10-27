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

/** 探测设备是否在线 + 读取其文件大小上限 */
export async function probeDevice(timeoutMs = 3000): Promise<DeviceStatus> {
  const target = await pushTarget();
  const t0 = Date.now();
  try {
    const r = await httpGetJson(`${target}/config`, timeoutMs);
    if (r.status !== 200) {
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
    const raw = (err as Error)?.message || String(err);
    // 设备只有在「传书」页面打开时才监听端口；ECONNREFUSED 通常就是这个原因
    const hint = /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|超时/.test(raw)
      ? "设备未连接：请先在阅读器上打开「传书」页面（设备只在页面打开时监听），再重试"
      : raw;
    return { target, reachable: false, ms: Date.now() - t0, error: hint };
  }
}

export interface PushResult {
  ok: boolean;
  target: string;
  bytes: number;
  ms: number;
  /** 设备返回的提示（成功时通常是"上传成功"） */
  message?: string;
  error?: string;
}

/** 把本地文件作为 multipart 字段 sfile 推送到设备 */
export async function pushFile(abs: string, filename: string, timeoutMs = 180_000): Promise<PushResult> {
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

  const boundary = `----ebm${crypto.randomBytes(8).toString("hex")}`;
  const safeName = filename.replace(/[\r\n"]/g, "_");
  // 分片头用 UTF-8 字节（与 curl 一致）：设备按 UTF-8 显示中文文件名
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="sfile"; filename="${safeName}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf-8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  const url = new URL(`${target}/upload`);

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
        res.on("end", () => {
          let msg = "";
          try {
            msg = String((JSON.parse(body) as { msg?: unknown }).msg || "");
          } catch {
            msg = body.slice(0, 120);
          }
          const ok = (res.statusCode || 0) === 200;
          done({
            ok,
            target,
            bytes: st.size,
            ms: Date.now() - t0,
            message: msg || undefined,
            error: ok ? undefined : `设备返回 HTTP ${res.statusCode}${msg ? "：" + msg : ""}`,
          });
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
