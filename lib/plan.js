/**
 * 智能助理学院 v2 — 确定性 Planner。
 *
 * 计划由原文账本直接算出来，不让模型「规划」：步骤顺序可复现、可审计，
 * 每一步的输入范围、产出文件、验收判据都是固定的。执行器只允许跑
 * 「依赖全部完成」的那一步，跑不过就回退到该步并累计尝试次数，
 * 超过上限整堂课停下等人工，绝不跳步继续。
 *
 *   node lib/plan.js --selftest
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { buildLedger, chunkRanges, assertTiling } from './ledger.js'

/** 步骤状态：todo 待跑 / doing 正在跑 / done 通过 / failed 超限失败。 */
export const STEP_STATUS = Object.freeze(['todo', 'doing', 'done', 'failed'])

/** 计划里的步骤种类与它们的中文名（界面动作流直接用）。 */
export const STEP_LABEL = Object.freeze({
  scope: '定边界与版本',
  'overview-chapter': '通读本章（先建框架）',
  'overview-merge': '汇总全文框架',
  map: '拆可执行条款',
  read: '读原文分片',
  absorb: '精读并写知识点',
  clarify: '课堂答疑',
  reconcile: '综合核对（回头对框架）',
  validate: '自动校验与质量审查',
  quiz: '按原文密度出题库',
  exam: '抽考（闭卷用笔记作答）',
  review: '人工复核',
  bind: '绑定双向溯源',
  commit: '交付入库',
})

const MAP_UNIT_CHARS = 3000

/**
 * 生成计划：先定边界 → 按章拆条款 → 逐片读（本地）→ 逐片精读（模型）
 * → 自动校验 → 人工复核 → 出题 → 绑定溯源 → 入库。
 *
 * @param ledger buildLedger() 的账本
 * @param options chunkChars 分片字数上限；maxAttempts 每步允许尝试次数
 * @returns 计划对象
 */
