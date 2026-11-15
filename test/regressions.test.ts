// 评审复现过的回归(期望 = 上游语义:点击后只剩一个光标;自动分式在每个光标处各做一次)。
import { describe, expect, it } from 'vitest'
import { rig } from './regressionRig'

describe('A: 自动分式一次吞掉当前格前面两组以上时,Tab 不能来回打转', () => {
  it('A1 ( hat x Tab _ 1 Tab / 2,之后三次 Tab 依次出括号、出公式', () => {
    const r = rig('$$ | $$')
    r.run('(', 'hat', 'x', 'Tab', '_', '1', 'Tab', '/', '2')
    expect(r.line()).toBe('$$ \\left( \\frac{\\hat{x}_{1}}{2|} \\right) $$')
    r.run('Tab')
    expect(r.line()).toBe('$$ \\left( \\frac{\\hat{x}_{1}}{2}| \\right) $$')
    r.run('Tab')
    expect(r.line()).toBe('$$ \\left( \\frac{\\hat{x}_{1}}{2} \\right)| $$')
    r.run('Tab')
    expect(r.line()).toBe('$$ \\left( \\frac{\\hat{x}_{1}}{2} \\right) $$|')
  })
  it('A2 ({[a Tab Tab / b:Tab 不在 «b» 与 } 之后来回', () => {
    const r = rig('$$ x| $$')
    r.run('({[a', 'Tab', 'Tab', '/', 'b')
    const seen: string[] = []
    for (let i = 0; i < 4; i++) { r.input('Tab'); seen.push(r.line()) }
    expect(seen).not.toContain('$$ x\\left( \\frac{{[a]}}{«b»} \\right) $$')
    expect(r.hasActive()).toBe(false)
  })
})

describe('B: 鼠标点进同号格的另一份,只改那一份', () => {
  it('B1 tayl:点进第三个 t 打 q,其余几份不动', () => {
    const r = rig('$$ | $$')
    r.run('tayl', 'g', 'Tab', 't', 'Tab', 'k')
    r.run('click:t@3', 'q')
    expect(r.all()).toBe("$$ g(t + k) = g(t) + g'(tq)k + g''(t) \\frac{k^{2}}{2!} + \\dots $$")
  })
  it('B2 parn:点到表达式末尾接着打,\\partial x 不被覆盖', () => {
    const r = rig('$$ | $$')
    r.run('parn', '2', 'Tab', 'f')
    r.run('click:^{2} } ', '+c')
    expect(r.all()).toBe('$$ \\frac{ \\partial^{2} f }{ \\partial x^{2} } +c $$')
  })
  it('B3 方向键挪到别的组再打字,只改一处', () => {
    const r = rig('$$ | $$')
    r.run('tayl', 'g', 'Tab', 't', '←', '←', 'q')
    expect(r.all()).toBe("$$ gq(t + h) = g(t) + g'(t)h + g''(t) \\frac{h^{2}}{2!} + \\dots $$")
  })
  it('B4 在 Tab 落到的那一份里用方向键改错字,仍然联动', () => {
    const r = rig('$$ | $$', {}, [{ trigger: 'ww', replacement: '\\y{$0}{$0}', options: 'mA' }])
    r.run('ww', 'ab', '←', 'x')
    expect(r.all()).toBe('$$ \\y{axb}{axb} $$')
  })
})

describe('C: 同号格里的自动分式,各份都得到分式', () => {
  it('C1 tayl 的 $2 三份都是 \\frac{1}{n}', () => {
    const r = rig('$$ | $$')
    r.run('tayl', 'g', 'Tab', 't', 'Tab', '1', '/', 'n')
    // 第一份在括号里,自动放大括号把它换成 \\left( \\right),其余两份不在括号里。
    expect(r.all()).toBe("$$ g\\left( t + \\frac{1}{n} \\right) = g(t) + g'(t)\\frac{1}{n} + g''(t) \\frac{\\frac{1}{n}^{2}}{2!} + \\dots $$")
    // 分式的格照常跳,走完回到外层的下一格。
    r.run('Tab', 'Tab')
    expect(r.line()).toBe("$$ g\\left( t + \\frac{1}{n} \\right) = g(t) + g'(t)\\frac{1}{n} + g''(t) \\frac{\\frac{1}{n}^{2}}{2!} + \\dots| $$")
  })
  it('C2 两份的片段:a/b 两份都有,分式的格照常跳', () => {
    const r = rig('$$ | $$', {}, [{ trigger: 'ww', replacement: '\\y{$0}{$0}', options: 'mA' }])
    r.run('ww', 'a', '/', 'b')
    expect(r.all()).toBe('$$ \\y{\\frac{a}{b}}{\\frac{a}{b}} $$')
    r.run('Tab', '+')
    expect(r.all()).toBe('$$ \\y{\\frac{a}{b}+}{\\frac{a}{b}+} $$')
  })
  it('C3 同号格里再展开带格的片段,其余各份跟着整段同步', () => {
    const r = rig('$$ | $$', {}, [
      { trigger: 'ww', replacement: '\\y{$0}{$0}', options: 'mA' },
      { trigger: 'hat', replacement: '\\hat{$0}$1', options: 'mA' },
    ])
    r.run('ww', 'hat', 'x', 'Tab', 'y')
    expect(r.all()).toBe('$$ \\y{\\hat{x}y}{\\hat{x}y} $$')
  })
})
