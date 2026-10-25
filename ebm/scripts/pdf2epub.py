#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF → EPUB（文本 + 图片页完整保留）

用法：
    .venv/bin/python scripts/pdf2epub.py <input.pdf> <output.epub> [title] [author]
输出：stdout 一行 JSON：
    {"kind":"text","pages":410,"textPages":404,"imagePages":6,"chars":288598,"chapters":21,"out":"...","bytes":806904}
    {"kind":"hybrid","pages":403,"textPages":201,"imagePages":202,...}
    {"kind":"scanned-images","pages":325,"textPages":5,"imagePages":320,...}   # 全书以图片页保留（完整）

设计（v2，2026-10-26 修复用户报告的"缺页"缺陷）：
  - **按页序**构建内容流：有文字层的页 → 标题/段落；无文字层的页 → 渲染成图片页（默认 110dpi JPEG）
  - 章节只切分文字内容，图片页保持原位（插图/图谱/扫描页都不会丢）
  - 产出最小 EPUB3（mimetype 不压缩 + container + nav + ncx + content.opf + img/）
"""
import json
import os
import re
import statistics
import sys
import zipfile
from html import escape

import pymupdf

IMG_DPI = int(os.environ.get("EBM_CONVERT_IMG_DPI", "110"))
IMG_QUALITY = int(os.environ.get("EBM_CONVERT_IMG_QUALITY", "70"))
TEXT_PAGE_MIN_CHARS = 20


def page_text_items(page):
    """取一页的文字行（带字号/坐标）；无文字返回空列表"""
    data = page.get_text("dict")
    items = []
    for blk in data.get("blocks", []):
        if blk.get("type") != 0:  # 0=text
            continue
        for line in blk.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(s.get("text", "") for s in spans).strip()
            if not text:
                continue
            size = max((s.get("size", 0) for s in spans), default=0) or 0
            bbox = line.get("bbox", [0, 0, 0, 0])
            items.append({"t": text, "s": float(size), "y": float(bbox[1]), "x": float(bbox[0])})
    items.sort(key=lambda i: (round(i["y"], 1), i["x"]))
    return items


def build_content(doc):
    """按页序返回内容流：[(("h"|"p"), text) | ("img", pno, jpeg_bytes)]"""
    sizes = []
    for page in doc:
        for it in page_text_items(page):
            if it["s"] > 0:
                sizes.append(it["s"])
    median = statistics.median(sizes) if sizes else 10.0

    content = []
    text_pages = 0
    image_pages = 0

    for pno, page in enumerate(doc):
        items = page_text_items(page)
        plain = "".join(i["t"] for i in items)
        if len(plain) < TEXT_PAGE_MIN_CHARS:
            # 无文字层 → 渲染整页为图片（插图页/扫描页都靠它保留内容）
            pix = page.get_pixmap(dpi=IMG_DPI, colorspace=pymupdf.csRGB, alpha=False)
            jpeg = pix.tobytes("jpeg", jpg_quality=IMG_QUALITY)
            content.append(("img", pno, jpeg))
            image_pages += 1
            continue

        text_pages += 1
        buf = []

        def flush():
            nonlocal buf
            if buf:
                content.append(("p", "".join(buf)))
                buf = []

        prev_bottom = None
        for it in items:
            is_heading = (
                it["s"] >= median * 1.25 and len(it["t"]) <= 40 and not re.search(r"[。；，、：:,;]$", it["t"])
            )
            gap = (it["y"] - prev_bottom) if prev_bottom is not None else 999.0
            if is_heading:
                flush()
                content.append(("h", it["t"]))
            elif gap > max(median * 1.6, 12):
                flush()
                buf.append(it["t"])
            else:
                buf.append(it["t"])
            prev_bottom = it["y"] + it["s"]
        flush()

    return content, text_pages, image_pages


def split_chapters(content):
    """把内容流切成章节：只在标题处切；标题太少/太多时按条目数均分（图片页随位不丢）"""
    chapters, cur, title = [], [], None
    for item in content:
        if item[0] == "h" and (len(cur) >= 3 or title is None):
            if cur:
                chapters.append((title or f"第{len(chapters) + 1}部分", cur))
            title, cur = item[1], []
        else:
            cur.append(item)
    if cur:
        chapters.append((title or f"第{len(chapters) + 1}部分", cur))
    if len(chapters) <= 1 or len(chapters) > 60:
        flat = [b for ch in chapters for b in ch[1]]
        chapters = []
        step = max(20, len(flat) // 20)
        for i in range(0, len(flat), step):
            chapters.append((f"第{i // step + 1}部分", flat[i:i + step]))
    return [c for c in chapters if c[1]]


def chapter_xhtml(title, items):
    body = []
    for item in items:
        if item[0] == "img":
            pno = item[1]
            body.append(f'<div class="pageimg"><img src="img/page{pno + 1:04d}.jpg" alt="第 {pno + 1} 页"/></div>')
        elif item[0] == "h":
            body.append(f"<h2>{escape(item[1])}</h2>")
        else:
            body.append(f"<p>{escape(item[1])}</p>")
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><meta charset="utf-8"/>'
        f"<title>{escape(title)}</title>"
        '<link rel="stylesheet" type="text/css" href="style.css"/></head>'
        f"<body><h1>{escape(title)}</h1>{''.join(body)}</body></html>"
    )


def write_epub(out_path, title, author, chapters, images):
    def cname(i):
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
            "body{font-family:serif;line-height:1.75;margin:1em}"
            "h1,h2{text-align:center;margin:1.1em 0 .7em}p{text-indent:2em;margin:.3em 0}"
            ".pageimg{margin:0;padding:0}.pageimg img{max-width:100%;height:auto;display:block;margin:0 auto}",
        )
        for i, (ct, items) in enumerate(chapters, 1):
            z.writestr(f"OEBPS/{cname(i)}", chapter_xhtml(ct, items))
        for pno, jpeg in images:
            z.writestr(f"OEBPS/img/page{pno + 1:04d}.jpg", jpeg, compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "OEBPS/nav.xhtml",
            '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
            '<nav epub:type="toc"><h1>目录</h1><ol>'
            + "".join(f'<li><a href="{cname(i)}">{escape(ct)}</a></li>' for i, (ct, _) in enumerate(chapters, 1))
            + "</ol></nav></body></html>",
        )
        z.writestr(
            "OEBPS/toc.ncx",
            '<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" '
            'version="2005-1"><head/><docTitle><text>'
            + escape(title)
            + "</text></docTitle><navMap>"
            + "".join(
                f'<navPoint id="n{i}" playOrder="{i}"><navLabel><text>{escape(ct)}</text></navLabel>'
                f'<content src="{cname(i)}"/></navPoint>'
                for i, (ct, _) in enumerate(chapters, 1)
            )
            + "</navMap></ncx>",
        )
        manifest_imgs = "".join(
            f'<item id="img{pno + 1}" href="img/page{pno + 1:04d}.jpg" media-type="image/jpeg"/>' for pno, _ in images
        )
        z.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0" encoding="utf-8"?>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f'<dc:identifier id="bookid">urn:uuid:ebm-{abs(hash(title)) % (10**12)}</dc:identifier>'
            f"<dc:title>{escape(title)}</dc:title><dc:language>zh</dc:language>"
            + (f"<dc:creator>{escape(author)}</dc:creator>" if author else "")
            + '</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
            '<item id="css" href="style.css" media-type="text/css"/>'
            + "".join(f'<item id="c{i}" href="{cname(i)}" media-type="application/xhtml+xml"/>' for i in range(1, len(chapters) + 1))
            + manifest_imgs
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
        doc = pymupdf.open(pdf)
        page_count = doc.page_count
        content, text_pages, image_pages = build_content(doc)
        chars = sum(len(i[1]) for i in content if i[0] in ("h", "p"))
        if not content:
            print(json.dumps({"kind": "error", "pages": page_count, "error": "PDF 没有可提取的内容"}))
            return 0
        chapters = split_chapters(content)
        images = [(item[1], item[2]) for item in content if item[0] == "img"]
        # 分类：无图片页 → text；有图片页 → hybrid；几乎无文字 → 图片版（内容仍完整保留）
        if image_pages == 0:
            kind = "text"
        elif text_pages <= max(1, page_count // 20):
            kind = "scanned-images"
        else:
            kind = "hybrid"
        write_epub(out, title, author, chapters, images)
        print(
            json.dumps(
                {
                    "kind": kind,
                    "pages": page_count,
                    "textPages": text_pages,
                    "imagePages": image_pages,
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
