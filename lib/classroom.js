/**
 * 智能助理学院 — 课堂对话与课堂笔记内核。
 *
 * 课堂本身是一个对话框：教授、学员、用户、系统在这个框里说的每一句，
 * 都按时间顺序追加进 `dialogue.jsonl`（append-only，永不覆盖）。课堂笔记
 * `class-notes.md` 是这份原始记录的全量重建结果，不做摘要、不做改写，
 * 因此「课堂上所学的所有内容」既能逐条追溯，也能当作一份能离线读的笔记。
 *
 * 零依赖，只用 Node 内置模块。可脱离 Web、脱离模型独立运行：
 *   node lib/classroom.js --selftest
 */

import {
  appendFile, mkdir, readFile, readdir, rename, rm, writeFile, mkdtemp,
} from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export const ROLES = Object.freeze(['user', 'professor', 'student', 'system'])
export const KINDS = Object.freeze([
  'teach', 'answer', 'question', 'correction', 'note', 'source', 'system',
])

const ROLE_LABEL = Object.freeze({
  user: '我（用户）', professor: '教授', student: '学员', system: '系统',
})
const KIND_LABEL = Object.freeze({
  teach: '教授讲解', answer: '学员作答', question: '疑问',
  correction: '指正', note: '课堂笔记', source: '原文依据', system: '系统记录',
})
const MAX_CONTENT = 20000
const MAX_ID = 80
const MAX_REF = 300
const MAX_REFS = 8

/** Per-classroom promise chain so two concurrent appends cannot interleave. */
const locks = new Map()

function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(fn)
  locks.set(key, next)
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key)
  })
  return next
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function safeId(raw, label = '课堂 ID') {
  const value = String(raw || '').trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw httpError(`${label} 不合法：只能用字母、数字、下划线与连字符`, 400)
  }
  return value
}

function within(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) return t
  throw httpError('路径超出课堂目录范围', 400)
}

export function classroomsRoot(stateRoot) {
  return within(stateRoot, join(stateRoot, 'classrooms'))
}

function classroomDir(stateRoot, id) {
  return within(classroomsRoot(stateRoot), join(classroomsRoot(stateRoot), safeId(id)))
}

function shortText(value, max, label) {
  const text = String(value == null ? '' : value)
  if (text.length > max) throw httpError(`${label} 超过 ${max} 字符`, 400)
  return text.trim()
}

