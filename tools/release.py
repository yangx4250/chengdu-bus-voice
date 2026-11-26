#!/usr/bin/env python3
"""
一键发版：编译 → 测试 → 提交 → 推 GitHub + Gitee → 两边建 Release → 传 APK → 校验

用法：
    ./tools/release.py 1.3.2 "标题" --notes-file notes.md
    ./tools/release.py 1.3.2 "标题" --notes "一段说明"
    ./tools/release.py --check-only          # 只检查环境与配置

凭据从环境变量读，不写进代码、不落盘：
    export GITHUB_TOKEN=ghp_xxx
    export GITEE_TOKEN=xxxxx

设计要点（都是踩过坑后定下来的）：
  1. versionCode 是自增序号，versionName 是语义版本 —— 发版时 versionCode 自动 +1；
  2. APK 在两边的文件名都用 chengdu-bus-latest.apk，配合 releases/latest
     固定地址，App 里的下载链接永远不用改；
  3. 传完必须回读校验 md5 —— 上传"成功"但文件损坏的情况真发生过；
  4. GitHub 和 Gitee 任一失败都不回滚另一方，但在最后明确报告哪边没成。
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GH_OWNER_REPO = "yangx4250/chengdu-bus-voice"
GT_OWNER_REPO = "yangxiao436426/chengdu-bus-voice"
GT_USER = "yangxiao436426"   # Gitee 的 https 推送需要「用户名:token@」，
                             # 只给 token 会被 git 当成密码去交互询问，无终端就失败
APK_ASSET_NAME = "chengdu-bus-latest.apk"
APK_BUILD_PATH = os.path.join(ROOT, "build", "公交来了.apk")
APK_PHONE_DIR = "/sdcard/Download/DSH-Go"


# ---------------------------------------------------------------- 基础工具

def run(cmd, cwd=None, check=True, env=None, capture=True):
    """跑一条命令，失败时把输出打出来。"""
    p = subprocess.run(cmd, cwd=cwd or ROOT, shell=isinstance(cmd, str),
                       capture_output=capture, text=True, env=env)
    if check and p.returncode != 0:
        out = (p.stdout or "") + (p.stderr or "")
        die(f"命令失败：{cmd}\n{out[-1500:]}")
    return p


def die(msg):
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg):
    print(f"✓ {msg}")


def step(n, total, msg):
    print(f"\n== {n}/{total} {msg}")


def http_json(url, method="GET", body=None, token=None, timeout=90, retries=3):
    """发 JSON 请求，返回 (status, 解析后的对象或错误文本)。

    5xx 会重试 —— GitHub 的建 Release 接口实测会返回 500 且响应体为空，
    隔几秒重试就成功（服务端瞬时故障，不是我们的请求有问题）。
    """
    data = json.dumps(body).encode() if body is not None else None
    last = (None, "")
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "User-Agent": "cdbus-release",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        })
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            txt = e.read().decode()[:500]
            last = (e.code, txt)
            if e.code >= 500 and attempt < retries - 1:
                print(f"   ⚠ {e.code}，{6 * (attempt + 1)} 秒后重试…")
                time.sleep(6 * (attempt + 1))
                continue
            return last
        except Exception as e:
            last = (None, str(e)[:300])
            if attempt < retries - 1:
                time.sleep(4)
                continue
            return last
    return last


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def download_md5(url, timeout=180, attempts=3):
    """从公开地址下载并算 md5，用于上传后校验。

    GitHub 的下载 CDN 偶尔会连续几十秒不响应（实测一次发版整体从 120 秒
    涨到 394 秒），单次超时会造成「假失败」。所以重试几次，
    并把「超时」和「md5 不符」分开报告 —— 两者含义完全不同。
    """
    last = ""
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={"User-Agent": "cdbus-release"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                h = hashlib.md5()
                while True:
                    chunk = r.read(1 << 16)
                    if not chunk:
                        break
                    h.update(chunk)
                return h.hexdigest()
        except Exception as e:
            last = str(e)[:80]
            if attempt < attempts:
                print(f"   ⚠ 下载校验第 {attempt} 次失败（{last}），重试…")
                time.sleep(5)
    return f"ERR:{last}"


# ------------------------------------------------------------ 版本与构建

def read_manifest():
    path = os.path.join(ROOT, "app", "AndroidManifest.xml")
    with open(path, encoding="utf-8") as f:
        return f.read(), path


def bump_manifest(version_name):
    """把 versionName 改成给定值，versionCode 自增 1。"""
    text, path = read_manifest()
    m_code = re.search(r'android:versionCode="(\d+)"', text)
    m_name = re.search(r'android:versionName="([^"]+)"', text)
    if not m_code or not m_name:
        die("AndroidManifest.xml 里找不到 versionCode / versionName")
    old_code, old_name = int(m_code.group(1)), m_name.group(1)
    if old_name == version_name:
        # 上次发版中途失败会留下已经改好的版本号 —— 这种情况允许继续
        ok(f"版本号已是 {version_name}({old_code})，沿用（继续发版）")
        return version_name, old_code, old_name
    new_code = old_code + 1
    text = text.replace(f'android:versionCode="{old_code}"', f'android:versionCode="{new_code}"')
    text = text.replace(f'android:versionName="{old_name}"', f'android:versionName="{version_name}"')
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    ok(f"版本 {old_name}({old_code}) → {version_name}({new_code})")
    return version_name, new_code, old_name


def build_apk():
    """调 build-apk.sh（如果没有合适的工具链会报错）。"""
    script = os.path.join(ROOT, "build-apk.sh")
    if not os.path.exists(script):
        die("缺少 build-apk.sh")
    print("   编译中…（约 30 秒）")
    p = run(["bash", script], check=False)
    if p.returncode != 0:
        out = (p.stdout or "") + (p.stderr or "")
        die(f"构建失败：\n{out[-2000:]}")
    if not os.path.exists(APK_BUILD_PATH):
        die(f"构建完成但找不到产物：{APK_BUILD_PATH}")
    ok(f"APK 已生成：{os.path.getsize(APK_BUILD_PATH)} 字节")


def run_tests(attempts=2):
    """两套测试都要过。

    冒烟测试打的是车来了真实接口，偶发会返回 status 01（限流/服务端抖动）。
    这种情况重跑一次通常就过，不该因此让整个发版失败 ——
    但也不能无限重试掩盖真问题，所以最多试 2 次。
    """
    for name, cmd in [("冒烟测试", ["node", "test/smoke.mjs"]),
                      ("界面测试", ["node", "test/ui-smoke.mjs"])]:
        for attempt in range(1, attempts + 1):
            print(f"   {name}…" + (f"（第 {attempt} 次）" if attempt > 1 else ""))
            p = run(cmd, check=False)
            out = (p.stdout or "") + (p.stderr or "")
            if p.returncode == 0:
                m = re.search(r"全部通过：(\d+) 项", out)
                ok(f"{name}通过" + (f"（{m.group(1)} 项）" if m else ""))
                break
            if attempt < attempts:
                print(f"   ⚠ {name}失败，可能接口偶发限流，重试…")
                time.sleep(5)
        else:
            die(f"{name}连续 {attempts} 次未通过：\n{out[-1500:]}")
    ok("测试全部通过")


# ---------------------------------------------------------------- 发布

def git_commit_push(version_name, gh_token, gt_token):
    """提交、打 tag、推两边。"""
    run(["git", "add", "-A"])
    st = run(["git", "status", "--porcelain"], check=False).stdout.strip()
    if st:
        run(["git", "commit", "-m", f"v{version_name} 发版"])
        ok("已提交")
    else:
        ok("没有需要提交的改动")

    tag = f"v{version_name}"
    exists = run(["git", "tag", "-l", tag], check=False).stdout.strip()
    if not exists:
        run(["git", "tag", tag])
        ok(f"已打 tag {tag}")

    # GitHub
    gh_url = f"https://x-access-token:{gh_token}@github.com/{GH_OWNER_REPO}.git"
    p = run(["git", "push", gh_url, "main", "--tags"], check=False)
    if p.returncode != 0:
        print(f"   ⚠ GitHub 推送失败：{(p.stderr or '')[-300:]}")
    else:
        ok("已推 GitHub")

    # Gitee：先推分支（必须成功），tag 单独推（可能已由 Release 自动创建，不算失败）
    gt_url = f"https://{GT_USER}:{gt_token}@gitee.com/{GT_OWNER_REPO}.git"
    p = run(["git", "push", gt_url, "main"], check=False)
    if p.returncode != 0:
        print(f"   ⚠ Gitee 分支推送失败：{(p.stderr or '')[-300:]}")
    else:
        ok("已推 Gitee 分支")
    p = run(["git", "push", gt_url, "tag", tag], check=False)
    err = (p.stderr or "") + (p.stdout or "")
    if p.returncode != 0:
        if "already exists" in err or "已存在" in err:
            ok(f"tag {tag} 在 Gitee 已存在（Release 自动创建）")
        else:
            print(f"   ⚠ Gitee tag 推送失败：{err[-200:]}")
    else:
        ok(f"已推 tag {tag} 到 Gitee")


def release_github(version_name, title, notes, token):
    tag = f"v{version_name}"
    base = f"https://api.github.com/repos/{GH_OWNER_REPO}/releases"
    st, ex = http_json(f"{base}/tags/{tag}", token=token)
    if st == 200 and isinstance(ex, dict):
        rid = ex["id"]
        ok(f"GitHub Release 已存在（id={rid}）")
    else:
        st, out = http_json(base, "POST", {
            "tag_name": tag, "name": title, "body": notes,
            "draft": False, "prerelease": False,
        }, token=token)
        if st not in (200, 201):
            die(f"GitHub 建 Release 失败：HTTP {st} {out}")
        rid = out["id"]
        ok(f"GitHub Release 已创建（id={rid}）")

    # 先删同名旧附件（重发时避免两个同名文件）
    st, assets = http_json(f"{base}/{rid}/assets", token=token)
    if st == 200 and isinstance(assets, list):
        for a in assets:
            if a.get("name") == APK_ASSET_NAME:
                http_json(f"{base}/{rid}/assets/{a['id']}", "DELETE", token=token)

    data = open(APK_BUILD_PATH, "rb").read()
    url = (f"https://uploads.github.com/repos/{GH_OWNER_REPO}/releases/{rid}"
           f"/assets?name={urllib.parse.quote(APK_ASSET_NAME)}")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Authorization": f"Bearer {token}", "User-Agent": "cdbus-release",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/vnd.android.package-archive",
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            out = json.loads(r.read())
        ok(f"GitHub 上传成功（{out.get('size')} 字节）")
        return out.get("browser_download_url", "")
    except urllib.error.HTTPError as e:
        die(f"GitHub 上传失败：{e.code} {e.read().decode()[:300]}")
    except Exception as e:
        die(f"GitHub 上传失败：{e}")


def release_gitee(version_name, title, notes, token):
    tag = f"v{version_name}"
    R = GT_OWNER_REPO
    api = "https://gitee.com/api/v5"

    # 查是否已有
    st, rels = http_json(f"{api}/repos/{R}/releases?page=1&per_page=20",
                         token=token)
    rid = None
    if st == 200 and isinstance(rels, list):
        for r in rels:
            if r.get("tag_name") == tag:
                rid = r["id"]
                ok(f"Gitee Release 已存在（id={rid}）")
                break

    if rid is None:
        data = urllib.parse.urlencode({
            "access_token": token, "tag_name": tag, "name": title,
            "body": notes, "target_commitish": "main", "prerelease": "false",
        }).encode()
        req = urllib.request.Request(f"{api}/repos/{R}/releases", data=data,
                                     method="POST", headers={
            "User-Agent": "cdbus-release",
            "Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                out = json.loads(r.read())
            rid = out["id"]
            ok(f"Gitee Release 已创建（id={rid}）")
        except urllib.error.HTTPError as e:
            die(f"Gitee 建 Release 失败：{e.code} {e.read().decode()[:300]}")
        except Exception as e:
            die(f"Gitee 建 Release 失败：{e}")

    # 上传附件（multipart）
    data = open(APK_BUILD_PATH, "rb").read()
    boundary = "----cdbus" + uuid.uuid4().hex
    parts = []
    parts.append((f"--{boundary}\r\nContent-Disposition: form-data; "
                  f'name="access_token"\r\n\r\n{token}\r\n').encode())
    parts.append((f"--{boundary}\r\nContent-Disposition: form-data; "
                  f'name="file"; filename="{APK_ASSET_NAME}"\r\n'
                  "Content-Type: application/vnd.android.package-archive\r\n\r\n").encode())
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        f"{api}/repos/{R}/releases/{rid}/attach_files", data=body, method="POST",
        headers={"User-Agent": "cdbus-release",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            out = json.loads(r.read())
        ok(f"Gitee 上传成功（{out.get('size')} 字节）")
        return out.get("browser_download_url", "")
    except urllib.error.HTTPError as e:
        die(f"Gitee 上传失败：{e.code} {e.read().decode()[:300]}")
    except Exception as e:
        die(f"Gitee 上传失败：{e}")


def verify_download(name, url, local_md5):
    """回读校验：下载地址拿到的字节必须和本地一致。"""
    if not url:
        print(f"   ⚠ {name} 没拿到下载地址，跳过校验")
        return False
    print(f"   校验 {name}…")
    remote = download_md5(url)
    if remote == local_md5:
        ok(f"{name} 校验通过（md5 {local_md5}）")
        return True
    if str(remote).startswith("ERR:"):
        print(f"   ⚠ {name} 下载校验没跑通（网络问题，非文件错误）：{remote[4:]}")
    else:
        print(f"   ⚠ {name} md5 真的不一致：远端 {remote} / 本地 {local_md5}")
    return False


def deploy_to_phone(version_name, local_md5):
    """复制到手机下载目录，并删掉旧包。"""
    if not os.path.isdir(os.path.dirname(APK_PHONE_DIR)):
        print("   跳过：没有 /sdcard（不在手机上运行）")
        return
    try:
        os.makedirs(APK_PHONE_DIR, exist_ok=True)
        dest = os.path.join(APK_PHONE_DIR, f"公交来了-{version_name}.apk")
        shutil.copy2(APK_BUILD_PATH, dest)
        # 删掉除新包外的旧 apk
        for f in os.listdir(APK_PHONE_DIR):
            if f.startswith("公交来了-") and f.endswith(".apk") and f != os.path.basename(dest):
                os.remove(os.path.join(APK_PHONE_DIR, f))
        got = md5_of(dest)
        if got != local_md5:
            print(f"   ⚠ 手机上的文件 md5 不一致：{got}")
        else:
            ok(f"已部署到 {dest}")
    except Exception as e:
        print(f"   ⚠ 部署到手机失败：{e}")


# ---------------------------------------------------------------- 主流程

def check_env(need_tokens=True):
    """检查运行环境。"""
    problems = []
    if not os.path.exists(os.path.join(ROOT, "app", "AndroidManifest.xml")):
        problems.append("不在项目根目录（找不到 app/AndroidManifest.xml）")
    for tool in ["git", "node", "javac"]:
        if not shutil.which(tool):
            problems.append(f"缺少 {tool}")
    if need_tokens:
        if not os.environ.get("GITHUB_TOKEN"):
            problems.append("没有 GITHUB_TOKEN 环境变量")
        if not os.environ.get("GITEE_TOKEN"):
            problems.append("没有 GITEE_TOKEN 环境变量")
    return problems


def main():
    ap = argparse.ArgumentParser(description="一键发版：GitHub + Gitee 同时发布")
    ap.add_argument("version", nargs="?", help="新的 versionName，如 1.3.2")
    ap.add_argument("title", nargs="?", help="Release 标题")
    ap.add_argument("--notes", default="", help="Release 说明（短文本）")
    ap.add_argument("--notes-file", help="从文件读 Release 说明")
    ap.add_argument("--check-only", action="store_true", help="只检查环境")
    ap.add_argument("--skip-tests", action="store_true", help="跳过测试（不推荐）")
    args = ap.parse_args()

    if args.check_only:
        print("环境检查：")
        probs = check_env(need_tokens=False)
        for p in probs:
            print(f"  ✗ {p}")
        if not probs:
            ok("环境正常")
        gh = os.environ.get("GITHUB_TOKEN", "")
        gt = os.environ.get("GITEE_TOKEN", "")
        print(f"\n  GITHUB_TOKEN: {'已设置' if gh else '未设置'}"
              f"（{len(gh)} 字符）")
        print(f"  GITEE_TOKEN : {'已设置' if gt else '未设置'}"
              f"（{len(gt)} 字符）")
        return 0 if not probs else 1

    if not args.version or not args.title:
        ap.print_help()
        die("需要 version 和 title")

    if not re.match(r"^\d+\.\d+\.\d+$", args.version):
        die(f"版本号要写成 x.y.z：{args.version}")

    gh_token = os.environ.get("GITHUB_TOKEN", "")
    gt_token = os.environ.get("GITEE_TOKEN", "")
    probs = check_env()
    if probs:
        for p in probs:
            print(f"  ✗ {p}")
        die("环境不满足，先修上面的问题")

    notes = args.notes
    if args.notes_file:
        with open(args.notes_file, encoding="utf-8") as f:
            notes = f.read()
    if not notes:
        notes = f"v{args.version}"

    total = 7
    started = time.time()

    step(1, total, f"改版本号 → {args.version}")
    version_name, version_code, old_name = bump_manifest(args.version)

    step(2, total, "构建 APK")
    build_apk()
    local_md5 = md5_of(APK_BUILD_PATH)
    apk_size = os.path.getsize(APK_BUILD_PATH)
    ok(f"md5 {local_md5}")

    if not args.skip_tests:
        step(3, total, "跑测试")
        run_tests()
    else:
        step(3, total, "跳过测试（--skip-tests）")

    step(4, total, "提交并推送")
    git_commit_push(version_name, gh_token, gt_token)

    step(5, total, "建 Release 并上传 APK")
    gh_url = release_github(version_name, args.title, notes, gh_token)
    gt_url = release_gitee(version_name, args.title, notes, gt_token)

    step(6, total, "回读校验")
    ok_gh = verify_download("GitHub", gh_url, local_md5)
    ok_gt = verify_download("Gitee", gt_url, local_md5)

    step(7, total, "部署到手机")
    deploy_to_phone(version_name, local_md5)

    # ---- 总结
    print("\n" + "=" * 56)
    print(f"发版完成：v{version_name}（versionCode {version_code}）")
    print(f"APK：{apk_size} 字节 / md5 {local_md5}")
    print(f"耗时：{int(time.time() - started)} 秒")
    print("-" * 56)
    print(f"GitHub：{'✓ 校验通过' if ok_gh else '⚠ 未通过或跳过'}")
    if gh_url:
        print(f"  {gh_url}")
    print(f"Gitee ：{'✓ 校验通过' if ok_gt else '⚠ 未通过或跳过'}")
    if gt_url:
        print(f"  {gt_url}")
    print("=" * 56)
    if not (ok_gh and ok_gt):
        print("\n⚠ 有源没通过校验，建议手动复查后再通知用户更新")
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(130)