export function makePlan(ledger, options = {}) {
  if (!Array.isArray(ledger?.segments) || !ledger.segments.length) {
    throw new Error('原文账本是空的：先确认原文已抽成文字再开课')
  }
  const chunkChars = Math.max(600, Number(options.chunkChars) || 1600)
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3)
  const chunks = chunkRanges(ledger, chunkChars)
  const tiling = assertTiling(ledger, chunks)
  if (!tiling.ok) throw new Error(`原文分片没有铺满：缺 ${tiling.missing.join(',') || '无'} 重复 ${tiling.duplicated.join(',') || '无'}`)

  const steps = []
  const add = step => {
    steps.push({ status: 'todo', attempts: 0, dependsOn: [], lastError: '', ...step })
    return steps[steps.length - 1]
  }

  add({ id: 'scope', kind: 'scope', label: STEP_LABEL.scope })

  // 先通读：逐章速读建局部理解，再汇总成全文框架。之后拆条款、精读都要带着这个框架走。
  const overviewSteps = ledger.chapters.map((chapter, index) => add({
    id: `overview-${String(index + 1).padStart(2, '0')}`,
    kind: 'overview-chapter',
    label: STEP_LABEL['overview-chapter'],
    chapters: [chapter.id],
    chars: chapter.chars,
    dependsOn: ['scope'],
  }))
  add({
    id: 'overview-merge',
    kind: 'overview-merge',
    label: STEP_LABEL['overview-merge'],
    dependsOn: overviewSteps.map(step => step.id),
  })
  // 通读阶段的疑点先答一轮：别等整篇精读完才回答，通读的术语理解错了会带偏后面几片
  add({ id: 'clarify-early', kind: 'clarify', label: '答疑（通读后）', dependsOn: ['overview-merge'], optional: true })

  // 拆条款按章分组，单次最多约 6000 字，避免一次调用覆盖整本书
  const units = []
  let current = null
  for (const chapter of ledger.chapters) {
    if (!current) current = { chapters: [chapter.id], chars: chapter.chars, from: chapter.start }
    else if (current.chars + chapter.chars <= MAP_UNIT_CHARS) {
      current.chapters.push(chapter.id)
      current.chars += chapter.chars
    } else {
      units.push(current)
      current = { chapters: [chapter.id], chars: chapter.chars, from: chapter.start }
    }
  }
  if (current) units.push(current)
  units.forEach((unit, i) => {
    add({
      id: `map-${String(i + 1).padStart(2, '0')}`,
      kind: 'map',
      label: STEP_LABEL.map,
      chapters: unit.chapters,
      chars: unit.chars,
      dependsOn: ['overview-merge'],
    })
  })

  chunks.forEach(chunk => {
    add({
      id: `read-${String(chunk.index).padStart(2, '0')}`,
      kind: 'read',
      label: STEP_LABEL.read,
      range: [chunk.from, chunk.to],
      segIds: chunk.segIds,
      chars: chunk.chars,
      dependsOn: ['kind:map'],
    })
    add({
      id: `absorb-${String(chunk.index).padStart(2, '0')}`,
      kind: 'absorb',
      label: STEP_LABEL.absorb,
      range: [chunk.from, chunk.to],
      segIds: chunk.segIds,
      chars: chunk.chars,
      output: `task_state/notes/c${String(chunk.index).padStart(2, '0')}.json`,
      dependsOn: [`read-${String(chunk.index).padStart(2, '0')}`],
    })
  })

  // 先逐片精读，再回头做一个「综合核对」：拿笔记对框架、找跨章冲突、纠正初读偏差；
  // 之后校验、出题库、抽考，过了才请人复核。
  add({ id: 'clarify', kind: 'clarify', label: STEP_LABEL.clarify, dependsOn: ['kind:absorb'], optional: true })
  add({ id: 'reconcile', kind: 'reconcile', label: STEP_LABEL.reconcile, dependsOn: ['clarify'] })
  add({ id: 'validate', kind: 'validate', label: STEP_LABEL.validate, dependsOn: ['reconcile'] })
  add({ id: 'quiz', kind: 'quiz', label: STEP_LABEL.quiz, dependsOn: ['validate'] })
  add({ id: 'exam', kind: 'exam', label: STEP_LABEL.exam, dependsOn: ['quiz'] })
  add({ id: 'review', kind: 'review', label: STEP_LABEL.review, dependsOn: ['exam'] })
  add({ id: 'bind', kind: 'bind', label: STEP_LABEL.bind, dependsOn: ['review'] })
  add({ id: 'commit', kind: 'commit', label: STEP_LABEL.commit, dependsOn: ['bind'] })

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    chunkChars,
    maxAttempts,
    blocked: null,
    steps,
  }
}

/** 依赖是否全部完成。`kind:absorb` 表示该种类所有步骤都已完成。 */
export function depsSatisfied(plan, step) {
  for (const dep of step.dependsOn || []) {
    if (String(dep).startsWith('kind:')) {
      const kind = String(dep).slice(5)
      const group = plan.steps.filter(s => s.kind === kind)
      if (group.some(s => s.status !== 'done')) return false
    } else {
      const hit = plan.steps.find(s => s.id === dep)
      if (!hit || hit.status !== 'done') return false
    }
  }
  return true
}

/** 下一步该跑谁：第一个未完成且依赖满足的步骤；没有可跑的就返回 null。 */
export function nextStep(plan) {
  if (plan.blocked) return null
  return plan.steps.find(s => s.status === 'todo' && depsSatisfied(plan, s)) || null
}

/** 接下来可以并行跑的同类步骤（精读分片之间互不依赖，可以并发省时间）。 */
export function nextBatch(plan, kind, limit = 1) {
  if (plan.blocked) return []
  const ready = plan.steps.filter(s => s.kind === kind && s.status === 'todo' && depsSatisfied(plan, s))
  return ready.slice(0, Math.max(1, limit))
}

export function stepById(plan, id) {
  return plan.steps.find(s => s.id === id) || null
}

