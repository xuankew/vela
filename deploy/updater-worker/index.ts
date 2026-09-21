/**
 * Vela 自动更新服务器
 *
 * 路由：GET /:target/:arch/:currentVersion
 * 示例：GET /macos/aarch64/0.0.1
 *
 * 返回 Tauri updater 期望的 JSON 格式：
 * {
 *   "version": "0.1.0",
 *   "notes": "更新说明",
 *   "pub_date": "2024-01-01T00:00:00Z",
 *   "platforms": {
 *     "darwin-aarch64": {
 *       "signature": "...",
 *       "url": "https://r2.dev/vela-updates/Vela_0.1.0_aarch64.dmg"
 *     }
 *   }
 * }
 */

interface Env {
  UPDATES: R2Bucket
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)

    // 路由：/:target/:arch/:currentVersion
    if (parts.length !== 3) {
      return new Response('Not found', { status: 404 })
    }

    const [target, arch, currentVersion] = parts

    // 验证目标平台（目前只支持 macOS）
    if (target !== 'macos') {
      return new Response(JSON.stringify({ error: 'Unsupported platform' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 构建平台标识符（Tauri updater 期望的格式）
    const platformKey = target === 'macos'
      ? `darwin-${arch}`
      : `${target}-${arch}`

    try {
      // 从 R2 读取最新的版本元数据
      const latestMeta = await env.UPDATES.get('latest.json')
      if (!latestMeta) {
        return new Response(JSON.stringify({ error: 'No updates available' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const meta = JSON.parse(await latestMeta.text()) as UpdateMetadata

      // 比较版本号（简单 semver 比较）
      if (!isNewer(meta.version, currentVersion)) {
        return new Response(JSON.stringify({ error: 'Already up to date' }), {
          status: 204,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // 构建对应平台的更新信息
      const platform = meta.platforms[platformKey]
      if (!platform) {
        return new Response(
          JSON.stringify({ error: `No update for ${platformKey}` }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      // 返回 Tauri updater 期望的格式
      const response = {
        version: meta.version,
        notes: meta.notes || '',
        pub_date: meta.pub_date,
        platforms: {
          [platformKey]: {
            signature: platform.signature,
            url: platform.url,
          },
        },
      }

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      console.error('Updater error:', error)
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }
  },
}

interface PlatformUpdate {
  signature: string
  url: string
}

interface UpdateMetadata {
  version: string
  notes?: string
  pub_date: string
  platforms: Record<string, PlatformUpdate>
}

/**
 * 简单的 semver 比较：检查 newVersion 是否大于 currentVersion
 */
function isNewer(newVersion: string, currentVersion: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map(Number)

  const [nMajor, nMinor, nPatch] = parse(newVersion)
  const [cMajor, cMinor, cPatch] = parse(currentVersion)

  if (nMajor !== cMajor) return nMajor > cMajor
  if (nMinor !== cMinor) return nMinor > cMinor
  return nPatch > cPatch
}
