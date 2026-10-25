#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF → EPUB（文本版转换器）

用法：
    .venv/bin/python scripts/pdf2epub.py <input.pdf> <output.epub> [title] [author]
输出：stdout 一行 JSON，例如
    {"kind":"text","pages":410,"chars":298014,"chapters":32,"out":"/path/out.epub","bytes":1234567}
    {"kind":"scanned","pages":124,"chars":18}      # 扫描版（无文字层）→ 应走 OCR，本脚本不转换

设计要点：
  - 用 PyMuPDF 取「带字号/坐标」的文本行：字号 ≈ 正文字号 1.25 倍且较短的行视为标题（分章依据）
  - 段落：同一页内按垂直间距合并行；中文行尾直接拼接（无空格）
  - 产出最小 EPUB3（mimetype 不压缩 + container.xml + nav + ncx + content.opf）
  - 不依赖 Calibre / 网络
"""
import json
import os
import re
import statistics
import sys
import zipfile

import pymupdf


def extract_pages(pdf_path):
    doc = pymupdf.open(pdf_path)
    pages = []
    for page in doc:
        data = page.get_text("dict")
        items = []
        for blk in data.get("blocks", []):
            if blk.get("type") != 0:  # 0=text，其它是图片
                continue
            for line in blk.get("lines", []):
                spans = line.get("spans", [])
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text:
                    continue
                size = max((s.get("size", 0) for s in spans), default=0) or 0
                bbox = line.get("bbox", [0, 0, 0, 0])
                items.append({"t": text, "s": float(size), "y": float(bbox[1]), "x": float(bbox[0])})
        if items:
            items.sort(key=lambda i: (round(i["y"], 1), i["x"]))
            pages.append(items)
    return len(doc), pages


def build_blocks(pages):
    sizes = [i["s"] for p in pages for i in p if i["s"] > 0]
    median = statistics.median(sizes) if sizes else 10.0
    blocks, buf = [], []

    def flush():
        nonlocal buf
        if buf:
            blocks.append(("p", "".join(buf)))
            buf = []

    for items in pages:
        prev_bottom = None
        for it in items:
            is_heading = (
                it["s"] >= median * 1.25
                and len(it["t"]) <= 40
                and not re.search(r"[。；，、：:,;]$", it["t"])
            )
            gap = (it["y"] - prev_bottom) if prev_bottom is not None else 999.0
            if is_heading:
                flush()
                blocks.append(("h", it["t"]))
            elif gap > max(median * 1.6, 12):
                flush()
                buf.append(it["t"])
            else:
                buf.append(it["t"])
            prev_bottom = it["y"] + it["s"]
        flush()
    return blocks


def split_chapters(blocks):
    chapters, cur, title = [], [], None
    for kind, text in blocks:
        if kind == "h" and (len(cur) >= 3 or title is None):
            if cur:
                chapters.append((title or f"第{len(chapters) + 1}部分", cur))
            title, cur = text, []
        else:
            cur.append((kind, text))
    if cur:
        chapters.append((title or f"第{len(chapters) + 1}部分", cur))
    # 标题识别过少或过多都不理想：少于 1 章 / 多于 60 章 → 按块均分
    if len(chapters) <= 1 or len(chapters) > 60:
        flat = [b for ch in chapters for b in ch[1]]
        chapters = []
        step = max(20, len(flat) // 20)
        for i in range(0, len(flat), step):
            chapters.append((f"第{i // step + 1}部分", flat[i:i + step]))
    return [c for c in chapters if any(t.strip() for _, t in c[1])]


def esc(s):
    from html import escape

    return escape(s, quote=False)


def chapter_xhtml(title, blocks):
    body = []
    for kind, text in blocks:
        tag = "h2" if kind == "h" else "p"
        body.append(f"<{tag}>{esc(text)}</{tag}>")
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><meta charset="utf-8"/>'
        f"<title>{esc(title)}</title>"
        '<link rel="stylesheet" type="text/css" href="style.css"/></head>'
        f"<body><h1>{esc(title)}</h1>{''.join(body)}</body></html>"
    )


def write_epub(out_path, title, author, chapters):
    def name(i):
        return f"chapter{i}.xhtml"

    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" '
            'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
            "</rootfiles></container>",
        )
        z.writestr(
            "OEBPS/style.css",
            "body{font-family:serif;line-height:1.75;margin:1em}h1,h2{text-align:center;margin:1.1em 0 .7em}p{text-indent:2em;margin:.3em 0}",
        )
        for i, (ct, blocks) in enumerate(chapters, 1):
            z.writestr(f"OEBPS/{name(i)}", chapter_xhtml(ct, blocks))
        z.writestr(
            "OEBPS/nav.xhtml",
            '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
            '<nav epub:type="toc"><h1>目录</h1><ol>'
            + "".join(f'<li><a href="{name(i)}">{esc(ct)}</a></li>' for i, (ct, _) in enumerate(chapters, 1))
            + "</ol></nav></body></html>",
        )
        z.writestr(
            "OEBPS/toc.ncx",
            '<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" '
            'version="2005-1"><head/><docTitle><text>'
            + esc(title)
            + "</text></docTitle><navMap>"
            + "".join(
                f'<navPoint id="n{i}" playOrder="{i}"><navLabel><text>{esc(ct)}</text></navLabel>'
                f'<content src="{name(i)}"/></navPoint>'
                for i, (ct, _) in enumerate(chapters, 1)
            )
            + "</navMap></ncx>",
        )
        z.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0" encoding="utf-8"?>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f'<dc:identifier id="bookid">urn:uuid:ebm-{abs(hash(title)) % (10**12)}</dc:identifier>'
            f"<dc:title>{esc(title)}</dc:title><dc:language>zh</dc:language>"
            + (f"<dc:creator>{esc(author)}</dc:creator>" if author else "")
            + '</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
            '<item id="css" href="style.css" media-type="text/css"/>'
            + "".join(f'<item id="c{i}" href="{name(i)}" media-type="application/xhtml+xml"/>' for i in range(1, len(chapters) + 1))
            + '</manifest><spine toc="ncx">'
            + "".join(f'<itemref idref="c{i}"/>' for i in range(1, len(chapters) + 1))
            + "</spine></package>",
        )


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"kind": "error", "error": "用法: pdf2epub.py <pdf> <out.epub> [title] [author]"}))
        return 2
    pdf, out = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else os.path.splitext(os.path.basename(pdf))[0]
    author = sys.argv[4] if len(sys.argv) > 4 else ""
    try:
        page_count, pages = extract_pages(pdf)
        chars = sum(len(i["t"]) for p in pages for i in p)
        total_pages = max(1, page_count)
        # 统计"有文字页"占比（每页 ≥20 字），比"总字数/页数"更稳：
        # 封面/版权页无字不会拉低判断，带 OCR 文字层的扫描书也能识别为 text/hybrid
        with_text = sum(1 for p in pages if sum(len(i["t"]) for i in p) >= 20)
        ratio = with_text / total_pages
        if not pages or ratio < 0.4:
            print(json.dumps({"kind": "scanned", "pages": page_count, "chars": chars,
                              "textPages": with_text}, ensure_ascii=False))
            return 0
        kind = "text" if ratio >= 0.8 else "hybrid"
        blocks = build_blocks(pages)
        chapters = split_chapters(blocks)
        if not chapters:
            print(json.dumps({"kind": "scanned", "pages": page_count, "chars": chars,
                              "textPages": with_text}, ensure_ascii=False))
            return 0
        write_epub(out, title, author, chapters)
        print(
            json.dumps(
                {
                    "kind": kind,
                    "pages": page_count,
                    "textPages": with_text,
                    "missingPages": total_pages - with_text,
                    "chars": chars,
                    "chapters": len(chapters),
                    "out": out,
                    "bytes": os.path.getsize(out),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"kind": "error", "error": str(exc)[:300]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
