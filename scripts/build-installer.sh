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
    echo ""
    echo "✔ 产物："
    ls -d "$OUT"/macos/*.app "$OUT"/dmg/*.dmg
    cat <<'EOF'

内部分发提示（ad-hoc 签名，无 Apple 证书）：
  同事首次打开会被 Gatekeeper 拦，二选一：
    1. 右键 App → 打开 → 确认（一次性）
    2. xattr -cr /Applications/Vela.app
EOF
    ;;
  *)
    echo "✘ 本机是 $OS，此脚本只支持 macOS 打包。Windows 请用 release-build.yml 工作流。" >&2
    exit 1
    ;;
esac
