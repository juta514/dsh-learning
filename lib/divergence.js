/**
 * Two-perspective divergence engine for the Academy (v6 core mechanism).
 *
 * Why this exists: a specification or technical document must not be trusted
 * after a single model reads it once. A professor role and a student role each
 * read the SAME full source independently and each produce a full-length note.
 * The two notes are aligned section by section; every difference is located,
 * adjudicated against the original text, resolved, and re-compared. The course
 * may close only when no unresolved difference remains, unless the user
 * explicitly overrides with a written reason.
 *
 * No npm dependencies, no side effects. Run `node lib/divergence.js --selftest`.
 */

import { fileURLToPath } from 'node:url'

export const DIVERGENCE_VERSION = 'v6-core'

export const DIFF_TYPES = Object.freeze([
  'missing_in_student',
  'missing_in_professor',
  'conflict',
  'perspective',
  'evidence_mismatch',
  'unsupported',
])

export const RESOLUTIONS = Object.freeze([
  'revise_professor',
  'revise_student',
  'accept_perspective',
  'source_issue',
  'escalate_to_user',
])

export const BLOCKING_TYPES = Object.freeze([
  'missing_in_student',
  'missing_in_professor',
  'conflict',
  'evidence_mismatch',
  'unsupported',
])

const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase()
const list = v => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])
const sameList = (a, b) => {
  const x = list(a).map(norm).filter(Boolean).sort()
  const y = list(b).map(norm).filter(Boolean).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}
const keyOf = item => `${item.section_ref || '?'}::${item.point_no || item.claim || '?'}`

/**
 * Notes from both roles must share this shape so they can be aligned.
 * { section_ref, point_no, claim, conditions[], boundaries[], numeric,
 *   evidence[], source_ref }
 */
export function normalizeNote(entries, role) {
  const out = []
  for (const raw of list(entries)) {
    if (!raw || typeof raw !== 'object') continue
    const item = {
      role,
      section_ref: String(raw.section_ref || ''),
      point_no: String(raw.point_no || ''),
      claim: String(raw.claim || ''),
      conditions: list(raw.conditions).map(String),
      boundaries: list(raw.boundaries).map(String),
      numeric: String(raw.numeric == null ? '' : raw.numeric),
      evidence: list(raw.evidence).map(String),
      source_ref: String(raw.source_ref || raw.section_ref || ''),
    }
    item.key = keyOf(item)
    out.push(item)
  }
  return out
}

/**
 * Align two full-length notes. Differences are located by section and point,
 * never reported as a vague "the two roles disagree".
 */
export function compareNotes(professorEntries, studentEntries, source = {}) {
  const professor = normalizeNote(professorEntries, 'professor')
  const student = normalizeNote(studentEntries, 'student')
  const pMap = new Map(professor.map(i => [i.key, i]))
  const sMap = new Map(student.map(i => [i.key, i]))
  const diffs = []
  let seq = 0
  const add = (type, section_ref, point_no, detail, extra = {}) => {
    diffs.push({
      id: `D${++seq}`,
      type,
      section_ref,
      point_no,
      detail,
      blocking: BLOCKING_TYPES.includes(type),
      status: 'open',
      ...extra,
    })
  }

  for (const [key, p] of pMap) {
    const s = sMap.get(key)
    if (!s) {
      add('missing_in_student', p.section_ref, p.point_no,
        '教授笔记有此条，学员笔记没有，疑似漏读或漏记', { professor: p })
      continue
    }
    const mismatched = []
    if (norm(p.claim) !== norm(s.claim)) mismatched.push('claim')
    if (!sameList(p.conditions, s.conditions)) mismatched.push('conditions')
    if (!sameList(p.boundaries, s.boundaries)) mismatched.push('boundaries')
    if (norm(p.numeric) !== norm(s.numeric)) mismatched.push('numeric')
    if (mismatched.length) {
      // A differing title alone is a perspective difference, not a factual
      // error. Titles are summaries and usually do not appear in the source.
      const factual = mismatched.filter(f => f !== 'claim')
      if (!factual.length) {
        add('perspective', p.section_ref, p.point_no,
          '两边标题或表述不同，但条件、边界、数值、依据一致，属视角差异',
          { fields: mismatched, professor: p, student: s, blocking: false })
      } else {
        add('conflict', p.section_ref, p.point_no,
          `两边都有此条但口径不同：${factual.join('、')}`,
          { fields: factual, professor: p, student: s })
      }
    }
    const pEv = p.evidence.map(norm).filter(Boolean)
    const sEv = s.evidence.map(norm).filter(Boolean)
    if (!pEv.length || !sEv.length || !sameList(pEv, sEv)) {
      add('evidence_mismatch', p.section_ref, p.point_no,
        '两侧原文依据缺失或指向不同片段', { professor_evidence: pEv, student_evidence: sEv })
    }
    if (source.text_by_section) {
      const src = norm(source.text_by_section[p.section_ref] || '')
      if (src) {
        for (const side of [['professor', p], ['student', s]]) {
          const [roleName, item] = side
          const unsupported = [...item.conditions, ...item.boundaries, item.numeric]
            .map(norm).filter(v => v && v.length >= 2 && !src.includes(v))
          if (unsupported.length) {
            add('unsupported', p.section_ref, p.point_no,
              `${roleName === 'professor' ? '教授' : '学员'}笔记含原文找不到依据的内容`,
              { side: roleName, samples: unsupported.slice(0, 3) })
          }
        }
      }
    }
  }
  for (const [key, s] of sMap) {
    if (!pMap.has(key)) {
      add('missing_in_professor', s.section_ref, s.point_no,
        '学员笔记有此条，教授笔记没有，疑似教授漏讲或学员引入外部知识', { student: s })
    }
  }
  return {
    professor_items: professor.length,
    student_items: student.length,
    aligned: [...pMap.keys()].filter(k => sMap.has(k)).length,
    differences: diffs,
    open: diffs.length,
  }
}

