/**
 * Teaching contract for the Academy (v6).
 *
 * This module is the executable form of 智能助理学院-教学定稿-v6.md sections 5 and 6.
 * It has no npm dependencies and no side effects. The pipeline is expected to
 * import these guards once the six-stage flow is split into reentrant steps.
 *
 * Run `node lib/contract.js --selftest` to verify every rule against positive
 * and negative cases, and `--audit` to grade existing sessions with the new
 * contract.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const CONTRACT_VERSION = 'v6'

export const DEFAULTS = Object.freeze({
  maxSourceChars: 24000,
  anchorPerChars: 100,
  mustQuestionCount: 4,
  sampleQuestionCount: 8,
  retakePassedRatio: 0.2,
  maxRemedialRounds: 2,
  maxPrepRetries: 2,
  softNoteRatio: 2,
  referenceScore: 0.75,
  sessionRetentionDays: 30,
})

export const STATES = Object.freeze([
  'draft',
  'inspected',
  'prepared',
  'frozen',
  'studying',
  'examining',
  'review',
  'closed',
])

export const ERROR_LAYERS = Object.freeze(['fact', 'condition', 'exception', 'order'])
export const ISSUE_TYPES = Object.freeze(['矛盾', '真空', '过期', '疑问'])
export const TARGETS = Object.freeze(['knowledge', 'skill', 'config'])
export const PREP_FIELDS = Object.freeze(['ability', 'criterion', 'acceptance', 'source_refs'])

/**
 * Ordered transition table. `guards` are the program-checkable exit conditions
 * from the v6 state machine. A missing guard blocks the transition with 409.
 */
export const TRANSITIONS = Object.freeze([
  { from: 'draft', to: 'inspected', guards: ['sourceDocs', 'slicesComplete'] },
  { from: 'inspected', to: 'prepared', guards: ['coverage100', 'issuesResolved', 'professorLineComplete'] },
  { from: 'prepared', to: 'frozen', guards: ['noNeedsReview', 'hashesFrozen'] },
  { from: 'frozen', to: 'studying', guards: ['frozenAt'] },
  { from: 'studying', to: 'examining', guards: ['coverageLedgerComplete'] },
  { from: 'examining', to: 'review', guards: ['scoreResult', 'failedAttributed'] },
  { from: 'review', to: 'closed', guards: ['userConfirmed'] },
  { from: 'review', to: 'studying', guards: ['correction', 'roundsAvailable'], loop: true },
])

export const GUARD_LABELS = Object.freeze({
  sourceDocs: '至少一个 SourceDoc 且 hash 可复算',
  slicesComplete: '切片记录完整、章节清单可枚举',
  coverage100: 'reading_map 章节覆盖率 100%',
  issuesResolved: '所有阻塞级 issue 已裁决',
  professorLineComplete: '教授线八步产物齐且互相能对上',
  noNeedsReview: 'needs_review 未置位',
  hashesFrozen: '所有 SourceDoc 的 hash 重算并固化',
  frozenAt: 'frozen_at 非空',
  coverageLedgerComplete: '覆盖账本无未读章节',
  scoreResult: '存在 ScoreResult',
  failedAttributed: '所有错题已按固定动作归因',
  userConfirmed: '用户已确认结课',
  correction: '带 correction 条目',
  roundsAvailable: '局部再学轮次未超过上限',
})

function okTransition(from, to, operator, guards) {
  return {
    ok: true,
    version_id: guards.version_id || '',
    from_state: from,
    to_state: to,
    operator: operator || 'system',
    at: guards.at || new Date().toISOString(),
    missing_conditions: [],
  }
}

function blocked(from, to, missing) {
  return {
    ok: false,
    error: 'STATE_SKIP_FORBIDDEN',
    current_state: from,
    requested_state: to,
    missing_conditions: missing,
    missing_labels: missing.map(k => GUARD_LABELS[k] || k),
  }
}