function newId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`
}

async function atomicWrite(file, content) {
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

function readMetaFile(dir) {
  return readFile(join(dir, 'meta.json'), 'utf8').then(text => JSON.parse(text))
}

async function readDialogue(dir) {
  let raw = ''
  try { raw = await readFile(join(dir, 'dialogue.jsonl'), 'utf8') } catch { return { messages: [], corruptLines: 0 } }
  const messages = []
  let corruptLines = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (item && typeof item === 'object' && typeof item.content === 'string') messages.push(item)
      else corruptLines++
    } catch { corruptLines++ }
  }
  return { messages, corruptLines }
}

/**
 * Build the classroom notebook from the full dialogue. Pure and deterministic:
 * the same classroom + messages always produce byte-identical markdown.
 * Nothing is summarised away — section two carries every utterance verbatim.
 */
export function buildNotes(classroom, messages, corruptLines = 0) {
  const byRole = {}
  const byKind = {}
  const sections = new Map()
  const points = new Map()
  const questions = []
  const corrections = []
  for (const m of messages) {
    byRole[m.role] = (byRole[m.role] || 0) + 1
    byKind[m.kind] = (byKind[m.kind] || 0) + 1
    if (m.sectionRef) {
      if (!sections.has(m.sectionRef)) sections.set(m.sectionRef, [])
      sections.get(m.sectionRef).push(m.seq)
    }
    if (m.pointNo) {
      if (!points.has(m.pointNo)) points.set(m.pointNo, [])
      points.get(m.pointNo).push(m.seq)
    }
    if (m.kind === 'question') questions.push(m)
    if (m.kind === 'correction') corrections.push(m)
  }

  const stamp = ts => {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return String(ts || '').slice(0, 16)
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  }
  const quote = text => String(text || '').split(/\r?\n/).map(line => `> ${line}`).join('\n') || '> '
  const cell = text => String(text || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

  const lines = []
  lines.push('---')
  lines.push(`title: ${JSON.stringify(classroom.title || '课堂笔记')}`)
  lines.push(`classroom_id: ${classroom.id}`)
  lines.push(`course_id: ${JSON.stringify(classroom.courseId || '')}`)
  if (classroom.materialId) {
    lines.push(`material_id: ${JSON.stringify(classroom.materialId)}`)
    lines.push(`material_version: ${Number(classroom.materialVersion) || 1}`)
    lines.push(`material_attempt: ${Number(classroom.attempt) || 1}`)
    lines.push(`material_title: ${JSON.stringify(classroom.materialTitle || classroom.title || '')}`)
  }
  lines.push(`created_at: ${JSON.stringify(classroom.createdAt || '')}`)
  lines.push(`updated_at: ${JSON.stringify(classroom.updatedAt || '')}`)
  lines.push(`messages: ${messages.length}`)
  lines.push(`sections: ${sections.size}`)
  lines.push(`status: ${classroom.status || 'open'}`)
  lines.push('---')
  lines.push('')
  lines.push(`# 课堂笔记 · ${classroom.title || '未命名课堂'}`)
  lines.push('')
  lines.push('> 本笔记由课堂对话逐条自动整理，不删减、不改写、不生成新结论。课堂里说过的每一句都在下面第二节「课堂实录」，逐条原始 JSON 留痕在同目录 `dialogue.jsonl`。事实以上传原件与原文依据为准。')
  lines.push('')
  lines.push(`课堂 ID \`${classroom.id}\`${classroom.courseId ? ` · 关联课程 \`${classroom.courseId}\`` : ''} · 开课 ${stamp(classroom.createdAt)} · 最后更新 ${stamp(classroom.updatedAt)}`)
  lines.push('')

  lines.push('## 一、课堂概览')
  lines.push('')
  lines.push('| 项目 | 数值 |')
  lines.push('| --- | --- |')
  lines.push(`| 消息总数 | ${messages.length} |`)
  for (const role of ROLES) {
    if (byRole[role]) lines.push(`| ${ROLE_LABEL[role]}发言 | ${byRole[role]} |`)
  }
  lines.push(`| 涉及章节 | ${sections.size} |`)
  lines.push(`| 涉及知识点 | ${points.size} |`)
  lines.push(`| 疑问 | ${questions.length} |`)
  lines.push(`| 指正 | ${corrections.length} |`)
  if (corruptLines) lines.push(`| 原始记录损坏行 | ${corruptLines}（已跳过，需人工核对 dialogue.jsonl） |`)
  lines.push('')
  const kinds = KINDS.filter(k => byKind[k]).map(k => `${KIND_LABEL[k]} ${byKind[k]}`).join('、')
  lines.push(`内容构成：${kinds || '暂无'}。`)
  lines.push('')

  lines.push('## 二、课堂实录')
  lines.push('')
  if (!messages.length) {
    lines.push('课堂还没有内容。在对话框里说第一句话，它就会记在这里。')
    lines.push('')
  }
  for (const m of messages) {
    lines.push(`### ${m.seq} · ${stamp(m.ts)} · ${ROLE_LABEL[m.role] || m.role} · ${KIND_LABEL[m.kind] || m.kind}`)
    lines.push('')
    const facts = []
    if (m.speaker && m.speaker !== ROLE_LABEL[m.role]) facts.push(`发言人 ${m.speaker}`)
    if (m.sectionRef) facts.push(`章节 ${m.sectionRef}`)
    if (m.pointNo) facts.push(`知识点 ${m.pointNo}`)
    if (facts.length) lines.push(`- ${facts.join(' · ')}`)
    if (Array.isArray(m.refs) && m.refs.length) lines.push(`- 原文依据：${m.refs.join('；')}`)
    if (m.id) lines.push(`- 记录 ID：\`${m.id}\``)
    if (facts.length || (m.refs && m.refs.length) || m.id) lines.push('')
    lines.push(quote(m.content))
    lines.push('')
  }

  lines.push('## 三、按章节索引')
  lines.push('')
  if (sections.size) {
    lines.push('| 章节 / 原文位置 | 实录序号 |')
    lines.push('| --- | --- |')
    for (const [section, seqs] of sections) lines.push(`| ${cell(section)} | ${seqs.join('、')} |`)
  } else {
    lines.push('尚无消息标注章节。发消息时可以填「章节 / 原文位置」，笔记会自动归类。')
  }
  lines.push('')

  lines.push('## 四、按知识点索引')
  lines.push('')
  if (points.size) {
    lines.push('| 知识点编号 | 实录序号 |')
    lines.push('| --- | --- |')
    for (const [point, seqs] of points) lines.push(`| ${cell(point)} | ${seqs.join('、')} |`)
  } else {
    lines.push('尚无消息标注知识点编号。')
  }
  lines.push('')

  lines.push('## 五、疑问与指正')
  lines.push('')
  lines.push(`### 疑问（${questions.length}）`)
  lines.push('')
  if (questions.length) {
    for (const m of questions) {
      lines.push(`- 实录 ${m.seq} · ${stamp(m.ts)} · ${m.speaker || ROLE_LABEL[m.role]}${m.sectionRef ? ` · ${m.sectionRef}` : ''}`)
      lines.push(quote(m.content))
    }
  } else lines.push('无。')
  lines.push('')
  lines.push(`### 指正（${corrections.length}）`)
  lines.push('')
  if (corrections.length) {
    for (const m of corrections) {
      lines.push(`- 实录 ${m.seq} · ${stamp(m.ts)} · ${m.speaker || ROLE_LABEL[m.role]}${m.sectionRef ? ` · ${m.sectionRef}` : ''}`)
      lines.push(quote(m.content))
    }
  } else lines.push('无。')
  lines.push('')

  lines.push('## 六、留痕说明')
  lines.push('')
  lines.push('- `dialogue.jsonl`：append-only 原始记录，每行一条完整 JSON，只追加不覆盖，重复提交同一记录 ID 不会重复计一条。')
  lines.push('- `class-notes.md`：本文件，由原始记录全量重建；同一批消息重复生成内容一致。')
  lines.push('- `meta.json`：课堂标题、关联课程、消息数与笔记字数。')
  lines.push('- 笔记不做摘要与改写。若日后接入双视角比对或自动回复，它们产生的内容同样以一条消息追加进来，自动进入本笔记。')
  lines.push('')
  return lines.join('\n')
}

