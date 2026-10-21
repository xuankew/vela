#!/usr/bin/env bash
# 本地构建 Vela 安装包（macOS）。Windows 包无法在 mac 上交叉编译，
# 走 .github/workflows/release-build.yml 手动触发。
#
# 用法: scripts/build-installer.sh [--with-updater-artifacts]
#
# --config 覆盖 createUpdaterArtifacts：本项目没有 minisign 私钥（~/.tauri 为空），
# 开着它 tauri build 会在签名 updater 产物那一步直接失败。
# 需要产出自动更新包时传 --with-updater-artifacts，并先设好
# TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD。
set -euo pipefail
cd "$(dirname "$0")/.."

# ⚠️ 这里用裸 `pnpm` 而不是 `corepack pnpm`：corepack 0.34 的 `corepack pnpm <cmd>`
# 子命令永远以全局钉的版本（11.x）启动、不随项目 packageManager 切换，而它再起的
# beforeBuildCommand `pnpm build` 会被 pnpm 自己的 10.18.1 版本检查拒掉。
# 裸 pnpm 是 corepack shim，会按 packageManager 字段逐项目切版本。

UPDATER=false
[[ "${1:-}" == "--with-updater-artifacts" ]] && UPDATER=true

OS=$(uname -s)
case "$OS" in
  Darwin)
    echo "▶ 构建 macOS 安装包 (.app + .dmg)"
    if [[ $UPDATER == true ]]; then
      CONFIG='{"bundle":{"createUpdaterArtifacts":true}}'
    else
      CONFIG='{"bundle":{"createUpdaterArtifacts":false}}'
    fi
    pnpm tauri build --config "$CONFIG"
    # ⚠️ 产物在仓库根的 target/ 而不是 src-tauri/target/：Cargo workspace 声明在
    # 根 Cargo.toml（members 含 src-tauri 与 crates/vela-core），target 目录归 workspace
    OUT=target/release/bundle
    APP=$OUT/macos/Vela.app

    # 装到 /Applications，然后删掉 target 下的构建副本：磁盘上只留一个 Vela.app。
    # 不这么做的话 Spotlight 搜 "vela" 会同时搜出 /Applications 一份、target/release 一份、
    # 外加挂载中的 dmg 里一份——三个图标，分不清哪个是刚构建的（2026-10-20 用户定的口径）。
    #
    # ⚠️ 只替换 .app 本体，**绝不碰** ~/Library/Application Support/app.vela.m1/：
    # 那里放着会话存档（含未保存草稿）。重装丢配置是这类脚本最容易被骂的一种失手。
    echo ""
    echo "▶ 安装到 /Applications"
    if pgrep -x vela >/dev/null 2>&1; then
      osascript -e 'quit app "Vela"' >/dev/null 2>&1 || true
      # 关窗握手可能要点时间（有未保存改动时前端会弹确认），最多等 10s
      for _ in $(seq 1 50); do pgrep -x vela >/dev/null 2>&1 || break; sleep 0.2; done
      if pgrep -x vela >/dev/null 2>&1; then
        echo "✘ Vela 还在跑（可能有未保存改动挡着关窗），请先自己退出再重跑本脚本" >&2
        exit 1
      fi
    fi
    rm -rf /Applications/Vela.app
    # ditto 而不是 cp -R：它保留签名与扩展属性，cp 会让 ad-hoc 签名失效
    ditto "$APP" /Applications/Vela.app
    rm -rf "$APP"

    echo ""
    echo "✔ 产物："
    echo "  /Applications/Vela.app（已安装，target 下的副本已删）"
    ls -d "$OUT"/dmg/*.dmg 2>/dev/null
    cat <<'EOF'

内部分发提示（ad-hoc 签名，无 Apple 开发者证书）：
  同事首次打开会被 Gatekeeper 拦，二选一：
    1. 右键 App → 打开 → 确认（一次性）
    2. xattr -cr /Applications/Vela.app
  ⛔ macOS 没有「允许未知来源」这个全局开关，别照着那句话找。
  走 AirDrop / 内网 scp 传包不带 quarantine 标记，比网盘下载少一道提示。
EOF
    ;;
  *)
    echo "✘ 本机是 $OS，此脚本只支持 macOS 打包。Windows 请用 release-build.yml 工作流。" >&2
    exit 1
    ;;
esac
