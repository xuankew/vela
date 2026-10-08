import { describe, expect, it } from 'vitest'
import { nextPreviewMode, type PreviewMode } from './previewMode'

/**
 * 三档循环本身。
 *
 * ⚠️ 这里钉不住的是「循环是不是用户想要的那个顺序」：那只能在看得到像素的地方判断。
 * 钉得住的是它**封闭**——按三次回到原点，不会走进一个第四态、也不会卡住。
 * 卡住的失败方式是「预览再也关不掉了」，而这一档唯一的出口就是这个循环与面板上的 ×
 */
describe('nextPreviewMode', () => {
  it('关 → 并排 → 只预览 → 关', () => {
    expect(nextPreviewMode('off')).toBe('side')
    expect(nextPreviewMode('side')).toBe('only')
    expect(nextPreviewMode('only')).toBe('off')
  })

  it('连按三次回到原点，而且三档各不相同', () => {
    const seen: PreviewMode[] = ['off']
    for (let i = 0; i < 3; i += 1) seen.push(nextPreviewMode(seen[seen.length - 1]!))
    expect(seen[3]).toBe('off')
    expect(new Set(seen.slice(0, 3)).size, '循环里有重复的一档，说明有一档走不到').toBe(3)
  })
})