/** Open a classroom. Re-opening the same course returns the same classroom. */
export async function openClassroom(stateRoot, options = {}) {
  const root = classroomsRoot(stateRoot)
  await mkdir(root, { recursive: true })
  // The page sends an empty string when a classroom is opened without a course.
  // Treat that as "no course", not as an invalid id.
  const rawCourseId = options.courseId == null ? '' : String(options.courseId).trim()
  const courseId = rawCourseId ? safeId(rawCourseId, '课程 ID') : ''
  let id = options.id ? safeId(options.id) : ''

  if (!id && courseId) {
    let entries = []
    try { entries = await readdir(root, { withFileTypes: true }) } catch { /* none yet */ }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const meta = await readMetaFile(join(root, entry.name))
        if (meta.courseId === courseId && meta.status === 'open') { id = meta.id; break }
      } catch { /* broken classroom, skip */ }
    }
  }
  if (id) {
    const dir = classroomDir(stateRoot, id)
    try {
      await readMetaFile(dir)
      return getClassroom(stateRoot, id)
    } catch { /* not created yet; fall through */ }
  }

  id = id || newId('class')
  const dir = classroomDir(stateRoot, id)
  const now = new Date().toISOString()
  const title = shortText(options.title, 160, '课堂标题') || (courseId ? `课堂 · ${courseId}` : '自由课堂')
  const materialId = options.materialId ? String(options.materialId).trim() : ''
  const materialVersion = materialId ? Number(options.materialVersion) || 1 : 0
  const attempt = materialId ? Number(options.attempt) || 0 : 0
  const meta = {
    id,
    courseId,
    title,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    noteChars: 0,
    corruptLines: 0,
    // 课堂学的是哪本书的哪一版，第几次学。这三个字段是换版对比的唯一依据。
    materialId,
    materialVersion,
    attempt,
    materialTitle: materialId ? shortText(options.materialTitle, 160, '教材标题') : '',
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'dialogue.jsonl'), '', 'utf8')
  await atomicWrite(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  // The opening itself is part of the classroom record, so the notebook is
  // never an empty shell.
  await appendMessage(stateRoot, id, {
    role: 'system',
    kind: 'system',
    content: `课堂开始：${title}${courseId ? `（关联课程 ${courseId}）` : ''}`
      + (materialId ? `（教材 ${meta.materialTitle} v${materialVersion} · 第 ${attempt} 次学习）` : '')
      + '。以下对话会逐条记录，并自动整理成课堂笔记。',
  })
  return getClassroom(stateRoot, id)
}

/** 把过大的 meta 收缩到能落盘的大小：标量截断、数组只留前几项、对象转字符串。 */
function shrinkMeta(meta, before) {
  const out = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) { out[key] = value; continue }
    const type = typeof value
    if (type === 'number' || type === 'boolean') { out[key] = value; continue }
    if (type === 'string') { out[key] = value.slice(0, 400); continue }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 3).map(item => (
        item && typeof item === 'object' ? JSON.stringify(item).slice(0, 260) : String(item).slice(0, 260)
      ))
      continue
    }
    out[key] = JSON.stringify(value).slice(0, 400)
  }
  out.shrunkFrom = before
  return out
}

