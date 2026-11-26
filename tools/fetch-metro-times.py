#!/usr/bin/env python3
"""
从成都轨道集团官网抓「首末班车时刻表」，写回 app/assets/index.html 里的 metroData。

数据来源：
    https://www.chengdurail.com/op/station-time
这个接口就是官网「乘客服务 → 首末班车时刻表」页面（ckfw/smbcskb.htm）
背后的数据源，由 js/staCheck.js 拉取渲染。官方发布，带每个方向、每个站的首末班时间。

用法：
    python3 tools/fetch-metro-times.py            # 抓取并写回
    python3 tools/fetch-metro-times.py --dry-run   # 只打印，不改文件

写回的数据结构（每条线路新增 times 字段）：
    "times": [
      {"dir": "科学城", "first": "06:10", "last": "22:50"},
      {"dir": "韦家碾", "first": "06:10", "last": "22:50"}
    ]
dir 是「往哪个方向」，即乘客在站台上看到的终点方向。
first/last 取该方向起点站的首班车 / 末班车发车时间（官网 per-station 数据的首站）。
环线（from == to）没有两个方向，合并成一条 "全线"，取所有站里最早的首班和最晚的末班。
"""

import argparse
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_PATH = os.path.join(ROOT, "app", "assets", "index.html")
API = "https://www.chengdurail.com/op/station-time"

# 我们自己的线路 id → 官网的 lineNo
LINE_NO = {
    "1": "01", "2": "02", "3": "03", "4": "04", "5": "05", "6": "06",
    "7": "07", "8": "08", "9": "09", "10": "10", "13": "13", "17": "17",
    "18": "18", "19": "19", "27": "27", "30": "30", "S3": "S3",
    "T2": "101", "T2B": "102",
}
# 官网没有的都江堰 M-TR 专线，跳过
SKIP = {"M-TR"}


def fetch():
    req = urllib.request.Request(API, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.chengdurail.com/ckfw/smbcskb.htm",
        "Accept": "application/json",
    })
    raw = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")
    data = json.loads(raw)
    if data.get("code") not in (0, "0", 200, "200", None):
        raise SystemExit(f"接口返回异常：code={data.get('code')} msg={data.get('msg')}")
    return data["data"]


def station_times(sub):
    """某个方向：起点站的首班车/末班车发车时间。"""
    st = sub.get("stationList") or []
    if not st:
        return None
    origin = st[0]
    first = (origin.get("startTime") or "").strip()
    last = (origin.get("endTime") or "").strip()
    if not first or first in ("--", "--:--"):
        return None
    return {"first": first, "last": last}


def build_times(line, official):
    """按 from/to 从官网方向里挑出「往 to」和「往 from」两条。"""
    subs = [s for s in (official.get("subLine") or []) if s.get("stationList")]
    if not subs:
        return None
    frm, to = line.get("from", ""), line.get("to", "")

    # 环线：方向就是绕圈，官网切成两段，取全线最早首班、最晚末班
    if frm and frm == to:
        firsts, lasts = [], []
        for s in subs:
            for st in s["stationList"]:
                a = (st.get("startTime") or "").strip()
                b = (st.get("endTime") or "").strip()
                if a and a not in ("--",):
                    firsts.append(a)
                if b and b not in ("--",):
                    lasts.append(b)
        if not firsts:
            return None
        return [{"dir": "全线", "first": min(firsts), "last": max(lasts)}]

    out = []

    def pick(desc_exact, suffix, prefix):
        for s in subs:
            if s.get("description") == desc_exact:
                return s
        for s in subs:
            if s.get("description", "").endswith(suffix):
                return s
        for s in subs:
            if s.get("description", "").startswith(prefix):
                return s
        return None

    # 往 to 方向：优先精确 "from-to"
    s1 = pick(f"{frm}-{to}", f"-{to}", f"{frm}-")
    if s1:
        t = station_times(s1)
        if t:
            out.append({"dir": to, **t})
    # 往 from 方向：优先精确 "to-from"
    s2 = pick(f"{to}-{frm}", f"-{frm}", f"{to}-")
    if s2 and s2 is not s1:
        t = station_times(s2)
        if t:
            out.append({"dir": frm, **t})
    return out or None


def load_html():
    with open(HTML_PATH, encoding="utf-8") as f:
        return f.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不改文件")
    args = ap.parse_args()

    official = {o["lineNo"]: o for o in fetch()}
    html = load_html()
    m = re.search(r'(<script type="application/json" id="metroData">)(.*?)(</script>)', html, re.S)
    if not m:
        raise SystemExit("index.html 里找不到 metroData")
    data = json.loads(m.group(2))

    changed = 0
    for line in data["lines"]:
        lid = line["id"]
        if lid in SKIP:
            line.pop("times", None)
            print(f"  {lid:<4} {line['name'][:22]:<24} 官网无此线，跳过")
            continue
        no = LINE_NO.get(lid)
        if not no or no not in official:
            print(f"  {lid:<4} {line['name'][:22]:<24} 官网找不到 lineNo={no}")
            continue
        times = build_times(line, official[no])
        if not times:
            print(f"  {lid:<4} {line['name'][:22]:<24} 没解析出首末班")
            continue
        old = line.get("times")
        if old != times:
            changed += 1
        line["times"] = times
        desc = " / ".join(f"往{t['dir']} {t['first']}–{t['last']}" for t in times)
        print(f"  {lid:<4} {line['name'][:22]:<24} {desc}")

    print(f"\n共 {len(data['lines'])} 条线路，{changed} 条有变化")
    if args.dry_run:
        print("（--dry-run，未写文件）")
        return 0

    out = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html[:m.start(2)] + out + html[m.end(2):])
    print(f"已写回 {HTML_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
