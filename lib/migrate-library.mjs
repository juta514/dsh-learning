/**
 * 一次性迁移：把学院里已有的课堂与流水线学习记录并进教材库。
 *
 * 为什么要迁：旧模型是「一次上传 = 一门课」，首页列的是会话；新模型列的是
 * 教材。两套列表同时出现，用户会以为坏了。迁完之后旧记录挂在教材的
 * attempts 上，首页只剩一份教材列表，点「展开看旧记录」仍能看到会话。
 *
 * 规则：
 *   - 同一份原文只建一本教材，重复的课堂归成第 2、3 次学习；
 *   - 教学已结课的标 completed，没结课的标 studying；
 *   - 课堂没有原文（空壳课堂）不迁，只留目录；
 *   - 流水线会话按 sessions/<id>/source.txt 迁，课堂 ID 记为空。
 *
 * 用法：
 *   node lib/migrate-library.mjs --state "~/.dsh/learning" --dry
 *   node lib/migrate-library.mjs --state "~/.dsh/learning"
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  addAttempt, closeAttempt, createFromText, listMaterials, readMaterial, setStatus,
} from './library.js'

const args = process.argv.slice(2)
const stateRoot = (args[args.indexOf('--state') + 1] || '').trim()
const dry = args.includes('--dry')
if (!stateRoot) {
  console.error('缺少 --state <状态目录>')
  process.exit(2)
}

const norm = text => String(text || '').replace(/\s+/g, ' ').trim()
const fingerprint = text => createHash('sha256').update(norm(text), 'utf8').digest('hex').slice(0, 16)

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

// 先用现有教材建指纹索引，重复跑不会重复建书
const existing = (await listMaterials(stateRoot)).materials
const byPrint = new Map()
for (const item of existing) {
  try {
    const meta = await readMaterial(stateRoot, item.id)
    const record = meta.versions[0]
    const text = await readFile(join(stateRoot, 'library', item.id, record.source), 'utf8')
    byPrint.set(fingerprint(text), item.id)
  } catch { /* 旧目录坏了就跳过 */ }
}

const plan = []

async function ensureMaterial({ text, title, createdAt, source, fingerprint: fp }) {
  const known = byPrint.get(fp)
  if (known) return { id: known, created: false }
  const meta = await createFromText(stateRoot, {
    text,
    title: title || '未命名教材',
    createdAt,
    source,
    partName: '课堂原文.md',
    id: `mat-${String(createdAt || new Date().toISOString()).replace(/[-:T]/g, '').slice(0, 14)}-${fp.slice(0, 8)}`,
  })
  byPrint.set(fp, meta.id)
  return { id: meta.id, created: true }
}

// --- 1. 课堂 ---
let classroomEntries = []
try { classroomEntries = await readdir(join(stateRoot, 'classrooms'), { withFileTypes: true }) } catch { /* 没有课堂 */ }

for (const entry of classroomEntries) {
  if (!entry.isDirectory()) continue
  const dir = join(stateRoot, 'classrooms', entry.name)
  const meta = await readJson(join(dir, 'meta.json'))
  if (!meta || !meta.id) continue
  let source = ''
  try { source = await readFile(join(dir, 'source.md'), 'utf8') } catch { source = '' }
  if (!source.trim()) {
    plan.push({ kind: 'skip-empty', classroomId: meta.id, title: meta.title })
    continue
  }
  const teaching = await readJson(join(dir, 'teaching.json'))
  const finished = teaching?.stage === 'finished'
  const fp = fingerprint(source)
  const known = byPrint.get(fp)
  plan.push({
    kind: 'classroom',
    classroomId: meta.id,
    title: teaching?.title || meta.title || '课堂原文',
    chars: source.length,
    finished,
    exists: Boolean(known),
  })
  if (dry) continue

  const { id } = await ensureMaterial({
    text: source,
    title: teaching?.title || meta.title || '课堂原文',
    createdAt: meta.createdAt,
    source: 'migrated-classroom',
    fingerprint: fp,
  })
  // 同一份原文的第二个课堂就是第二次学习，序号由 addAttempt 递增
  const { n } = await addAttempt(stateRoot, id, { classroomId: meta.id, version: 1 })
  if (finished) await closeAttempt(stateRoot, id, n, 'finished')
  else await setStatus(stateRoot, id, 'studying')
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify({
    ...meta,
    materialId: id,
    materialVersion: 1,
    attempt: n,
    materialTitle: teaching?.title || meta.title || '',
  }, null, 2)}\n`, 'utf8')
}

// --- 2. 流水线会话 ---
let sessionEntries = []
try { sessionEntries = await readdir(join(stateRoot, 'sessions'), { withFileTypes: true }) } catch { /* 没有会话 */ }

for (const entry of sessionEntries) {
  if (!entry.isDirectory() || !entry.name.startsWith('learn-')) continue
  const dir = join(stateRoot, 'sessions', entry.name)
  const state = await readJson(join(dir, 'state.json'))
  if (!state) continue
  let source = ''
  try { source = await readFile(join(dir, 'source.txt'), 'utf8') } catch { source = '' }
  if (!source.trim()) {
    plan.push({ kind: 'skip-session', sessionId: entry.name, title: state.result?.title })
    continue
  }
  const fp = fingerprint(source)
  const known = byPrint.get(fp)
  plan.push({
    kind: 'session',
    sessionId: entry.name,
    title: state.result?.title || state.source?.name,
    chars: source.length,
    status: state.status,
    exists: Boolean(known),
  })
  if (dry) continue
  const { id } = await ensureMaterial({
    text: source,
    title: state.result?.title || state.source?.name || entry.name,
    createdAt: state.startedAt || state.finishedAt,
    source: `migrated-session:${entry.name}`,
    fingerprint: fp,
  })
  const { n } = await addAttempt(stateRoot, id, { classroomId: '', version: 1 })
  if (state.status === 'completed' || state.status === 'completed_needs_review') {
    await closeAttempt(stateRoot, id, n, state.status)
  } else {
    await setStatus(stateRoot, id, 'studying')
  }
}

console.log(dry ? '干跑，不写盘：' : '迁移完成：')
for (const row of plan) console.log('  ' + JSON.stringify(row))
const final = await listMaterials(stateRoot)
console.log(`\n教材库现有 ${final.materials.length} 本：`)
for (const m of final.materials) {
  console.log(`  ${m.id} · ${m.title} · ${m.statusLabel} · v${m.version} · ${m.parts} 附件 · ${m.chars} 字 · 学过 ${m.attempts} 次`)
}