/** 标记步骤结果。失败且超过尝试上限时，整份计划进入 blocked。 */
export function markStep(plan, id, patch = {}) {
  const step = stepById(plan, id)
  if (!step) throw new Error(`计划里没有这一步：${id}`)
  Object.assign(step, patch)
  if (patch.status === 'todo' && patch.attempts == null) step.attempts = (step.attempts || 0) + 1
  if (patch.status === 'failed') {
    plan.blocked = { stepId: id, label: step.label, reason: step.lastError || '多次尝试仍未通过', at: new Date().toISOString() }
  }
  return step
}

/** 回退一步：重新排队，计一次尝试；超限则判失败。 */
export function requeue(plan, id, reason) {
  const step = stepById(plan, id)
  if (!step) throw new Error(`计划里没有这一步：${id}`)
  const attempts = (step.attempts || 0) + 1
  if (attempts > plan.maxAttempts) {
    return markStep(plan, id, { status: 'failed', attempts, lastError: reason })
  }
  return markStep(plan, id, { status: 'todo', attempts, lastError: reason })
}

/** 给界面用的计划快照。 */
export function planSnapshot(plan) {
  if (!plan) return null
  const steps = plan.steps || []
  const done = steps.filter(s => s.status === 'done').length
  const failed = steps.filter(s => s.status === 'failed').length
  const current = nextStep(plan)
  return {
    steps: steps.length,
    done,
    failed,
    blocked: plan.blocked ? { stepId: plan.blocked.stepId, label: plan.blocked.label, reason: plan.blocked.reason } : null,
    current: current ? { id: current.id, kind: current.kind, label: current.label } : null,
    progress: steps.length ? Math.round((done / steps.length) * 100) : 0,
    retries: steps.reduce((n, s) => n + Math.max(0, (s.attempts || 0) - 1), 0),
    kinds: steps.reduce((acc, s) => {
      const row = acc[s.kind] || (acc[s.kind] = { total: 0, done: 0, failed: 0 })
      row.total += 1
      if (s.status === 'done') row.done += 1
      if (s.status === 'failed') row.failed += 1
      return acc
    }, {}),
  }
}

/* ------------------------------------------------------------------ */

