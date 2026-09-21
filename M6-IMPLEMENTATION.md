# M6 · 打包发布实施记录

**日期**: 2026-09-22
**状态**: ✅ 已完成基础构建，⏳ 待配置真实签名与公证

---

## 1. macOS 分别构建（M6-1）✅

### 构建产物

| 架构 | DMG 路径 | 大小 |
|------|---------|------|
| Apple Silicon (arm64) | `target/aarch64-apple-darwin/release/bundle/dmg/Vela_0.0.1_aarch64.dmg` | 23MB |
| Intel (x86_64) | `target/x86_64-apple-darwin/release/bundle/dmg/Vela_0.0.1_x64.dmg` | 23MB |

### 关键配置

**tauri.conf.json**:
```json
{
  "bundle": {
    "targets": ["app", "dmg"],
    "macOS": {
      "signingIdentity": "-"
    }
  }
}
```

### 已知问题

1. **Tauri 2.x 的 DMG 打包脚本失败**：`bundle_dmg.sh` 需要参数但 Tauri 未正确传递
   - **解决方案**：手动使用 `hdiutil create` 创建 DMG

2. **x86_64 目标编译失败**：Homebrew 安装的 rustc 找不到 x86_64 std 库
   - **解决方案**：使用 rustup 管理的 rustc：
     ```bash
     export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
     ```

---

## 2. 自动更新配置（M6-2）✅

### 客户端配置

**src-tauri/Cargo.toml**:
```toml
[dependencies]
tauri-plugin-updater = "2"
```

**src-tauri/src/lib.rs**:
```rust
.plugin(tauri_plugin_updater::UpdaterBuilder::new().build())
```

**src-tauri/tauri.conf.json**:
```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVk...",
      "endpoints": [
        "https://vela-updates.example.com/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

### 更新服务器

**Cloudflare Worker** (`deploy/updater-worker/index.ts`):
- 路由：`GET /:target/:arch/:currentVersion`
- 从 R2 读取 `latest.json` 版本元数据
- 返回 Tauri updater 期望的 JSON 格式

**发布脚本** (`deploy/publish-to-r2.sh`):
```bash
./publish-to-r2.sh 0.1.0 "修复字体渲染问题"
```

功能：
1. 上传两个架构的 DMG 到 R2
2. 计算 SHA-512 校验和
3. 生成版本元数据 JSON
4. 更新 `latest.json`

### 前端 API

**src/ipc/updater.ts**:
```typescript
import { checkForUpdates, downloadInstallAndRelaunch } from '@/ipc/updater'

// 检查更新
const result = await checkForUpdates()
if (result.hasUpdate) {
  console.log(`发现新版本: ${result.info?.version}`)
}

// 一键更新
await downloadInstallAndRelaunch()
```

---

## 3. 签名与公证（M6-3）⏳

### 当前状态

- ✅ 使用自签名证书（`"signingIdentity": "-"`）完成测试构建
- ⏳ 等待用户提供 Apple Developer ID 进行正式签名

### 正式签名步骤（待执行）

1. **获取证书**：
   ```bash
   # 在 Apple Developer Portal 创建 "Developer ID Application" 证书
   # 导出为 .p12 文件并导入钥匙串
   ```

2. **配置环境变量**：
   ```bash
   export APPLE_CERTIFICATE="Developer ID Application: Your Name (XXXXX)"
   export APPLE_ID="your@apple.id"
   export APPLE_PASSWORD="app-specific-password"
   export APPLE_TEAM_ID="TEAMID123"
   ```

3. **更新 tauri.conf.json**：
   ```json
   {
     "bundle": {
       "macOS": {
         "signingIdentity": "Developer ID Application: Your Name (XXXXX)",
         "entitlements": "entitlements.plist"
       }
     }
   }
   ```

4. **公证流程**：
   ```bash
   # Tauri 会自动调用 notarytool
   pnpm tauri build --target aarch64-apple-darwin
   ```

### 公证所需 entitlements

创建 `src-tauri/entitlements.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
```

---

## 4. 下一步行动

### 立即可做

1. **测试本地 DMG**：
   ```bash
   open target/aarch64-apple-darwin/release/bundle/dmg/Vela_0.0.1_aarch64.dmg
   ```

2. **部署 Cloudflare Worker**：
   ```bash
   cd deploy/updater-worker
   wrangler login
   wrangler deploy
   ```

3. **创建 R2 Bucket**：
   - 在 Cloudflare Dashboard 创建 `vela-updates` bucket
   - 配置公开访问权限

### 阻塞项（需用户决策）

1. **是否申请 Apple Developer Program**（$99/年）
   - 无证书无法公证，用户首次打开会看到"无法验证开发者"警告

2. **更新服务器的域名**
   - 当前配置为 `vela-updates.example.com`
   - 需要替换为实际的 Cloudflare Worker URL

3. **公钥生成**
   - 当前 pubkey 是占位符
   - 需要使用 `tauri signer generate` 生成真正的密钥对

---

## 5. 参考文档

- [Tauri v2 Bundling Guide](https://v2.tauri.app/reference/config/#bundleconfig)
- [Tauri Updater Plugin](https://crates.io/crates/tauri-plugin-updater)
- [Cloudflare R2 Pricing](https://www.cloudflare.com/products/r2/) ($0.015/GB/月)
- [Apple Notarization Requirements](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