/**
 * Adjudicate one difference against the original text. The original is the
 * only referee. The system gives a suggested responsible side; the user may
 * override, and both conclusions are kept.
 */
export function adjudicate(diff, source = {}) {
  const src = norm(source.text_by_section?.[diff.section_ref] || source.full_text || '')
  const p = diff.professor
  const s = diff.student
  const base = {
    diff_id: diff.id,
    type: diff.type,
    section_ref: diff.section_ref,
    point_no: diff.point_no,
    adjudicated_at: new Date().toISOString(),
  }
  if (!src) {
    return { ...base, responsible_side: 'unresolved', reason: '该章节原文片段不可用，无法裁决', evidence_available: false }
  }
  if (diff.type === 'missing_in_student') {
    return { ...base, responsible_side: 'student', reason: '教授笔记有而学员笔记缺，原文可核，判学员漏读', evidence_available: true }
  }
  if (diff.type === 'missing_in_professor') {
    const inSource = s && norm(s.claim) && src.includes(norm(s.claim))
    return {
      ...base,
      responsible_side: inSource ? 'professor' : 'student',
      reason: inSource ? '学员写到且原文有，教授漏讲' : '学员写的内容原文没有，判引入外部知识',
      evidence_available: true,
    }
  }
  if (diff.type === 'perspective') {
    return { ...base, responsible_side: 'perspective', reason: '两侧实质字段一致，仅表述视角不同，标注即可', evidence_available: true }
  }
  if (diff.type === 'unsupported') {
    return { ...base, responsible_side: diff.side || 'unresolved', reason: '原文找不到依据，需修订该侧笔记', evidence_available: true }
  }
  if (diff.type === 'evidence_mismatch') {
    return { ...base, responsible_side: p?.evidence?.length ? 'student' : 'professor', reason: '一侧原文依据缺失或指向不同片段，需补齐', evidence_available: true }
  }
  // Adjudicate only the factual fields that actually differ. Claim titles are
  // summaries and are never used as evidence.
  const fields = (diff.fields || ['conditions', 'boundaries', 'numeric']).filter(f => f !== 'claim')
  const valuesOf = (item, fields) => fields.flatMap(f => f === 'numeric' ? [item?.numeric] : (item?.[f] || []))
    .map(norm).filter(v => v && v.length >= 2)
  const hitRate = item => {
    const vals = valuesOf(item, fields)
    if (!vals.length) return { hits: 0, total: 0, ratio: 0 }
    const hits = vals.filter(v => src.includes(v)).length
    return { hits, total: vals.length, ratio: hits / vals.length }
  }
  const pr = hitRate(p)
  const sr = hitRate(s)
  if (pr.ratio === 1 && sr.ratio === 1) {
    return { ...base, responsible_side: 'perspective', reason: '两侧口径都能在原文找到，属视角或粒度差异，需标注但不一定算错', evidence_available: true }
  }
  if (pr.ratio === 0 && sr.ratio === 0) {
    return { ...base, responsible_side: 'unresolved', reason: '两侧都与原文对不上，可能是原文自相矛盾或表述含混，升级给用户裁决', evidence_available: true }
  }
  return {
    ...base,
    responsible_side: pr.ratio > sr.ratio ? 'student' : 'professor',
    reason: pr.ratio > sr.ratio ? '教授侧口径与原文一致，学员侧偏离' : '学员侧口径与原文一致，教授侧偏离',
    evidence_available: true,
    professor_hit_rate: Number(pr.ratio.toFixed(2)),
    student_hit_rate: Number(sr.ratio.toFixed(2)),
  }
}

