// meta-link.test.js —— 「按链接更新元数据」的链接解析
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseDoubanId } = require("../dist/metaLink.js");

test("parseDoubanId：支持完整链接 / 省略协议 / 裸数字 ID", () => {
  assert.equal(parseDoubanId("https://book.douban.com/subject/27107200/"), "27107200");
  assert.equal(parseDoubanId("http://book.douban.com/subject/35170843"), "35170843");
  assert.equal(parseDoubanId("book.douban.com/subject/37367267/"), "37367267");
  assert.equal(parseDoubanId("  27107200  "), "27107200");
  assert.equal(parseDoubanId("https://book.douban.com/subject/27107200/?from=tag"), "27107200");
});

test("parseDoubanId：非豆瓣链接返回 null（给出明确错误而不是乱抓）", () => {
  assert.equal(parseDoubanId(""), null);
  assert.equal(parseDoubanId("https://example.com/book/123"), null);
  assert.equal(parseDoubanId("12"), null); // 太短，不像豆瓣 subject id
  assert.equal(parseDoubanId("https://book.douban.com/tag/小说"), null);
});