/**
 * A transition is legal only when it is the exact next step (or the declared
 * review -> studying loop). Skipping any intermediate state returns 409 with
 * the ordered list of states that were skipped.
 */
export function canTransition(from, to, ctx = {}) {
  if (!STATES.includes(from)) return blocked(from, to, ['valid_from_state'])
  if (!STATES.includes(to)) return blocked(from, to, ['valid_to_state'])

  const rule = TRANSITIONS.find(t => t.from === from && t.to === to)
  if (!rule) {
    const fromIdx = STATES.indexOf(from)
    const toIdx = STATES.indexOf(to)
    const skipped = toIdx > fromIdx
      ? STATES.slice(fromIdx + 1, toIdx)
      : ['declared_transition']
    return blocked(from, to, skipped)
  }

  const missing = rule.guards.filter(g => !ctx[g])
  if (missing.length) return blocked(from, to, missing)
  return okTransition(from, to, ctx.operator, ctx)
}

/** Frozen locks the source material only. Teaching content stays revisable. */
export function assertMutableOnFrozen(path) {
  const sourcePaths = ['source_docs.json', 'slices.json', 'uploads/', 'source_hash']
  const locked = sourcePaths.some(p => String(path).includes(p))
  return {
    ok: !locked,
    locked,
    reason: locked
      ? '教材已冻结，原件与切片只读；要改教材需新建会话版本'
      : '冻结只锁教材，备课包、四要素、题库可在新会话修订并留版本痕迹',
  }
}

export function validatePrepNote(note, index = 0) {
  const problems = []
  if (!note || typeof note !== 'object') return { ok: false, point: index, problems: ['not_an_object'] }
  for (const field of PREP_FIELDS) {
    const value = note[field]
    if (value == null || (Array.isArray(value) && !value.length) || String(value).trim() === '') {
      problems.push(`empty_${field}`)
    }
  }
  if (note.point_no == null) problems.push('empty_point_no')
  if (!TARGETS.includes(note.target)) problems.push('invalid_target')
  return { ok: !problems.length, point: note.point_no ?? index, problems }
}

/**
 * Question hard constraints. Uniqueness of basis_ref is scoped to one
 * point_no, so two knowledge points may legitimately share a criterion.
 */
export function validateQuestion(q, prepNotes = [], siblings = []) {
  const problems = []
  if (!q || typeof q !== 'object') return { ok: false, id: null, problems: ['not_an_object'] }
  if (!q.point_no) problems.push('missing_point_no')
  if (!['must', 'other'].includes(q.type)) problems.push('invalid_type')
  if (!String(q.stem || '').trim()) problems.push('empty_stem')
  if (!String(q.answer || '').trim()) problems.push('empty_answer')

  if (q.type === 'must') {
    if (!String(q.basis_ref || '').trim()) problems.push('missing_basis_ref')
    else {
      const prep = prepNotes.find(p => String(p.point_no) === String(q.point_no))
      if (!prep) problems.push('basis_ref_point_missing')
      else if (!String(prep.criterion || '').trim()) problems.push('basis_ref_criterion_empty')
      const sameBasis = siblings.filter(s => s !== q && String(s.basis_ref) === String(q.basis_ref)
        && String(s.point_no) === String(q.point_no))
      const distinctAnswers = new Set([String(q.answer).trim(), ...sameBasis.map(s => String(s.answer || '').trim())])
      if (distinctAnswers.size > 1) problems.push('basis_ref_ambiguous')
    }
  }
  return { ok: !problems.length, id: q.id ?? null, problems }
}

export function validateAttempt(attempt) {
  const problems = []
  if (!attempt || typeof attempt !== 'object') return { ok: false, problems: ['not_an_object'] }
  if (!attempt.question_id) problems.push('missing_question_id')
  if (attempt.is_correct === false) {
    if (attempt.step_no == null) problems.push('missing_step_no')
    if (!ERROR_LAYERS.includes(attempt.error_layer)) problems.push('invalid_error_layer')
  }
  return { ok: !problems.length, problems }
}