/** Record a resolution. Re-comparison afterwards is mandatory. */
export function resolveDivergence(diff, verdict, action) {
  if (!RESOLUTIONS.includes(action.resolution)) {
    return { ok: false, reason: 'invalid_resolution', diff_id: diff.id }
  }
  if (action.resolution === 'escalate_to_user' && !String(action.reason || '').trim()) {
    return { ok: false, reason: 'escalation_needs_reason', diff_id: diff.id }
  }
  return {
    ok: true,
    diff_id: diff.id,
    status: action.resolution === 'escalate_to_user' ? 'escalated' : 'resolved',
    system_advice: verdict,
    user_override: action.user_override || null,
    resolution: action.resolution,
    reason: String(action.reason || ''),
    revised_by: action.operator || 'system',
    at: new Date().toISOString(),
  }
}

/**
 * Closing gate. The user still makes the final call, but the system must first
 * show that every difference was compared, adjudicated and resolved. An
 * explicit override is allowed only with a written reason, and unresolved
 * items are carried into the lecture note's 存疑与未确认 section.
 */
export function canClose(comparison, resolutions = [], options = {}) {
  const resolved = new Set(resolutions.filter(r => r.ok && r.status === 'resolved').map(r => r.diff_id))
  const escalated = new Set(resolutions.filter(r => r.ok && r.status === 'escalated').map(r => r.diff_id))
  const unresolved = comparison.differences
    .filter(d => !resolved.has(d.id) && !escalated.has(d.id))
    .map(d => ({ id: d.id, type: d.type, section_ref: d.section_ref, point_no: d.point_no, detail: d.detail }))
  const blocking = comparison.differences
    .filter(d => d.blocking && !resolved.has(d.id))
    .map(d => d.id)
  const overrideReason = String(options.override_reason || '').trim()
  const overridden = blocking.length > 0 && !!overrideReason
  return {
    ok: blocking.length === 0,
    overridden,
    override_reason: overrideReason || null,
    total_differences: comparison.differences.length,
    resolved: resolved.size,
    escalated: escalated.size,
    unresolved,
    blocking,
    evidence: {
      professor_items: comparison.professor_items,
      student_items: comparison.student_items,
      aligned: comparison.aligned,
      all_adjudicated: comparison.differences.every(d => resolved.has(d.id) || escalated.has(d.id)),
    },
    carry_into_note: unresolved.length ? unresolved.map(u => `${u.section_ref} ${u.point_no}：${u.detail}`) : [],
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
  console.log(`divergence ${DIVERGENCE_VERSION} selftest`)

  const source = {
    text_by_section: {
      '第1章': '触摸模组工作温度为-20℃至70℃，湿度要求小于90%RH，不适用于户外强光环境。',
      '第2章': '示例物料清单按V1.1编制，物料编码共12位，变更需经负责人确认。',
      '第3章': '检验按AQL2.5抽样，批量小于50时全检。',
    },
  }
  const pNote = [
    { section_ref: '第1章', point_no: 'K1', claim: '工作温度范围', conditions: ['-20℃至70℃'],
      boundaries: ['不适用于户外强光'], numeric: '-20℃至70℃', evidence: ['触摸模组工作温度为-20℃至70℃'] },
    { section_ref: '第2章', point_no: 'K2', claim: 'BOM编制版本', conditions: ['V1.1'],
      boundaries: [], numeric: '12位', evidence: ['物料编码共12位'] },
    { section_ref: '第3章', point_no: 'K3', claim: '抽样规则', conditions: ['AQL2.5'],
      boundaries: ['批量小于50时全检'], numeric: '50', evidence: ['检验按AQL2.5抽样'] },
  ]
  const identical = compareNotes(pNote, pNote, source)
  check('两份同构全文笔记一致时无差异', identical.differences.length === 0)
  check('对齐条目数正确', identical.aligned === 3)
  check('无差异时可结课', canClose(identical, []).ok)

  const sMissing = compareNotes(pNote, pNote.slice(0, 2), source)
  check('学员漏读一节被检出', sMissing.differences.some(d => d.type === 'missing_in_student' && d.section_ref === '第3章'))
  check('漏读属阻塞差异', sMissing.differences.every(d => d.blocking))
  check('有未消解差异时不可结课', !canClose(sMissing, []).ok)

  const sExtra = compareNotes(pNote.slice(0, 2), pNote, source)
  check('教授漏讲一节被检出', sExtra.differences.some(d => d.type === 'missing_in_professor'))

  const sConflict = pNote.map(n => n.point_no === 'K1' ? { ...n, numeric: '-10℃至60℃', conditions: ['-10℃至60℃'] } : n)
  const conflict = compareNotes(pNote, sConflict, source)
  const c1 = conflict.differences.find(d => d.type === 'conflict' && d.point_no === 'K1')
  check('数值口径冲突被检出并定位字段', !!c1 && c1.fields.includes('numeric') && c1.fields.includes('conditions'))
  const verdict = adjudicate(c1, source)
  check('原文裁决判学员侧偏离', verdict.responsible_side === 'student')
  check('裁决给出理由与时间点', !!verdict.reason && !!verdict.adjudicated_at)

  const bothOff = compareNotes(
    [{ ...pNote[0], numeric: '999℃', conditions: ['999℃'] }],
    [{ ...pNote[0], numeric: '888℃', conditions: ['888℃'] }], source)
  const bothConflict = bothOff.differences.find(d => d.type === 'conflict')
  check('两侧都与原文对不上时升级未决', adjudicate(bothConflict, source).responsible_side === 'unresolved')

  const noSource = adjudicate(c1, {})
  check('原文片段不可用不硬判', noSource.responsible_side === 'unresolved' && !noSource.evidence_available)

  const sPerspective = pNote.map(n => n.point_no === 'K3'
    ? { ...n, claim: '抽样与全检的适用分界' } : n)
  const perspectiveDiff = compareNotes(pNote, sPerspective, source).differences
    .find(d => d.type === 'perspective')
  check('标题不同但实质一致标为视角差异', !!perspectiveDiff && !perspectiveDiff.blocking)
  check('视角差异裁决不判任何一方有错', adjudicate(perspectiveDiff, source).responsible_side === 'perspective')

  const sEvidence = pNote.map(n => n.point_no === 'K2' ? { ...n, evidence: [] } : n)
  const evDiff = compareNotes(pNote, sEvidence, source)
  check('依据缺失被检出', evDiff.differences.some(d => d.type === 'evidence_mismatch'))

  const sUnsupported = pNote.map(n => n.point_no === 'K1'
    ? { ...n, boundaries: ['不适用于户外强光', '需每季度校准一次'] } : n)
  const unsup = compareNotes(pNote, sUnsupported, source)
  check('原文找不到依据的内容被检出', unsup.differences.some(d => d.type === 'unsupported' && d.side === 'student'))

  const r1 = resolveDivergence(c1, verdict, { resolution: 'revise_student', reason: '按原文修正温度范围', operator: 'professor' })
  check('消解记录合法', r1.ok && r1.status === 'resolved')
  check('系统建议被完整保留', r1.system_advice.responsible_side === 'student')
  check('非法消解方式被拒', !resolveDivergence(c1, verdict, { resolution: 'ignore' }).ok)
  check('升级给用户必须写理由', !resolveDivergence(c1, verdict, { resolution: 'escalate_to_user' }).ok)
  const r2 = resolveDivergence(c1, verdict, { resolution: 'escalate_to_user', reason: '原文表述含混', user_override: 'source' })
  check('带理由可升级并留用户覆盖', r2.ok && r2.status === 'escalated' && r2.user_override === 'source')

  const partial = canClose(conflict, [r1])
  check('仍有阻塞差异时不可结课', !partial.ok && partial.blocking.length > 0)
  const withOverride = canClose(conflict, [r1], { override_reason: '该条属原文笔误，已线下核实' })
  check('用户书面理由可强制结课', withOverride.overridden)
  check('强制结课把未决项带进讲义', withOverride.carry_into_note.length > 0)
  check('结课证据含双方条目数与对齐数',
    withOverride.evidence.professor_items === 3 && withOverride.evidence.student_items === 3)

  const allResolved = compareNotes(pNote, sConflict, source)
  const rs = allResolved.differences.map(d => resolveDivergence(d, adjudicate(d, source),
    { resolution: 'revise_student', reason: '按原文修订' }))
  const closed = canClose(allResolved, rs)
  check('全部差异消解后可结课', closed.ok && closed.blocking.length === 0)
  check('结课证据标明全部已裁决', closed.evidence.all_adjudicated)

  console.log(`\n${pass} passed, ${fail} failed`)
  return fail === 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runSelftest() ? 0 : 1
}
