// jobs.test.js —— 全局任务互斥锁（下载管道与元数据任务必须串行，防止互相覆盖数据）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { currentJob, isBusy, tryAcquire, release } = require("../dist/jobs.js");

test("互斥锁：同一时间只能有一个任务持锁", () => {
  release();
  assert.equal(isBusy(), false);
  assert.equal(currentJob(), null);
  assert.equal(tryAcquire("metadata:enrich"), true);
  assert.equal(currentJob(), "metadata:enrich");
  assert.equal(isBusy(), true);
  assert.equal(tryAcquire("pipeline"), false, "第二个任务必须拿不到锁");
  assert.equal(currentJob(), "metadata:enrich", "持有者不变");
  release();
  assert.equal(isBusy(), false);
  assert.equal(tryAcquire("pipeline"), true, "释放后可再次获取");
  release();
});

test("外部元数据进程检测：只认真正在跑的 python 脚本进程", () => {
  const { detectMetaProcess } = require("../dist/metadata.js");
  const yes = [
    "/opt/homebrew/Cellar/python@3.14/3.14.8/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python -u meta_enrich.py --source all",
    "/usr/bin/python3 /opt/books/yabook_watch/meta_build.py",
  ];
  const no = [
    // shell 包装进程、grep/tail 管道、调试命令——曾造成误报的真实形态
    "bash -c cd /x && nohup python3 -u meta_enrich.py --source all > /tmp/enrich_full2.log 2>&1 & sleep 50; tail -4 /tmp/enrich_full2.log",
    "grep -c meta_enrich.py /tmp/log",
    "pgrep -fl meta_(enrich|build)\\.py",
    "tail -12 /tmp/enrich_full2.log",
    "COMMAND",
    "node /opt/books/ebm/dist/server.js",
  ];
  for (const l of yes) assert.equal(detectMetaProcess(l), true, `应识别为运行中：${l.slice(0, 60)}`);
  for (const l of no) assert.equal(detectMetaProcess(l), false, `不应误报：${l.slice(0, 60)}`);
});
