// 评审复现过的回归(期望 = 上游语义:点击后只剩一个光标;自动分式在每个光标处各做一次)。
import { describe, expect, it } from 'vitest'
import { rig } from './regressionRig'
import { DEFAULT_SNIPPETS } from '../src/snippets/defaults'

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
describe('E: 同号格里打会带上前一个字符的正则片段,不把格外的括号抄过去', () => {
  it('E1 outer 里打 phi', () => {
    const r = rig('$$ | $$')
    r.run('outer', 'phi')
    expect(r.all()).toBe('$$ \\ket{\\phi} \\bra{\\phi}  $$')
  })
})

describe('F1: 编辑把光标带进别的组时不联动(联动只跟着插件自己放进去的那一组)', () => {
  it('F1a parn:Tab 到 y 后退格退回指数里,分母里那份的 2 不被删', () => {
    const r = rig('$$ | $$')
    r.run('parn', '2', 'Tab', 'BS', 'BS', 'BS', 'BS')
    expect(r.all()).toBe('$$ \\frac{ \\partial^{ }{ \\partial x^{2} }  $$')
  })
  it('F1b tayl:点在同一份里连按 7 次退格,其余各份的 g、t 留着', () => {
    const r = rig('$$ | $$')
    r.run('tayl', 'g', 'Tab', 't', 'Tab', 'k', 'click:g(t + k', 'BS', 'BS', 'BS', 'BS', 'BS', 'BS', 'BS')
    expect(r.all()).toContain("g(t) + g'(t)")
  })
})

describe('F2: 同号格里打出的分式,分式的格各含每一份(上游每个光标各排一次,按编号合组)', () => {
  it('F2a tayl:g/2,Tab Tab 再 Shift+Tab 两次回分母打 3,四份一起变', () => {
    const r = rig('$$ | $$')
    r.run('tayl', 'g', '/', '2', 'Tab', 'Tab', 'S-Tab', 'S-Tab', '3')
    expect(r.all()).toBe("$$ \\frac{g}{3}(x + h) = \\frac{g}{3}(x) + \\frac{g}{3}'(x)h + \\frac{g}{3}''(x) \\frac{h^{2}}{2!} + \\dots $$")
  })
  const W = [{ trigger: 'ww', replacement: '\\y{$0}{$0} $1 $2', options: 'mA' }]
  it('F2b 两份:回到分母改字,两份一起改', () => {
    const r = rig('$$ | $$', {}, W)
    r.run('ww', 'a', '/', 'b', 'Tab', 'Tab', 'S-Tab', 'S-Tab', 'X')
    expect(r.all()).toContain('\\y{\\frac{a}{X}}{\\frac{a}{X}}')
  })
  it('F2c 两份:回到分式后面接着打,两份一起长', () => {
    const r = rig('$$ | $$', {}, W)
    r.run('ww', 'a', '/', 'b', 'Tab', 'Tab', 'S-Tab', 'X')
    expect(r.all()).toContain('\\y{\\frac{a}{b}X}{\\frac{a}{b}X}')
  })
  it('F2e 两份:分式 Tab 到最后一格以后再打分式,分子包住前面的分式,两份照样一致', () => {
    const r = rig('$$ | $$', {}, [{ trigger: 'ww', replacement: '\\y{$0}{$0}', options: 'mA' }])
    r.run('ww', 'a', '/', 'b', 'Tab', 'x', '/', 'c')
    expect(r.all()).toBe('$$ \\y{\\frac{\\frac{a}{b}x}{c}}{\\frac{\\frac{a}{b}x}{c}} $$')
  })
  it('F2d 两份:下标 Tab 出来再打分式,两份都得到分式(补到各份的格里再展开,外层那份照常跟)', () => {
    const r = rig('$$ | $$', {}, [...W, ...DEFAULT_SNIPPETS])
    r.run('ww', '_', 'Tab', '/', 'b')
    expect(r.all()).toContain('\\y{\\frac{_{}}{b}}{\\frac{_{}}{b}}')
  })
})

describe('G: 同号格的某一份紧贴着别的格时,Tab 也不来回打转(上游多光标不会落回前面的组)', () => {
  it('G1 两份的 $1 后面紧跟 $0:删掉右括号后连按 Tab 能走出去', () => {
    const r = rig('$$ | $$', {}, [{ trigger: 'vv', replacement: '[${1:foo}] [${1:foo}$0]$2', options: 'mA' }, { trigger: 'ww', replacement: '\\y{$0}{$0} $1 $2', options: 'mA' }])
    r.run('ww', 'vv', '→', 'BS')
    const seen: string[] = []
    for (let i = 0; i < 12 && r.hasActive(); i++) seen.push(r.run('Tab'))
    expect(r.hasActive(), seen.join('\n')).toBe(false)
  })
})

describe('R1: 镜像那份里 Tab 落到每份出现两次的格,再展开带格的片段,外层另一份照样跟', () => {
  // 第一处是空的、紧贴前一格(`${1:p}$2`):自动分式会把 p 一起吃进分子,光标落到 $2 的几处之外。
  const SN = [
    { trigger: 'ww', replacement: '\\y{$0}{$0} $1 $2', options: 'mA' },
    { trigger: 'zu', replacement: '\\u{${1:p}$2 $2 $3}', options: 'mA' },
    ...DEFAULT_SNIPPETS,
  ]
  it('R1a ww zu Tab / b:两份都是分式', () => {
    const r = rig('$$ | $$', {}, SN)
    r.run('ww', 'zu', 'Tab', '/', 'b')
    expect(r.all()).toBe('$$ \\y{\\u{\\frac{p}{b} }}{\\u{\\frac{p}{b} }}  $$')
  })
  // 已知差异:$2 在每份里有两处,展开只在光标那处做,第二处留下打进去的第一个 w(上游多光标会每处各展开一次)。
  it('R1b ww zu Tab BS ww:两份一致、都展开了;每份第二处 $2 留下一个 w', () => {
    const r = rig('$$ | $$', {}, SN)
    r.run('ww', 'zu', 'Tab', 'BS', 'ww')
    expect(r.all()).toBe('$$ \\y{\\u{\\y{}{}  w}}{\\u{\\y{}{}  w}}  $$')
  })
  it('R1c 嵌套 ww ww _:里层两份也都展开(整份照抄不能顶掉逐处照抄)', () => {
    const r = rig('$$ | $$', {}, SN)
    r.run('ww', 'ww', '_')
    expect(r.all()).toBe('$$ \\y{\\y{_{}}{_{}} }{\\y{_{}}{_{}} }  $$')
  })
})
