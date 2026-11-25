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