/**
 * Fixed attribution action from spec 6.2: check whether the basis_ref points
 * to a PrepNote whose criterion exists and covers the tested point.
 * Never decided by gut feeling. System advice can be overridden by the user,
 * and both conclusions are recorded by the caller.
 */
export function classifyFailure(item, prepNotes = [], history = []) {
  const q = item.question || item
  const prep = prepNotes.find(p => String(p.point_no) === String(q.point_no))

  const wrongTwice = history.filter(h => String(h.question_id) === String(q.id || q.question_id)
    && h.is_correct === false).length >= 2
  if (wrongTwice) {
    return { owner: 'material', reason: 'same_question_wrong_twice', action: 'prepared', system_advice: true }
  }
  if (q.type === 'must') {
    return { owner: 'material', reason: 'must_question_wrong', action: 'prepared', system_advice: true }
  }
  const criterionCovered = prep && String(prep.criterion || '').trim()
    && (!q.coverage || q.coverage === 'covered')
  if (!criterionCovered) {
    return { owner: 'material', reason: 'criterion_missing_or_not_covering', action: 'prepared', system_advice: true }
  }
  return { owner: 'student', reason: 'criterion_present_but_not_applied', action: 'remedial', system_advice: true }
}

export function selectRetake(failedIds, passedIds, ratio = DEFAULTS.retakePassedRatio, rng = Math.random) {
  const failed = [...new Set(failedIds)]
  const passed = [...new Set(passedIds)].filter(id => !failed.includes(id))
  const shuffled = passed.map(id => ({ id, k: rng() })).sort((a, b) => a.k - b.k).map(x => x.id)
  const take = Math.ceil(shuffled.length * ratio)
  return { questions: [...failed, ...shuffled.slice(0, take)], failed, sampled: shuffled.slice(0, take), ratio }
}

/** Remedial rounds 1 and 2 are allowed; round 3 forces material review. */
export function checkRemedialRound(round, maxRounds = DEFAULTS.maxRemedialRounds) {
  if (round <= maxRounds) return { ok: true, round, action: 'remedial' }
  return { ok: false, round, action: 'material_review', flag: '课程需复核', stop_state: 'review' }
}

/**
 * Exam sampling: every chapter gets at least one question; `must` questions
 * prefer numeric boundaries, conditions, exceptions and high-risk anchors;
 * the rest are random within chapter. Full anchor set stays in the bank.
 */
export function selectExam(points = [], opts = {}, rng = Math.random) {
  const mustCount = opts.mustCount ?? DEFAULTS.mustQuestionCount
  const sampleCount = opts.sampleCount ?? DEFAULTS.sampleQuestionCount
  const byChapter = new Map()
  for (const p of points) {
    const key = p.section_ref || 'default'
    if (!byChapter.has(key)) byChapter.set(key, [])
    byChapter.get(key).push(p)
  }
  const riskScore = p => (p.risk ? 4 : 0)
    + (p.boundary ? 2 : 0) + (p.numeric ? 2 : 0) + (p.exception ? 1 : 0)
  const ranked = [...points].sort((a, b) => riskScore(b) - riskScore(a) || rng() - 0.5)
  const must = ranked.slice(0, mustCount).map(p => ({ ...p, type: 'must' }))
  const chosen = new Set(must.map(p => p.point_no))
  const chapterQuota = []
  for (const [section, list] of byChapter) {
    if (!list.some(p => chosen.has(p.point_no))) {
      const pick = list.find(p => !chosen.has(p.point_no))
      if (pick) { chapterQuota.push({ ...pick, type: 'other' }); chosen.add(pick.point_no) }
    }
  }
  const rest = points.filter(p => !chosen.has(p.point_no))
    .map(p => ({ p, k: rng() })).sort((a, b) => a.k - b.k).map(x => x.p)
  const sampled = [...chapterQuota, ...rest.slice(0, Math.max(0, sampleCount - chapterQuota.length))]
    .slice(0, sampleCount).map(p => ({ ...p, type: 'other' }))
  const coveredChapters = new Set([...must, ...sampled].map(p => p.section_ref || 'default'))
  return {
    questions: [...must, ...sampled],
    anchorTotal: points.length,
    chaptersTotal: byChapter.size,
    chaptersCovered: coveredChapters.size,
    everyChapterCovered: coveredChapters.size === byChapter.size,
  }
}

