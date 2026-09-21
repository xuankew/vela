#!/bin/bash
# Vela 发布脚本：上传 DMG 到 Cloudflare R2 并更新版本元数据
#
# 用法：./publish-to-r2.sh <version> [notes]
# 示例：./publish-to-r2.sh 0.1.0 "修复字体渲染问题"

set -euo pipefail

VERSION="${1:?请提供版本号 (例如 0.1.0)}"
NOTES="${2:-}"
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# R2 bucket 名称（需要先在 Cloudflare Dashboard 创建）
BUCKET="vela-updates"

# 检查必要的文件是否存在
ARM64_DMG="target/aarch64-apple-darwin/release/bundle/dmg/Vela_${VERSION}_aarch64.dmg"
X64_DMG="target/x86_64-apple-darwin/release/bundle/dmg/Vela_${VERSION}_x64.dmg"

if [[ ! -f "$ARM64_DMG" ]]; then
  echo "错误: 找不到 arm64 DMG: $ARM64_DMG"
  exit 1
fi

if [[ ! -f "$X64_DMG" ]]; then
  echo "错误: 找不到 x64 DMG: $X64_DMG"
  exit 1
fi

echo "📦 准备发布 Vela v${VERSION}..."

# 计算签名（Tauri updater 需要）
# 注意：这里使用简化版，生产环境应该用真正的代码签名
echo "🔐 生成文件校验和..."
ARM64_SIG=$(shasum -a 512 "$ARM64_DMG" | awk '{print $1}')
X64_SIG=$(shasum -a 512 "$X64_DMG" | awk '{print $1}')

# 上传到 R2（需要先配置 wrangler 或 rclone）
echo "⬆️  上传到 Cloudflare R2..."

# 使用 wrangler 上传（需要先运行 `wrangler login`）
wrangler r2 object put "$BUCKET/Vela_${VERSION}_aarch64.dmg" --file="$ARM64_DMG" || {
  echo "错误: wrangler 上传失败。请先运行 'wrangler login'"
  exit 1
}

wrangler r2 object put "$BUCKET/Vela_${VERSION}_x64.dmg" --file="$X64_DMG" || {
  echo "错误: wrangler 上传失败"
  exit 1
}

# 构建 public URL（需要根据你的 R2 bucket 配置调整）
PUBLIC_URL="https://pub-xxx.r2.dev/vela-updates"

# 创建版本元数据
cat > /tmp/vela-update-${VERSION}.json <<EOF
{
  "version": "${VERSION}",
  "notes": "${NOTES}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${ARM64_SIG}",
      "url": "${PUBLIC_URL}/Vela_${VERSION}_aarch64.dmg"
    },
    "darwin-x86_64": {
      "signature": "${X64_SIG}",
      "url": "${PUBLIC_URL}/Vela_${VERSION}_x64.dmg"
    }
  }
}
EOF

# 上传版本元数据
wrangler r2 object put "$BUCKET/${VERSION}.json" --file="/tmp/vela-update-${VERSION}.json"

# 更新 latest.json
wrangler r2 object put "$BUCKET/latest.json" --file="/tmp/vela-update-${VERSION}.json"

echo "✅ 发布完成！"
echo ""
echo "版本信息："
echo "  版本号: ${VERSION}"
echo "  发布时间: ${PUB_DATE}"
echo "  arm64: ${PUBLIC_URL}/Vela_${VERSION}_aarch64.dmg"
echo "  x64:   ${PUBLIC_URL}/Vela_${VERSION}_x64.dmg"
echo ""
echo "测试更新检查："
echo "  curl https://vela-updater.your-worker.workers.dev/macos/aarch64/${VERSION}"

# 清理临时文件
rm -f /tmp/vela-update-${VERSION}.json
