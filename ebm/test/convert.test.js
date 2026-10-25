// convert.test.js —— PDF→EPUB（文本版）：真实转换、扫描版识别、幂等
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");


const TMP = path.join(os.tmpdir(), `ebm-convert-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EBM_DATA_DIR = TMP; // 必须在 require 之前（convert.ts 在模块加载时解析数据目录）

const { convertToEpub, findConverted, convertedAbs, CONVERT_DIR } = require("../dist/convert.js");

const PY = path.join(__dirname, "..", ".venv", "bin", "python");
const hasVenv = existsSync(PY);

/** 生成"有真实文字层"的 PDF（每页约 200 字符，用于文本版转换测试） */
async function writeTextPdf(file, pages = 4) {
  const objs = [];
  const add = (b) => {
    objs.push(b);
    return objs.length;
  };
  const catalog = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  const para =
    "The quick brown fox jumps over the lazy dog. This paragraph exists so that the PDF has a real text layer with enough characters per page to be classified as a text document rather than a scanned one. ";
  for (let i = 1; i <= pages; i++) {
    const lines = [`Page ${i}`, para, para];
    let y = 740;
    const ops = lines.map((t) => `BT /F1 14 Tf 60 ${(y -= 22)} Td (${t.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, "utf-8"));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "utf-8");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, out);
  return file;
}

/** 生成一个"只有图形/空白"的 PDF（没有文字层）→ 应判为扫描版 */
async function writeScannedPdf(file, pages = 3) {
  const objs = [];
  const add = (b) => {
    objs.push(b);
    return objs.length;
  };
  const catalog = add("");
  const pagesId = add("");
  const pageIds = [];
  for (let i = 1; i <= pages; i++) {
    const contentId = add("<< /Length 8 >>\nstream\n0 0 m S\nendstream"); // 只有一条空路径，无文字
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, "utf-8"));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "utf-8");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, out);
  return file;
}

test("文本版 PDF → EPUB：真实转换出合法 EPUB（mimetype + container + 多章）", { skip: hasVenv ? false : "缺少 ebm/.venv 转换环境" }, async () => {
  {
    const rel = "历史/测试文本书.pdf";
    const abs = await writeTextPdf(path.join(TMP, "text.pdf"), 4);
    const r = await convertToEpub(abs, "测试文本书", "某人", rel);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(["text", "hybrid"].includes(String(r.kind)), `kind=${r.kind}`);
    assert.ok((r.chapters || 0) >= 1, `应有章节，实际 ${r.chapters}`);
    assert.ok((r.chars || 0) > 0);
    assert.ok((r.sizeBytes || 0) > 0);

    const rec = await findConverted(String(r.id));
    assert.ok(rec, "转换记录应写入 index.json");
    const file = convertedAbs(rec);
    const buf = await fsp.readFile(file);
    assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "EPUB 应是 zip（PK 魔数）");
    const text = buf.toString("latin1");
    assert.ok(text.includes("application/epub+zip"), "应包含 mimetype");
    assert.ok(text.includes("META-INF/container.xml"), "应包含 container.xml");
    assert.ok(text.includes("OEBPS/content.opf"), "应包含 content.opf");

    // 幂等：同一文件再转一次 → 同一个 id
    const again = await convertToEpub(abs, "测试文本书", "某人", rel);
    assert.equal(again.ok, true);
    assert.equal(again.id, r.id, "重复转换应复用同一 id");
  }
});

test("扫描版 PDF（无文字层）→ 返回 needsOcr，不生成 EPUB", { skip: hasVenv ? false : "缺少 ebm/.venv 转换环境" }, async () => {
  const pdf = await writeScannedPdf(path.join(TMP, "scan.pdf"));
  const r = await convertToEpub(pdf, "扫描书", "", "扫描书.pdf");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "scanned");
  assert.equal(r.needsOcr, true);
  assert.ok((r.textPages || 0) <= 1, `有文字页应接近 0，实际 ${r.textPages}`);
});

test("转换器缺失时给出可操作的错误（而不是崩溃）", async () => {
  // 用一个不存在的解释器路径：EBM_CONVERT_PY 在模块加载时读取，这里直接验证错误文案契约
  const mod = require("../dist/convert.js");
  assert.ok(typeof mod.convertToEpub === "function");
  const r = await mod.convertToEpub(path.join(TMP, "nope.pdf"), "x", "", "nope.pdf");
  // 文件不存在时转换器仍会跑：要么报文件错误，要么报环境错误；两种都必须是结构化返回
  assert.equal(r.ok, false);
  assert.ok(String(r.error || "").length > 0, "必须带错误说明");
  assert.ok(CONVERT_DIR.endsWith("converted"), "产物目录应为 data/converted");
});