export function validateCoverage(readingMap, slices) {
  const expected = (slices || []).map(s => s.section_ref)
  const read = new Set((readingMap?.chapters || []).map(c => c.section_ref))
  const missing = expected.filter(s => !read.has(s))
  const crossRefMissing = (readingMap?.cross_refs || []).filter(r => !r.to || !r.from).length
  return {
    ok: !missing.length && !crossRefMissing,
    expected: expected.length,
    read: read.size,
    coverage: expected.length ? read.size / expected.length : 0,
    missing,
    crossRefMissing,
  }
}

/** Word count stays a soft hint; hard checks are structural. */
export function validateStudyNote(note, sourceChars) {
  const problems = []
  if (!note || !String(note.content || '').trim()) problems.push('empty_content')
  if (!note.section_ref) problems.push('missing_section_ref')
  const ratio = sourceChars > 0 ? String(note.content || '').length / sourceChars : 0
  return {
    ok: !problems.length,
    problems,
    char_count: String(note.content || '').length,
    ratio: Number(ratio.toFixed(2)),
    soft_hint: ratio < DEFAULTS.softNoteRatio ? '疑似复述而非理解' : null,
  }
}

/** Three-way comparison: professor evidence, student answer, source text. */
export function compareDivergence(entry = {}) {
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase()
  const professor = norm(entry.professor_evidence)
  const student = norm(entry.student_evidence)
  const source = norm(entry.source_text)
  if (!professor || !student || !source) {
    return { divergence: false, type: 'incomplete', reason: '三方证据不齐，无法比对' }
  }
  const professorOff = !source.includes(professor) && !professor.includes(source)
  const studentOff = !source.includes(student) && !student.includes(source)
  const twoSidesDiffer = professor !== student
  return {
    divergence: professorOff || studentOff || twoSidesDiffer,
    type: professorOff ? 'professor_off_source' : studentOff ? 'student_off_source' : 'teacher_student_mismatch',
    professor_off_source: professorOff,
    student_off_source: studentOff,
    teacher_student_mismatch: twoSidesDiffer,
    point_no: entry.point_no ?? null,
  }
}

