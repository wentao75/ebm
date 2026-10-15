#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回滚文件名清理：按 rename-map-*.json 把新名改回原名。

用法：
    python3 scripts/revert-rename.py                 # 干跑，只打印将要改回的文件
    python3 scripts/revert-rename.py --apply         # 真正执行
    python3 scripts/revert-rename.py --map data/rename-map-XXXX.json --apply
"""
import argparse
import glob
import json
import os
import os
import sys

ROOT = os.environ.get("EBM_LIBRARY_ROOT",
                      os.path.join(os.path.expanduser("~"),
                                   "Library/Mobile Documents/com~apple~CloudDocs/eBooks"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", help="映射文件路径（默认取 data/ 下最新一个）")
    ap.add_argument("--apply", action="store_true", help="真正执行（默认只干跑）")
    args = ap.parse_args()

    mapfile = args.map or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "rename-map-*.json")))[-1]
    mapping = json.load(open(mapfile, encoding="utf-8"))
    renames = mapping.get("renames", [])
    print(f"映射文件: {mapfile}（{len(renames)} 条，创建于 {mapping.get('created')}）")
    print("模式:", "执行" if args.apply else "干跑（加 --apply 才真正改名）")

    done = skipped = fail = 0
    for r in renames:
        new_path = os.path.join(ROOT, r["new"])
        old_path = os.path.join(ROOT, r["old"])
        if not os.path.exists(new_path):
            print(f"  跳过（新名不存在）: {r['new'][:60]}")
            skipped += 1
            continue
        if os.path.exists(old_path):
            print(f"  跳过（原名已存在）: {r['old'][:60]}")
            skipped += 1
            continue
        print(f"  还原: {os.path.basename(r['new'])}\n     →  {os.path.basename(r['old'])}")
        if args.apply:
            try:
                os.rename(new_path, old_path)
                done += 1
            except Exception as e:  # noqa: BLE001
                print(f"    失败: {e}")
                fail += 1
    print(f"[done] 还原={done} 跳过={skipped} 失败={fail}")
    if not args.apply:
        print("（干跑结束，未改动任何文件）")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