/** Append one utterance. Idempotent on message.id. */
export async function appendMessage(stateRoot, id, raw = {}) {
  const safe = safeId(id)
  const dir = classroomDir(stateRoot, safe)
  try { await readMetaFile(dir) } catch { throw httpError('找不到该课堂', 404) }

  const role = String(raw.role || '').trim()
  if (!ROLES.includes(role)) throw httpError(`发言角色不合法，可选 ${ROLES.join(' / ')}`, 400)
  const kind = String(raw.kind || '').trim()
  if (!KINDS.includes(kind)) throw httpError(`记录类型不合法，可选 ${KINDS.join(' / ')}`, 400)
  const content = String(raw.content == null ? '' : raw.content)
  if (!content.trim()) throw httpError('课堂内容不能为空', 400)
  if (content.length > MAX_CONTENT) throw httpError(`单条内容超过 ${MAX_CONTENT} 字符，请分条记录`, 413)

  const messageId = raw.id
    ? (() => {
      const value = String(raw.id).trim()
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) throw httpError('记录 ID 不合法', 400)
      return value
    })()
    : newId('m')
  const refs = Array.isArray(raw.refs)
    ? raw.refs.slice(0, MAX_REFS).map((r, i) => shortText(r, MAX_REF, `原文依据 ${i + 1}`)).filter(Boolean)
    : []
  let metaExtra = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {}
  // 附加信息是给页面的摘要，不该因为太大就把整句话挡在门外：
  // 超限先收缩（标量截断、数组只留前几项），仍超才报错，并写清楚是哪一步。
  if (JSON.stringify(metaExtra).length > 4000) {
    const before = JSON.stringify(metaExtra).length
    metaExtra = shrinkMeta(metaExtra, before)
    if (JSON.stringify(metaExtra).length > 4000) {
      const perField = Object.entries(metaExtra).map(([k, v]) => `${k}=${JSON.stringify(v).length}`).join(',')
      throw httpError(`附加信息过大（step=${metaExtra.step || '?'}，共 ${before} 字符：${perField}）`, 413)
    }
  }

  return withLock(`dsh-classroom:${resolve(dir)}`, async () => {
    const { messages, corruptLines } = await readDialogue(dir)
    const duplicate = messages.find(m => m.id === messageId)
    if (duplicate) {
      const current = await getClassroom(stateRoot, safe)
      return { ...current, message: duplicate, duplicate: true }
    }
    const nextSeq = messages.reduce((max, m) => Math.max(max, Number(m.seq) || 0), 0) + 1
    const message = {
      seq: nextSeq,
      id: messageId,
      ts: new Date().toISOString(),
      role,
      speaker: shortText(raw.speaker, 60, '发言人') || ROLE_LABEL[role],
      kind,
      sectionRef: shortText(raw.sectionRef, 80, '章节'),
      pointNo: shortText(raw.pointNo, 80, '知识点编号'),
      content,
      refs,
      meta: metaExtra,
    }
    await appendFile(join(dir, 'dialogue.jsonl'), `${JSON.stringify(message)}\n`, 'utf8')
    const all = [...messages, message]
    const prior = await readMetaFile(dir)
    const finalMeta = {
      ...prior,
      updatedAt: message.ts,
      messageCount: all.length,
      corruptLines,
    }
    const notes = buildNotes(finalMeta, all, corruptLines)
    finalMeta.noteChars = notes.length
    await atomicWrite(join(dir, 'class-notes.md'), notes)
    await atomicWrite(join(dir, 'meta.json'), `${JSON.stringify(finalMeta, null, 2)}\n`)
    return { classroom: finalMeta, messages: all, notes, message, duplicate: false, corruptLines }
  })
}

export async function getClassroom(stateRoot, id) {
  const dir = classroomDir(stateRoot, safeId(id))
  let meta
  try { meta = await readMetaFile(dir) } catch { throw httpError('找不到该课堂', 404) }
  const { messages, corruptLines } = await readDialogue(dir)
  let notes
  try { notes = await readFile(join(dir, 'class-notes.md'), 'utf8') } catch {
    notes = buildNotes(meta, messages, corruptLines)
    await atomicWrite(join(dir, 'class-notes.md'), notes)
  }
  // 绑定教材的课堂（包括迁移过来的旧课堂）笔记里也要写清是哪本书哪一版，
  // 否则日后做换版对比时分不清这份笔记学的是哪一版。
  if (meta.materialId && !notes.includes('material_id:')) {
    notes = buildNotes(meta, messages, corruptLines)
    await atomicWrite(join(dir, 'class-notes.md'), notes)
  }
  return { classroom: meta, messages, notes, corruptLines }
}