/** Split five audit checks into two truly automatic and three semantic ones. */
export function splitAudit() {
  return {
    automatic: ['source_refs_locatable', 'chapter_coverage_100'],
    semantic: ['key_point_coverage', 'numeric_boundary_consistency', 'high_risk_error'],
    semantic_policy: '独立审读只给问题清单，不写通过；无不同模型时界面标注「未独立校验」，绝不自动 passed',
  }
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

function runSelftest() {
  let pass = 0
  let fail = 0
  const check = (name, cond) => {
    if (cond) { pass++; console.log(`  ok   ${name}`) }
    else { fail++; console.log(`  FAIL ${name}`) }
  }

  console.log(`contract ${CONTRACT_VERSION} selftest`)

  const fullCtx = {
    sourceDocs: true, slicesComplete: true, coverage100: true, issuesResolved: true,
    professorLineComplete: true, noNeedsReview: true, hashesFrozen: true, frozenAt: true,
    coverageLedgerComplete: true, scoreResult: true, failedAttributed: true,
    userConfirmed: true, correction: true, roundsAvailable: true,
  }

  check('draft -> inspected 允许', canTransition('draft', 'inspected', fullCtx).ok)
  const skip = canTransition('draft', 'frozen', fullCtx)
  check('跳级返回 409', !skip.ok && skip.error === 'STATE_SKIP_FORBIDDEN')
  check('跳级列出缺失状态', skip.missing_conditions.join(',') === 'inspected,prepared')
  const guardFail = canTransition('frozen', 'studying', { ...fullCtx, frozenAt: false })
  check('frozen_at 为空时拒绝答题推进', !guardFail.ok && guardFail.missing_conditions.includes('frozenAt'))
  check('review 回环允许', canTransition('review', 'studying', fullCtx).ok)
  check('第 3 轮补学被拒并转教材复核',
    !checkRemedialRound(3).ok && checkRemedialRound(3).flag === '课程需复核')
  check('第 2 轮补学允许', checkRemedialRound(2).ok)

  const goodPrep = { point_no: 'K1', ability: '会算', criterion: '按表 6.1', acceptance: '数值全对',
    source_refs: ['第6.1节'], target: 'knowledge' }
  check('四要素齐全通过', validatePrepNote(goodPrep).ok)
  const badPrep = validatePrepNote({ ...goodPrep, criterion: '', target: 'other' })
  check('四要素缺失被拒', !badPrep.ok && badPrep.problems.includes('empty_criterion') && badPrep.problems.includes('invalid_target'))

  const prepNotes = [goodPrep]
  const mustQ = { id: 'Q1', point_no: 'K1', type: 'must', stem: '表 6.1 怎么算', answer: 'A', basis_ref: '按表 6.1' }
  check('必答题依据存在通过', validateQuestion(mustQ, prepNotes, [mustQ]).ok)
  check('必答题缺 basis_ref 被拒',
    !validateQuestion({ ...mustQ, basis_ref: '' }, prepNotes, []).ok)
  const ambiguous = validateQuestion({ ...mustQ, answer: 'B' }, prepNotes, [mustQ])
  check('同 point_no 内依据多解被拒', !ambiguous.ok && ambiguous.problems.includes('basis_ref_ambiguous'))
  const otherPoint = { ...mustQ, id: 'Q2', point_no: 'K2', answer: 'B' }
  check('跨知识点共享判据不误伤', validateQuestion(otherPoint, [{ ...goodPrep, point_no: 'K2' }], [mustQ]).ok)

  check('错题缺 step_no 被拒', !validateAttempt({ question_id: 'Q1', is_correct: false }).ok)
  check('错题填 full 归因通过',
    validateAttempt({ question_id: 'Q1', is_correct: false, step_no: 2, error_layer: 'condition' }).ok)
  check('错题为其他题且判据覆盖判学员问题',
    classifyFailure({ ...mustQ, type: 'other' }, prepNotes, []).owner === 'student')
  check('必答题错判教材问题', classifyFailure(mustQ, prepNotes, []).owner === 'material')
  check('判据为空判教材问题',
    classifyFailure({ ...mustQ, type: 'other' }, [], []).owner === 'material')
  check('同题连错两次判教材问题',
    classifyFailure({ ...mustQ, type: 'other' }, prepNotes,
      [{ question_id: 'Q1', is_correct: false }, { question_id: 'Q1', is_correct: false }]).owner === 'material')

  const retake = selectRetake(['Q1', 'Q2'], ['Q3', 'Q4', 'Q5', 'Q6', 'Q7'], 0.2, () => 0.5)
  check('重考含全部错题', retake.failed.length === 2 && retake.questions.includes('Q1') && retake.questions.includes('Q2'))
  check('重考含 20% 已过题', retake.sampled.length === 1)
  check('重考去重', new Set(retake.questions).size === retake.questions.length)

  const frozenSource = assertMutableOnFrozen('sessions/x/source_docs.json')
  const frozenTeaching = assertMutableOnFrozen('sessions/x/professor_pack.json')
  check('冻结锁教材', frozenSource.locked && !frozenSource.ok)
  check('冻结不锁教学内容', frozenTeaching.ok && !frozenTeaching.locked)

  const points = Array.from({ length: 24 }, (_, i) => ({
    point_no: `K${i + 1}`, section_ref: `第${Math.floor(i / 4) + 1}章`,
    risk: i === 3, numeric: i === 7, boundary: i === 7, exception: i === 11,
  }))
  const exam = selectExam(points, {}, () => 0.5)
  check('锚点全量入库不被截断', exam.anchorTotal === 24)
  check('抽考覆盖每章', exam.everyChapterCovered && exam.chaptersCovered === 6)
  check('必答 4 道且优先命中风险点',
    exam.questions.filter(q => q.type === 'must').length === 4
    && exam.questions.filter(q => q.type === 'must').some(q => q.risk))

  const slices = [{ section_ref: '第1章' }, { section_ref: '第2章' }, { section_ref: '第3章' }]
  check('覆盖账本 100% 通过',
    validateCoverage({ chapters: slices.map(s => ({ section_ref: s.section_ref })), cross_refs: [] }, slices).ok)
  const partial = validateCoverage({ chapters: [{ section_ref: '第1章' }], cross_refs: [] }, slices)
  check('未读章节阻止开考', !partial.ok && partial.missing.length === 2)
  check('跨章引用缺失被检出',
    !validateCoverage({ chapters: slices.map(s => ({ section_ref: s.section_ref })), cross_refs: [{ from: '第1章' }] }, slices).ok)

  const shortNote = validateStudyNote({ section_ref: '第1章', content: '照抄一句' }, 1000)
  check('字数不足只是软提示不拦截', shortNote.ok && shortNote.soft_hint === '疑似复述而非理解')
  check('笔记缺 section_ref 被拒', !validateStudyNote({ content: '内容' }, 100).ok)

  check('三方一致不报差异',
    !compareDivergence({ professor_evidence: '按表6.1执行', student_evidence: '按表6.1执行', source_text: '应按表6.1执行' }).divergence)
  const div = compareDivergence({ professor_evidence: '按表6.1执行', student_evidence: '按表6.2执行', source_text: '应按表6.1执行', point_no: 'K1' })
  check('学员偏离原文被检出', div.divergence && div.student_off_source)
  check('差异带 point_no 可定位', div.point_no === 'K1')
  check('五项校验拆成 2 自动 3 语义',
    splitAudit().automatic.length === 2 && splitAudit().semantic.length === 3)

  console.log(`\n${pass} passed, ${fail} failed`)
  return fail === 0
}

/** Grade already-finished sessions against the new contract. */
function auditExistingSessions(root) {
  if (!root || !existsSync(root)) { console.log('  no session root'); return }
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('learn-'))
  console.log(`\naudit ${dirs.length} sessions against ${CONTRACT_VERSION}`)
  for (const d of dirs) {
    const statePath = join(root, d.name, 'state.json')
    if (!existsSync(statePath)) continue
    const s = JSON.parse(readFileSync(statePath, 'utf8'))
    const gap = []
    if (!s.stages?.ingest) gap.push('无 source_docs/slices')
    if (!s.stages?.teacher_prep) gap.push('无教授线八步产物')
    const kp = s.result?.knowledgePoints ?? 0
    const q = s.result?.questions ?? 0
    if (kp > 16) gap.push('知识点超过旧上限')
    if (kp > 0 && q < kp) gap.push(`题库未覆盖全部锚点（${q}/${kp}）`)
    if (!existsSync(join(root, d.name, 'dialogue.jsonl'))) gap.push('无教学对话实录')
    console.log(`  ${d.name}: ${kp} 点 / ${q} 题 / 得分 ${s.result?.score ?? '?'}`)
    console.log(`    差距: ${gap.length ? gap.join('；') : '无'}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = runSelftest()
  if (process.argv.includes('--audit')) {
    auditExistingSessions(process.argv[process.argv.indexOf('--audit') + 1]
      || join(homedir(), '.dsh', 'learning', 'sessions'))
  }
  process.exitCode = ok ? 0 : 1
}
