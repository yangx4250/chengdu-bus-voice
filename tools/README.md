# 发版脚本

一键把新版本同时发到 GitHub 和 Gitee。

## 准备（一次性）

**1. 放好构建依赖**（不进仓库，已被 `.gitignore` 忽略）

```
sdk/android.jar     # Android SDK android.jar（API 33 或 34）
sdk/r8.jar          # R8，用于混淆 + dex
```

也可以改用环境变量 `ANDROID_JAR` / `R8_JAR` 指向别处。

**2. 设置 token**（只在当前 shell 生效，不落盘）

```bash
export GITHUB_TOKEN=ghp_xxx      # 需要 repo 权限
export GITEE_TOKEN=xxxxx         # 需要 projects + releases 权限
```

**3. 检查环境**

```bash
./tools/release.py --check-only
```

## 发版

```bash
# 说明写在文件里（推荐，支持 Markdown 多行）
./tools/release.py 1.3.3 "v1.3.3 修了什么" --notes-file notes.md

# 或者一段短说明
./tools/release.py 1.3.3 "v1.3.3 修了什么" --notes "简短说明"
```

## 它会做什么

| 步骤 | 内容 |
|---|---|
| 1 | versionName 改成新值，versionCode 自动 +1 |
| 2 | 调 `build-apk.sh` 编译签名 |
| 3 | 跑冒烟测试 + 界面测试，任一失败就停 |
| 4 | git 提交、打 tag、推 GitHub 和 Gitee |
| 5 | 两边建 Release，上传 `chengdu-bus-latest.apk` |
| 6 | 回读两个下载地址，比对 md5 |
| 7 | 复制到手机 `Download/DSH-Go/`，删掉旧包 |

全程约 130 秒。任一环节失败立即停止并说明原因。

## 几个约定

**APK 文件名固定为 `chengdu-bus-latest.apk`**

配合两边 release 的同名附件，App 里的下载地址永远是
`releases/latest/download/chengdu-bus-latest.apk` —— 发版不用改代码。

**tag 用 `v1.3.3` 这种格式**

App 端会把 tag 解析成 `10303` 和本地 versionName 比较，所以必须 `x.y.z`。

**中途失败可以直接重跑**

版本号已经改进去了不会重复递增；已存在的 Release 会复用；
tag 已存在（Gitee 建 Release 时自动建的）不算失败。

## 注意

- **两个仓库都要公开**，否则 App 匿名下载不到
- 签名 keystore 不能换，换了所有用户都得卸载重装
- `sdk/` 下的依赖不提交，换机器要自己准备

## 地铁数据：首末班 / 出入口

两个脚本都把结果直接写进 `app/assets/index.html` 里的 `metroData`，
数据变了重跑一次就行，不用手改那个巨大的 JSON。

```bash
# 每个方向的首班车 / 末班车（19 条线）
python3 tools/fetch-metro-times.py --dry-run
python3 tools/fetch-metro-times.py

# 各站出入口 A/B/C/D 口 + 每个口跨哪几条路（360/394 个站）
python3 tools/fetch-metro-exits.py --dry-run
python3 tools/fetch-metro-exits.py            # 全量约 20~40 分钟（官网限流）
python3 tools/fetch-metro-exits.py --offline  # 只重算，不联网，几秒
```

- 首末班来自 `https://www.chengdurail.com/op/station-time`；
- 出入口来自 `https://www.chengdurail.com/op/stations/{stationNo}` 的
  `data.entrances.roundInfo`，都是官网自己页面在用的接口；
- `<stationNo>` 从 `op/station-time` 的站点列表里取，同名换乘站只抓一次；
- **官网限流很凶**（返回 `code 1502 服务器繁忙`），脚本带重试和
  `build/metro-exits-cache.json` 磁盘缓存，中断了重跑会接着抓，不会从头再来。
  `build/` 是 gitignore 的，换机器缓存会丢。
- 有轨电车（蓉2号线、M-TR）在路面站台上下车，本来就没有编号出入口，
  界面上会单独显示一句说明，不算数据缺失。
