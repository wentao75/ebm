// opds.ts —— OPDS 1.2 目录（设计文档四-6）：根分类 / 分类书目 / 搜索
import { BookEntry } from "./indexer";
import { BookFile, LIBRARY_ROOT } from "./scanner";

const PAGE_BASE = process.env.EBM_PUBLIC_BASE || ""; // 反代/公网部署后设为对外地址，如 https://books.example.com
const SELF_ID = "urn:ebm:catalog";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function url(p: string): string {
  return PAGE_BASE + p;
}

function xmlHeader(id: string, selfPath: string, title: string, updated: string): string[] {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opds="http://opds-spec.org/2010/catalog">`,
    `  <id>${esc(id)}</id>`,
    `  <title>${esc(title)}</title>`,
    `  <updated>${updated}</updated>`,
    `  <link rel="self" href="${esc(url(selfPath))}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>`,
    `  <link rel="start" href="${esc(url("/opds"))}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>`,
  ];
}

function mimeOf(ext: string): string {
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".epub":
      return "application/epub+zip";
    case ".mobi":
      return "application/x-mobipocket-ebook";
    case ".azw3":
      return "application/vnd.amazon.ebook";
    case ".djvu":
      return "image/vnd.djvu";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
export { mimeOf };

/** 根导航 feed：各分类 + 搜索描述 */
export function opdsRoot(categories: Array<{ name: string; count: number }>, updated: string): string {
  const lines = xmlHeader(SELF_ID, "/opds", "ebm 家庭书库", updated);
  lines.push(
    `  <link rel="search" href="${esc(url("/opds/opensearch.xml"))}" type="application/opensearchdescription+xml"/>`,
  );
  lines.push(
    `  <entry>`,
    `    <id>urn:ebm:all</id>`,
    `    <title>全部书目</title>`,
    `    <updated>${updated}</updated>`,
    `    <content type="text">全部 ${categories.reduce((a, c) => a + c.count, 0)} 本</content>`,
    `    <link rel="subsection" href="${esc(url("/opds/category/_all"))}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    `  </entry>`,
  );
  for (const c of categories) {
    lines.push(
      `  <entry>`,
      `    <id>urn:ebm:cat:${esc(c.name)}</id>`,
      `    <title>${esc(c.name)}</title>`,
      `    <updated>${updated}</updated>`,
      `    <content type="text">${c.count} 本</content>`,
      `    <link rel="subsection" href="${esc(url("/opds/category/" + encodeURIComponent(c.name)))}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
      `  </entry>`,
    );
  }
  lines.push(`</feed>`);
  return lines.join("\n");
}

function entryXml(e: BookEntry): string {
  const fileHref = `/api/file?path=${encodeURIComponent(e.rel)}&disp=attachment`;
  const ext = "." + e.ext.toLowerCase();
  const summaryBits: string[] = [];
  if (e.douban) summaryBits.push(`豆瓣 ${e.douban}`);
  summaryBits.push(e.category, e.ext);
  const summary = e.intro
    ? `${summaryBits.join(" · ")}\n${e.intro.slice(0, 200)}`
    : summaryBits.join(" · ");
  // 封面：仅本地书提供（云端书不生成，避免 OPDS 客户端批量拉封面触发 iCloud 取回）
  const coverLink = e.dataless
    ? ""
    : `    <link rel="http://opds-spec.org/image" href="${esc(url("/api/cover?path=" + encodeURIComponent(e.rel)))}" type="image/png"/>`;
  return [
    `  <entry>`,
    `    <id>urn:ebm:book:${esc(Buffer.from(e.rel, "utf-8").toString("hex"))}</id>`,
    `    <title>${esc(e.title)}</title>`,
    `    <updated>${iso(e.mtimeMs)}</updated>`,
    e.author ? `    <author><name>${esc(e.author)}</name></author>` : "",
    `    <category term="${esc(e.category)}"/>`,
    `    <summary type="text">${esc(summary)}</summary>`,
    coverLink,
    `    <link rel="http://opds-spec.org/acquisition" href="${esc(url(fileHref))}" type="${mimeOf(ext)}"/>`,
    `  </entry>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 分类/搜索结果的 acquisition feed */
export function opdsAcquisition(
  id: string,
  selfPath: string,
  title: string,
  books: BookEntry[],
): string {
  const updated = books.length ? iso(Math.max(...books.map((b) => b.mtimeMs))) : iso(0);
  const lines = xmlHeader(id, selfPath, title, updated);
  lines.push(
    `  <link rel="search" href="${esc(url("/opds/opensearch.xml"))}" type="application/opensearchdescription+xml"/>`,
  );
  for (const b of books) lines.push(entryXml(b));
  lines.push(`</feed>`);
  return lines.join("\n");
}

export function opensearchXml(): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">`,
    `  <ShortName>ebm</ShortName>`,
    `  <Description>搜索 ebm 家庭书库</Description>`,
    `  <InputEncoding>UTF-8</InputEncoding>`,
    `  <OutputEncoding>UTF-8</OutputEncoding>`,
    `  <Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="${esc(url("/opds/search?q={searchTerms}"))}"/>`,
    `</OpenSearchDescription>`,
  ].join("\n");
}

export function contentTypeForFeed(): string {
  return "application/atom+xml;profile=opds-catalog;kind=navigation;charset=utf-8";
}

export function contentTypeForAcquisition(): string {
  return "application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8";
}

export { LIBRARY_ROOT, BookFile };