async function runSelftest() {
  let passed = 0
  const failures = []
  const check = (label, ok, extra = '') => {
    if (ok) passed++
    else failures.push(label)
    if (process.env.LEDGER_VERBOSE || !ok) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  }

  const source = Array.from({ length: 12 }, (_, i) => [
    `# 第 ${i + 1} 章 规范${i + 1}`,
    `${i + 1}.1 要求：每批抽 ${5 + i}%，不足 20 件时全检。`,
    `| 序号 | 字段 | 要求 |`,
    `| ${i + 1} | 名称${i + 1} | 按模板填写 |`,
  ].join('\n')).join('\n\n')

  const ledger = buildLedger(source)
  const plan = makePlan(ledger, { chunkChars: 120 })
  check('计划含定边界与拆条款', plan.steps.some(s => s.kind === 'scope') && plan.steps.filter(s => s.kind === 'map').length >= 1)
  check('每个分片都有读与精读两步', plan.steps.filter(s => s.kind === 'read').length === plan.steps.filter(s => s.kind === 'absorb').length)
  check('精读步依赖自己的读步', plan.steps.filter(s => s.kind === 'absorb').every(s => s.dependsOn.some(d => String(d).startsWith('read-'))))
  check('通读建框架排在拆条款与精读之前', (() => {
    const overviews = plan.steps.filter(s => s.kind === 'overview-chapter')
    const merge = plan.steps.find(s => s.kind === 'overview-merge')
    const map = plan.steps.find(s => s.kind === 'map')
    return overviews.length === ledger.chapters.length
      && overviews.every(step => step.dependsOn.includes('scope'))
      && merge.dependsOn.length === overviews.length
      && map.dependsOn.includes('overview-merge')
  })())
  check('综合核对排在答疑之后、校验之前', (() => {
    const clarify = plan.steps.find(s => s.id === 'clarify')
    const early = plan.steps.find(s => s.id === 'clarify-early')
    const reconcile = plan.steps.find(s => s.kind === 'reconcile')
    const validate = plan.steps.find(s => s.kind === 'validate')
    return Boolean(early) && early.dependsOn.includes('overview-merge')
      && reconcile.dependsOn.includes(clarify.id) && validate.dependsOn.includes(reconcile.id)
  })())
  check('出题库与抽考排在复核之前', (() => {
    const review = plan.steps.find(s => s.kind === 'review')
    const quiz = plan.steps.find(s => s.kind === 'quiz')
    const exam = plan.steps.find(s => s.kind === 'exam')
    return quiz.dependsOn.includes('validate') && exam.dependsOn.includes(quiz.id) && review.dependsOn.includes(exam.id)
  })())
  check('入库排在绑定之后', (() => {
    const commit = plan.steps.find(s => s.kind === 'commit')
    return commit.dependsOn.includes('bind')
  })())

  const first = nextStep(plan)
  check('第一步先定边界', first && first.kind === 'scope', first && first.id)
  check('依赖没完成时不许跳步', !plan.steps.find(s => s.kind === 'absorb' && depsSatisfied(plan, s)))

  markStep(plan, 'scope', { status: 'done' })
  const overviews = nextBatch(plan, 'overview-chapter', 20)
  check('定边界后先通读建框架', overviews.length === ledger.chapters.length)
  overviews.forEach(step => markStep(plan, step.id, { status: 'done' }))
  const merge = nextStep(plan)
  check('各章通读完才汇总框架', merge && merge.kind === 'overview-merge', merge && merge.kind)
  markStep(plan, merge.id, { status: 'done' })
  const maps = nextBatch(plan, 'map', 2)
  check('框架建好才拆条款', maps.length >= 1 && maps.every(step => step.kind === 'map'))
  maps.forEach(s => markStep(plan, s.id, { status: 'done' }))
  plan.steps.filter(s => s.kind === 'map').forEach(s => markStep(plan, s.id, { status: 'done' }))
  const reads = nextBatch(plan, 'read', 5)
  check('拆完条款才轮到读分片', reads.length >= 1)

  // 全量推进：读 -> 精读 -> 校验
  const drain = () => {
    for (let guard = 0; guard < 500; guard++) {
      const step = nextStep(plan)
      if (!step) return
      markStep(plan, step.id, { status: 'done' })
    }
  }
  drain()
  check('一路推进到全完成', plan.steps.every(s => s.status === 'done'))

  // 回退：精读没过 -> 重新排队 -> 超限 blocked
  const plan2 = makePlan(ledger, { chunkChars: 120, maxAttempts: 2 })
  markStep(plan2, 'scope', { status: 'done' })
  plan2.steps.filter(s => s.kind === 'map').forEach(s => markStep(plan2, s.id, { status: 'done' }))
  const absorbId = plan2.steps.find(s => s.kind === 'absorb').id
  requeue(plan2, absorbId, '覆盖缺 3 段')
  check('回退后重新排队并记一次尝试', stepById(plan2, absorbId).status === 'todo' && stepById(plan2, absorbId).attempts === 1)
  requeue(plan2, absorbId, '还是缺 3 段')
  requeue(plan2, absorbId, '第三次仍缺')
  check('超过上限判失败并整堂停住', stepById(plan2, absorbId).status === 'failed' && Boolean(plan2.blocked))
  check('blocked 后不再自动推进', nextStep(plan2) === null)

  const snap = planSnapshot(plan)
  check('计划快照给进度与重试次数', snap.progress === 100 && typeof snap.retries === 'number')

  // 分片铺不满必须报错，不能默默跳过
  const full = chunkRanges(ledger, 120)
  const holed = full.slice(0, -1)
  check('分片漏掉尾部时铺满断言失败', !assertTiling(ledger, holed).ok)
  const overlapped = [...full, full[0]]
  check('分片重复时铺满断言失败', !assertTiling(ledger, overlapped).ok)
  let threw = false
  try { makePlan({ segments: [], chapters: [] }) } catch { threw = true }
  check('空账本排计划直接报错', threw)

  console.log(`\n计划器自检：${passed} 项通过，${failures.length} 项失败`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  if (failures.length) process.exitCode = 1
  return { passed, failed: failures.length }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
  runSelftest().catch(error => { console.error(error); process.exitCode = 1 })
}
