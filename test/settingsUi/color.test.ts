// 设置面板的明暗判定 —— 只测那一个解析函数,但它值一整个文件。
//
// 背景:面板靠「量容器文字颜色的亮度」反推底色明暗(宿主主题是应用内自己切的,
// prefers-color-scheme 在这里会猜错)。判断翻面的后果是整片配色反过来 —— 深色皮肤下
// 弹出一片白的下拉、代码高亮用亮色系。
//
// ⚠️这条在无头浏览器里量不准(宿主主题没加载、动画中途值),所以只能拿**真实的 computed 序列化串**
// 钉死解析层。下面这些串都是 Chromium 实际吐出来的形态,别改成「好看」的写法。
import { describe, expect, it } from 'vitest'
import { parseChannels } from '../../src/settingsUi/index'

describe('computed color 解析', () => {
  it('传统逗号写法', () => {
    expect(parseChannels('rgb(28, 28, 28)')).toEqual([28, 28, 28])
    expect(parseChannels('rgba(248, 247, 246, 0.5)')).toEqual([248, 247, 246])
  })

  it('空格 / 斜杠写法(新语法)', () => {
    expect(parseChannels('rgb(28 28 28)')).toEqual([28, 28, 28])
    expect(parseChannels('rgba(248 247 246 / 50%)')).toEqual([248, 247, 246])
  })

  // 这条是本文件存在的理由:主题里凡是经 color-mix() 算出来的颜色,Chromium 序列化成
  // color(srgb …),通道 0–1。按 0–255 读会把近白(0.97)算成近黑,明暗判断整个翻面。
  it('色空间函数的通道是 0–1,必须换算', () => {
    const ch = parseChannels('color(srgb 0.97 0.96 0.95)')
    expect(ch).not.toBeNull()
    expect(ch?.[0]).toBeCloseTo(247.35, 1)
    expect(ch?.[2]).toBeCloseTo(242.25, 1)
  })

  it('色空间名不限 srgb,带 alpha 也不影响', () => {
    const ch = parseChannels('color(display-p3 0.1 0.1 0.1 / 0.5)')
    expect(ch?.[0]).toBeCloseTo(25.5, 1)
  })

  it('认不出来给 null —— 不许默默当成黑(那等于猜成浅色底)', () => {
    expect(parseChannels('')).toBeNull() // 容器还没进文档时 computed 就是空串
    expect(parseChannels('oklch(0.2 0.01 250)')).toBeNull()
    expect(parseChannels('rgb(28, 28)')).toBeNull()
  })
})

describe('亮度阈值的两端', () => {
  // 宿主 base.css 的实测值:浅色态 --accent/--text 系近黑 #1c1c1c,深色态近白 #f8f7f6。
  const luma = (c: string): number => {
    const ch = parseChannels(c)
    if (!ch) throw new Error(`解析失败:${c}`)
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }

  it('近黑文字 = 浅色底', () => {
    expect(luma('rgb(28, 28, 28)')).toBeLessThan(140)
  })

  it('近白文字 = 深色底,两种序列化都要落在同一侧', () => {
    expect(luma('rgb(248, 247, 246)')).toBeGreaterThan(140)
    expect(luma('color(srgb 0.973 0.969 0.965)')).toBeGreaterThan(140)
  })
})