export async function listClassrooms(stateRoot) {
  const root = classroomsRoot(stateRoot)
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return { classrooms: [] } }
  const classrooms = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const meta = await readMetaFile(join(root, entry.name))
      if (meta.id && meta.id !== entry.name) continue
      classrooms.push(meta)
    } catch { /* skip broken classroom */ }
  }
  classrooms.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return { classrooms }
}

/* ------------------------------------------------------------------ */
/* Offline self-test: kernel + Web route layer, no services required.  */
/* ------------------------------------------------------------------ */

async function runSelftest() {
  const execFileAsync = promisify(execFile)
  let passed = 0
  const failures = []
  const check = (label, ok) => {
    if (ok) passed++
    else failures.push(label)
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-classroom-'))
  const knowledgeRoot = join(root, 'knowledge')
  await mkdir(knowledgeRoot, { recursive: true })

  try {
    // --- kernel ---
    const opened = await openClassroom(root, { courseId: 'learn-20261115-demo', title: '触摸模组检验规范' })
    check('开课返回课堂 ID', /^class-/.test(opened.classroom.id))
    check('开课自带一条系统记录', opened.messages.length === 1 && opened.messages[0].role === 'system')
    check('课堂已生成笔记', opened.notes.includes('## 二、课堂实录'))

    const reopened = await openClassroom(root, { courseId: 'learn-20261115-demo', title: '同名再进' })
    check('同课程再进不新建课堂', reopened.classroom.id === opened.classroom.id)
    check('再进不重复追加开课记录', reopened.messages.length === 1)

    const id = opened.classroom.id
    const a = await appendMessage(root, id, {
      id: 'm-fixed-1', role: 'professor', kind: 'teach', sectionRef: '第 3.2 节',
      pointNo: 'K12', content: '抽样检验按每批 5% 执行，不足 20 件时全检。\n此处为适用边界。',
      refs: ['第 3.2 节表格第二行'],
    })
    check('追加教授讲解', !a.duplicate && a.message.seq === 2)
    check('笔记包含讲解全文', a.notes.includes('抽样检验按每批 5% 执行') && a.notes.includes('此处为适用边界'))
    check('笔记保留章节与知识点标注', a.notes.includes('第 3.2 节') && a.notes.includes('K12') && a.notes.includes('原文依据'))
    check('章节索引列出实录序号', /\| 第 3\.2 节 \| 2 \|/.test(a.notes))
    check('知识点索引列出实录序号', /\| K12 \| 2 \|/.test(a.notes))

    const dup = await appendMessage(root, id, {
      id: 'm-fixed-1', role: 'professor', kind: 'teach', content: '重复提交',
    })
    check('重复记录 ID 幂等', dup.duplicate === true && dup.messages.length === 2)
    check('幂等提交不改笔记', dup.notes === a.notes)

    const b = await appendMessage(root, id, {
      role: 'student', kind: 'answer', sectionRef: '第 3.2 节',
      content: '我理解为每批抽 10%，不足 20 件时抽检一半。',
    })
    const c = await appendMessage(root, id, {
      role: 'user', kind: 'correction', sectionRef: '第 3.2 节',
      content: '这里两边口径不一致，以原文表格为准复核。',
    })
    const d = await appendMessage(root, id, {
      role: 'student', kind: 'question', content: '若批次跨两条产线，抽样基数怎么算？',
    })
    check('四类角色与类型都记下', [a, b, c, d].every(x => !x.duplicate))
    check('消息序号连续', d.message.seq === 5)
    check('笔记含全部五条内容', [a, b, c, d].every(x => d.notes.includes(x.message.content.trim().split('\n')[0])))
    check('疑问段汇总', /### 疑问（1）/.test(d.notes) && d.notes.includes('抽样基数怎么算'))
    check('指正段汇总', /### 指正（1）/.test(d.notes) && d.notes.includes('以原文表格为准复核'))
    check('概览统计正确', /\| 消息总数 \| 5 \|/.test(d.notes) && /\| 教授发言 \| 1 \|/.test(d.notes))
    check('涉及章节去重', /\| 涉及章节 \| 1 \|/.test(d.notes))

    const again = await getClassroom(root, id)
    check('重读笔记与落盘一致', again.notes === d.notes)
    check('重读消息条数一致', again.messages.length === 5)
    check('笔记重建确定性', buildNotes(again.classroom, again.messages) === d.notes)

    const concurrent = await Promise.all([
      appendMessage(root, id, { role: 'professor', kind: 'note', content: '并发 A' }),
      appendMessage(root, id, { role: 'professor', kind: 'note', content: '并发 B' }),
    ])
    const afterConcurrent = await getClassroom(root, id)
    check('并发追加不丢消息', afterConcurrent.messages.length === 7)
    check('并发序号不重复', new Set(afterConcurrent.messages.map(m => m.seq)).size === 7)
    check('并发内容都进笔记', afterConcurrent.notes.includes('并发 A') && afterConcurrent.notes.includes('并发 B'))

    let rejected = 0
    const mustReject = async fn => { try { await fn(); return false } catch { rejected++; return true } }
    await mustReject(() => getClassroom(root, '../escape'))
    await mustReject(() => appendMessage(root, id, { role: 'root', kind: 'note', content: 'x' }))
    await mustReject(() => appendMessage(root, id, { role: 'user', kind: 'note', content: '' }))
    await mustReject(() => appendMessage(root, id, { role: 'user', kind: 'note', content: 'x'.repeat(20001) }))
    await mustReject(() => appendMessage(root, id, { role: 'user', kind: 'note', content: 'x', id: '../bad' }))
    check('五类非法输入都被拒绝', rejected === 5)

    const dir = classroomDir(root, id)
    await appendFile(join(dir, 'dialogue.jsonl'), '{ this is not json }\n', 'utf8')
    const corrupt = await getClassroom(root, id)
    check('坏行被跳过且计数', corrupt.corruptLines === 1 && corrupt.messages.length === 7)
    await appendMessage(root, id, { role: 'user', kind: 'note', content: '坏行之后仍能继续记录' })
    const afterCorrupt = await getClassroom(root, id)
    check('坏行之后继续可写', afterCorrupt.messages.length === 8 && afterCorrupt.notes.includes('坏行之后仍能继续记录'))
    check('坏行如实写进概览', afterCorrupt.notes.includes('原始记录损坏行'))

    const listed = await listClassrooms(root)
    check('课堂列表可读', listed.classrooms.length === 1 && listed.classrooms[0].id === id)
    const second = await openClassroom(root, { title: '自由课堂' })
    check('无课程 ID 也能开自由课堂', second.classroom.id !== id)
    const emptyCourse = await openClassroom(root, { courseId: '', title: '' })
    check('空字符串课程 ID 等价于自由课堂', !emptyCourse.classroom.courseId && !!emptyCourse.classroom.title)
    check('列表含三间课堂', (await listClassrooms(root)).classrooms.length === 3)

    // --- Web route layer, with a mock webCtx (no DSH process needed) ---
    const { mountAcademy } = await import(new URL('./academy.js', import.meta.url).href)
    const routes = []
    const pages = []
    const injects = []
    const webCtx = {
      effect: fn => { fn(); return () => {} },
      webServer: { register: p => { pages.push(p); return () => {} } },
      connection: { fetch: { register: r => { routes.push(r); return () => {} } } },
      on: name => { injects.push(name); return () => {} },
    }
    const ctx = {
      inject: (_deps, cb) => { cb(webCtx); return () => {} },
      root: { logger: () => ({ info() {}, warn() {} }) },
    }
    const cfg = {
      stateRoot: root, knowledgeRoot, learnedDir: 'learned',
    }
    await mountAcademy(ctx, cfg, async () => {})
    check('学院页面注册，入口交给客户端插件', pages.length === 1 && !injects.includes('webserver/index-inject'))
    check('接口总数扩到十二条', routes.length === 12)

    const call = async (path, options) => {
      const [pathname, query] = path.split('?')
      const route = routes.find(r => r.path === pathname)
      if (!route) throw new Error(`missing route ${pathname}`)
      const url = `http://local${pathname}${query ? `?${query}` : ''}`
      const response = await route.fetch(new Request(url, options))
      return { status: response.status, body: await response.json() }
    }
    const post = (path, body) => call(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    const empty = await call('/api/academy/classrooms')
    check('课堂列表接口可用', empty.status === 200 && Array.isArray(empty.body.classrooms))

    const openedApi = await post('/api/academy/classroom', {
      action: 'open', courseId: 'learn-api-demo', title: '接口层验收课',
    })
    check('接口开课成功', openedApi.status === 200 && /^class-/.test(openedApi.body.classroom.id))
    check('开课接口返回笔记', typeof openedApi.body.notes === 'string' && openedApi.body.notes.includes('课堂实录'))
    const apiId = openedApi.body.classroom.id

    const sameApi = await post('/api/academy/classroom', { action: 'open', courseId: 'learn-api-demo' })
    check('接口层同课程幂等', sameApi.body.classroom.id === apiId && sameApi.body.messages.length === 1)

    const sent = await post('/api/academy/classroom', {
      action: 'append', id: apiId,
      message: {
        id: 'm-api-1', role: 'professor', kind: 'teach', sectionRef: '第 1 章',
        content: '接口层的一条课堂讲解，必须进笔记。',
      },
    })
    check('接口追加消息', sent.status === 200 && sent.body.message.seq === 2)
    check('接口返回更新后的笔记', sent.body.notes.includes('接口层的一条课堂讲解'))
    check('接口返回消息序列', sent.body.messages.length === 2)

    const sentDup = await post('/api/academy/classroom', {
      action: 'append', id: apiId,
      message: { id: 'm-api-1', role: 'professor', kind: 'teach', content: '重复' },
    })
    check('接口层幂等', sentDup.body.duplicate === true && sentDup.body.messages.length === 2)

    const got = await call(`/api/academy/classroom?id=${encodeURIComponent(apiId)}`)
    check('接口读取课堂详情', got.status === 200 && got.body.classroom.id === apiId && got.body.messages.length === 2)
    check('详情含全量笔记', got.body.notes.includes('接口层的一条课堂讲解'))

    const badId = await post('/api/academy/classroom', {
      action: 'append', id: '../escape', message: { role: 'user', kind: 'note', content: 'x' },
    })
    check('接口拒绝路径穿越', badId.status === 400)
    const badAction = await post('/api/academy/classroom', { action: 'delete' })
    check('接口拒绝未知操作', badAction.status === 400)
    const badRole = await post('/api/academy/classroom', {
      action: 'append', id: apiId, message: { role: 'hacker', kind: 'note', content: 'x' },
    })
    check('接口拒绝非法角色', badRole.status === 400)
    const missing = await call('/api/academy/classroom?id=class-does-not-exist')
    check('接口对不存在的课堂返回 404', missing.status === 404)
    const traversal = await call('/api/academy/course?rel=' + encodeURIComponent('../secret.md'))
    check('原有讲义接口路径防护未回退', traversal.status === 404)

    // --- 教材库：入库不上课、开学绑版本、重学另起一次 ---
    const b64 = text => Buffer.from(text, 'utf8').toString('base64')
    const initial = await call('/api/academy/materials')
    check('教材库列表初始为空', initial.status === 200 && initial.body.materials.length === 0)

    const ingested = await post('/api/academy/material/upload', {
      title: '触摸模组检验规范',
      tags: '规范,检验',
      files: [
        { name: '正文.md', contentBase64: b64('# 第一章 范围\n本规范适用于整机检验。\n') },
        { name: '附录A.md', contentBase64: b64('# 附录 A\n公差表 T1。\n') },
      ],
    })
    check('入库成功且合并为 2 个附件', ingested.status === 200 && ingested.body.material.parts === 2)
    check('入库后状态是未学习', ingested.body.material.status === 'uploaded' && ingested.body.material.statusLabel === '未学习')
    const materialId = ingested.body.material.id
    check('入库后教材列表可读', (await call('/api/academy/materials')).body.materials.length === 1)

    const listedAfterIngest = await call('/api/academy/materials')
    check('列表带版本与附件数', listedAfterIngest.body.materials[0].version === 1 && listedAfterIngest.body.materials[0].parts === 2)

    const detail = await call(`/api/academy/material?id=${encodeURIComponent(materialId)}&source=1`)
    check('教材详情可读合并正文', detail.status === 200 && detail.body.markdown.includes('# 附件 2：附录A.md'))
    check('教材详情带版本历史', detail.body.history.length === 1 && detail.body.record.parts === 2)

    const enteredFresh = await post('/api/academy/material/enter', { id: materialId })
    check('没开过课时进入课堂会建一间', enteredFresh.status === 200
      && enteredFresh.body.existing === false && /^class-/.test(enteredFresh.body.classroomId))
    check('只是进课堂不算学过', enteredFresh.body.material.attempts === 0
      && enteredFresh.body.material.status === 'uploaded')
    check('建课堂不动教材的附件与版本', enteredFresh.body.material.parts === 2
      && enteredFresh.body.material.version === 1)

    const started = await post('/api/academy/material/learn', { id: materialId })
    check('开学返回课堂 ID', started.status === 200 && /^class-/.test(started.body.classroomId))
    check('开学后状态转学习中', started.body.material.status === 'studying')
    check('课堂 meta 绑定教材与版本', started.body.classroom.materialId === materialId
      && started.body.classroom.materialVersion === 1 && started.body.classroom.attempt === 1)
    check('开学即建好教学状态', started.body.teaching && started.body.teaching.stage === 'ready')
    const firstClassroom = started.body.classroomId

    const enteredAgain = await post('/api/academy/material/enter', { id: materialId })
    check('进入课堂复用已有课堂', enteredAgain.status === 200 && enteredAgain.body.existing === true
      && enteredAgain.body.classroomId === firstClassroom)
    check('进入课堂一并带回历史次数', Array.isArray(enteredAgain.body.attempts)
      && enteredAgain.body.attempts.length === 1 && enteredAgain.body.attempts[0].classroomId === firstClassroom)

    const resumed = await post('/api/academy/material/learn', { id: materialId })
    check('学习中再点开始回到同一间课堂', resumed.body.resumed === true && resumed.body.classroomId === firstClassroom)

    const restarted = await post('/api/academy/material/learn', { id: materialId, mode: 'new' })
    check('重学另起第 2 次', restarted.body.resumed === false
      && restarted.body.classroomId !== firstClassroom && restarted.body.classroom.attempt === 2)
    check('重学不改第一间的版本绑定', restarted.body.classroom.materialVersion === 1)
    const secondClassroom = restarted.body.classroomId

    const enterLatest = await post('/api/academy/material/enter', { id: materialId })
    check('进入课堂进的是最近一次', enterLatest.body.classroomId === secondClassroom
      && enterLatest.body.attempts.length === 2)

    const bumped = await post('/api/academy/material/upload', {
      id: materialId,
      title: '触摸模组检验规范',
      files: [{ name: '正文-v2.md', contentBase64: b64('# 第一章 范围（第二版）\n抽样改为每批 8%。\n') }],
    })
    check('换版升到 v2', bumped.status === 200 && bumped.body.material.version === 2)
    check('换版后状态回到未学习', bumped.body.material.status === 'uploaded' && bumped.body.material.parts === 1)
    const v1Detail = await call(`/api/academy/material?id=${encodeURIComponent(materialId)}&version=1`)
    check('旧版仍在且带原来两个附件', v1Detail.status === 200 && v1Detail.body.record.parts === 2)
    const enteredV2 = await post('/api/academy/material/enter', { id: materialId })
    check('换版后进入课堂按 v2 另起一次', enteredV2.body.existing === false
      && enteredV2.body.classroom.materialVersion === 2 && enteredV2.body.classroom.attempt === 3)
    const studyV2 = await post('/api/academy/material/learn', { id: materialId, mode: 'new' })
    check('再学一遍把待转正的课堂转正，不另建同号课堂', studyV2.body.resumed === false
      && studyV2.body.classroom.materialVersion === 2 && studyV2.body.classroom.attempt === 3
      && studyV2.body.classroomId === enteredV2.body.classroomId
      && studyV2.body.material.status === 'studying')

    const badExt = await post('/api/academy/material/upload', {
      files: [{ name: '老文件.doc', contentBase64: b64('x') }],
    })
    check('入库拒绝 .doc', badExt.status === 415)
    const emptyUpload = await post('/api/academy/material/upload', { files: [] })
    check('入库拒绝空文件列表', emptyUpload.status === 400)
    const missingMaterial = await post('/api/academy/material/learn', { id: 'mat-20260101000000-deadbeef' })
    check('开学拒绝不存在的教材', missingMaterial.status === 404)

    // 附加信息是摘要，超限要自动收缩，不能把整句话挡回去（结课确认那条就这么丢过）
    const fatMeta = await post('/api/academy/classroom', {
      action: 'append',
      id: enteredV2.body.classroomId,
      message: {
        role: 'professor', kind: 'teach', content: 'meta 收缩测试',
        meta: { step: 'audit', issues: Array.from({ length: 40 }, (_, i) => ({ no: i + 1, where: 'w'.repeat(80), message: 'm'.repeat(200) })) },
      },
    })
    check('超大 meta 自动收缩仍能入账', fatMeta.status === 200)
    const shrunk = (fatMeta.body.message && fatMeta.body.message.meta) || {}
    check('收缩后留下原长度', typeof shrunk.shrunkFrom === 'number' && shrunk.shrunkFrom > 4000)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  // Regressions of the two earlier rule kernels, executed for real.
  for (const file of ['contract.js', 'divergence.js']) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        fileURLToPath(new URL(`./${file}`, import.meta.url)), '--selftest',
      ])
      const tail = String(stdout).trim().split(/\r?\n/).slice(-1)[0]
      check(`${file} 回归通过（${tail}）`, /\b0 failed\b/.test(String(stdout)))
    } catch (error) {
      check(`${file} 回归通过（${error.message}）`, false)
    }
  }

  console.log(`\n课堂内核与接口层自检：${passed} 项通过，${failures.length} 项失败`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  if (failures.length) process.exitCode = 1
  return { passed, failed: failures.length }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
if (invoked === self && process.argv.includes('--selftest')) {
  runSelftest().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

export { runSelftest }
