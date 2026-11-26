#!/usr/bin/env python3
"""
抓成都地铁/有轨电车各站的**出入口**（A/B/C/D 口）和各口对应的街道，写回 metroData。

数据来源：成都轨道集团官网「站点信息」接口
    GET https://www.chengdurail.com/op/station-time    → 全部线路的站点 + stationNo
    GET https://www.chengdurail.com/op/stations/{no}   → 单站详情，含
        data.entrances.roundInfo[] = [{"entry":"A","location":"北三环路三段|韦家碾路"}, ...]

这是官网自己用的接口（官网「行程查询 / 站点信息」页面调的就是它），
比 OSM 全：OSM 里新线（27/30/19 号线）几乎没有画出入口，官网每条线都齐。

用法：
    python3 tools/fetch-metro-exits.py            # 抓取并写回（约 400 个请求，几分钟）
    python3 tools/fetch-metro-exits.py --dry-run   # 只统计，不写文件
    python3 tools/fetch-metro-exits.py --limit 30  # 只抓前 30 个站，用来快速验证

写回结构（metroData 顶层新增 exits 字段，按站名索引）：
    "exits": {
      "天府广场": [["A", "人民中路一段|人民东路"], ["B", "..."], ...]
    }
location 里的 "|" 换成 " / " 由前端做，原始数据原样保存。
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_PATH = os.path.join(ROOT, "app", "assets", "index.html")
BASE = "https://www.chengdurail.com"
CACHE = os.path.join(ROOT, "build", "metro-exits-cache.json")
HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.chengdurail.com/ckfw/smbcskb.htm",
}


def norm_name(n):
    """站名归一化：去掉「·」「・」「站」和括号内容，方便和官网对上。
    例：中医大·省医院 → 中医大省医院；九眼桥站 → 九眼桥。"""
    n = re.sub(r"[（(].*?[）)]", "", str(n or ""))
    n = n.replace("·", "").replace("・", "").replace("•", "").replace(" ", "")
    if n.endswith("站") and len(n) > 2:
        n = n[:-1]
    return n.strip()


def norm_entry(entry):
    """把官网的口编号拆干净：
         "A"            → ("A", "")
         "c"            → ("C", "")               官网有大小写混用
         "D1（暂不开放）" → ("D1", "暂不开放")      括号里是状态，单独存
         "东广场"        → ("东广场", "")           成都东客站/成都西站这种大站是广场/通道
    """
    e = str(entry or "").strip()
    note = ""
    m = re.search(r"[（(](.*?)[）)]", e)
    if m:
        note = m.group(1).strip()
        e = (e[: m.start()] + e[m.end():]).strip()
    return e.upper(), note


def build_items(rounds):
    """roundInfo → [[口编号, 街道说明], …]，带状态时补第三个元素。"""
    seen = {}
    for r in rounds:
        ref, note = norm_entry(r.get("entry"))
        loc = str(r.get("location") or "").strip()
        if not ref or ref in seen:
            continue
        seen[ref] = [ref, loc] if not note else [ref, loc, note]
    items = list(seen.values())
    # A < B < B1 < B2 < C …；非字母编号（东广场/通道）排最后
    items.sort(key=lambda x: (0 if x[0][:1].isalpha() else 1, x[0][:1], len(x[0]), x[0]))
    return items


def get_json(path, attempts=8):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(BASE + path, headers=HDR)
            raw = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
            j = json.loads(raw)
            # 官网限流时返回 code 1502「服务器繁忙」
            if j.get("code") not in (0, "0"):
                last = f"code={j.get('code')} {j.get('msg')}"
                time.sleep(1.2 * (i + 1))
                continue
            return j
        except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
            last = str(e)
            time.sleep(0.6 * (i + 1))
    raise RuntimeError(f"{path} 抓取失败：{last}")


def load_metro_data():
    with open(HTML_PATH, encoding="utf-8") as f:
        html = f.read()
    m = re.search(r'(<script type="application/json" id="metroData">)(.*?)(</script>)', html, re.S)
    if not m:
        raise SystemExit("index.html 里找不到 metroData")
    return html, m, json.loads(m.group(2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--offline", action="store_true", help="只用缓存，不联网（缓存里没有的跳过）")
    args = ap.parse_args()

    html, tag, data = load_metro_data()

    # 1) 全部站点 → stationNo（同名站只取一个，详情接口一次就返回全部线路）
    listing = get_json("/op/station-time")
    wanted = {}
    for line in listing["data"]:
        for sub in line.get("subLine") or []:
            for st in sub.get("stationList") or []:
                name = (st.get("stationName") or "").strip()
                no = (st.get("stationNo") or "").strip()
                if not name or not no:
                    continue
                # 官网有的站名带「（出闸换乘）」这类后缀，去掉后再匹配
                wanted.setdefault(norm_name(name), no)
    print(f"官网站点 {len(wanted)} 个，开始逐个取出入口 …")

    # 我们的线路里实际出现的站（只抓这些，别浪费请求）
    ours = set()
    for line in data["lines"]:
        for st in line["stations"]:
            ours.add(st["name"])
    targets = []
    missing = []
    for n in sorted(ours):
        no = wanted.get(norm_name(n))
        if no:
            targets.append((n, no))
        else:
            missing.append(n)
    print(f"本地线路站点 {len(ours)} 个，官网能对上的 {len(targets)} 个")
    if missing:
        print(f"  官网没有的（跳过）：{'、'.join(missing[:8])}{' …' if len(missing) > 8 else ''}")
    if args.limit:
        targets = targets[: args.limit]

    # 2) 逐个取出入口（带磁盘缓存，中断后重跑能续上）
    cache = {}
    if os.path.exists(CACHE):
        try:
            with open(CACHE, encoding="utf-8") as f:
                cache = json.load(f)
            print(f"  命中缓存 {len(cache)} 个站")
        except Exception:
            cache = {}
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)

    exits = {}
    fails = []
    t0 = time.time()
    for i, (name, no) in enumerate(targets, 1):
        items = cache.get(no)
        if items is None and args.offline:
            continue
        if items:
            items = [[norm_entry(x[0])[0],
                      x[1] if len(x) > 1 else "",
                      norm_entry(x[0])[1] if len(x) < 3 else x[2]] for x in items]
            # 去掉空的状态位，保持紧凑
            items = [[x[0], x[1]] if not x[2] else x for x in items]
            seen = {}
            for x in items:
                seen.setdefault(x[0], x)
            items = list(seen.values())
            items.sort(key=lambda x: (0 if x[0][:1].isalpha() else 1, x[0][:1], len(x[0]), x[0]))
        if items is None:
            try:
                j = get_json(f"/op/stations/{no}")
            except RuntimeError as e:
                fails.append((name, str(e)[:80]))
                continue
            info = (j.get("data") or {}).get("entrances") or {}
            items = build_items(info.get("roundInfo") or [])
            cache[no] = items
            time.sleep(0.35)      # 别把官网打崩（限流很凶，慢一点反而快）
        if items:
            exits[name] = items
        if i % 40 == 0:
            print(f"  {i}/{len(targets)} … 已拿到 {len(exits)} 个站（{time.time() - t0:.0f}s）", flush=True)
            with open(CACHE, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)

    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)

    total = sum(len(v) for v in exits.values())
    print(f"\n有出入口数据的站 {len(exits)} / {len(targets)}"
          f"（{len(exits) * 100 // max(1, len(targets))}%）")
    print(f"出入口合计 {total} 个")
    if fails:
        print(f"抓取失败 {len(fails)} 个：{fails[:3]}")
    print("样例：")
    for n in list(exits)[:5]:
        print("  ", n, "→", " ".join(x[0] for x in exits[n]))

    payload = json.dumps(exits, ensure_ascii=False, separators=(",", ":"))
    print(f"payload 大小 {len(payload.encode('utf-8'))} 字节")

    if args.dry_run:
        print("（--dry-run，未写文件）")
        return 0

    data["exits"] = exits
    ordered = {}
    for k in ("updated", "source", "lines", "exits", "transfers"):
        if k in data:
            ordered[k] = data[k]
    for k, v in data.items():
        if k not in ordered:
            ordered[k] = v

    body = json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))
    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html[:tag.start(2)] + body + html[tag.end(2):])
    print(f"已写回 {HTML_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
