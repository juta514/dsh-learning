/**
 * 一次性补数：把流水线时代学完的教材，把学习结果补回 attempts。
 *
 * 迁移只搬了原文与状态，笔记字数、题库题数、考核得分还留在
 * learned/*.md 的 frontmatter 里，卡片上就空着。这里按教材 source 里记的
 * 会话 ID 去对讲义的 learning_session，对上就写回 attempt.stats，
 * 顺手把讲义的 description 当作教材简介。
 *
 * 可重复跑：已经有 stats 或已经绑了课堂的 attempt 不会被覆盖。
 *
 * 用法：
 *   node lib/backfill-stats.mjs --state "~/.dsh/learning" \
 *     --learned "~/.dsh/youlian-knowledge/.../docs/learned" --dry
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = name => {
  const i = args.indexOf(name)
  return i >= 0 ? String(args[i + 1] || '').trim() : ''
}
const stateRoot = argOf('--state')
const learnedDir = argOf('--learned')
const dry = args.includes('--dry')
if (!stateRoot || !learnedDir) {
  console.error('缺少 --state <状态目录> 或 --learned <讲义目录>')
  process.exit(2)
}

function frontmatter(text) {
  const out = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { /* keep */ } }
    else if (/^(true|false)$/i.test(value)) value = /^true$/i.test(value)
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value)
    out[kv[1]] = value
  }
  return out
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

// 讲义索引：learning_session → 这份讲义的元数据
const index = new Map()
let files = []
try { files = await readdir(learnedDir) } catch {
  console.error(`讲义目录读不到：${learnedDir}`)
  process.exit(2)
}
for (const file of files) {
  if (!file.toLowerCase().endsWith('.md')) continue
  let text = ''
  try { text = await readFile(join(learnedDir, file), 'utf8') } catch { continue }
  const fm = frontmatter(text)
  if (!fm.learning_session) continue
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  index.set(String(fm.learning_session), {
    file,
    title: fm.title || file.replace(/\.md$/i, ''),
    // 讲义的 description 常常以「由学习流水线从《…》提炼：」开头，卡片上不要这句。
    intro: String(fm.description || '').trim().replace(/^由学习流水线从《[^》]*》提炼[:：]\s*/, ''),
    notesChars: body.length,
    bank: Number(fm.quiz_questions) || 0,
    score: fm.quiz_score == null ? null : Math.round(Number(fm.quiz_score) * 100),
    points: Number(fm.knowledge_points) || 0,
  })
}

const rows = []
let materialDirs = []
try { materialDirs = await readdir(join(stateRoot, 'library')) } catch {
  console.error('教材库还不存在，先跑一次入库')
  process.exit(2)
}

for (const dir of materialDirs) {
  if (!dir.startsWith('mat-')) continue
  const metaFile = join(stateRoot, 'library', dir, 'meta.json')
  const meta = await readJson(metaFile)
  if (!meta) continue
  const source = String(meta.source || '')
  if (!source.startsWith('migrated-session:')) continue
  const session = source.slice('migrated-session:'.length)
  const learned = index.get(session)
  if (!learned) {
    rows.push({ id: meta.id, title: meta.title, action: 'skip', why: '讲义里找不到这个会话' })
    continue
  }
  let changed = false
  for (const attempt of meta.attempts || []) {
    if (attempt.classroomId || attempt.stats) continue
    attempt.stats = {
      notesChars: learned.notesChars,
      bank: learned.bank,
      exam: {
        asked: learned.bank,
        answered: learned.bank,
        total: learned.bank,
        avg: learned.score,
        passLine: 75,
      },
    }
    // 讲义字数就是笔记字数，题库与得分按当时的 frontmatter，来源写清楚
    attempt.stats.source = `learned/${learned.file}`
    changed = true
    const file = join(stateRoot, 'library', dir, 'attempts', String(attempt.n), 'attempt.json')
    if (!dry) {
      const stored = await readJson(file, { ...attempt, materialId: meta.id, title: meta.title })
      await writeFile(file, `${JSON.stringify({
        ...stored,
        stats: attempt.stats,
        materialId: meta.id,
        title: meta.title,
      }, null, 2)}\n`, 'utf8')
    }
  }
  if (!String(meta.intro || '').trim() && learned.intro) {
    meta.intro = learned.intro.length > 140 ? `${learned.intro.slice(0, 140)}…` : learned.intro
    changed = true
  }
  if (changed && !dry) {
    meta.updatedAt = meta.updatedAt || new Date().toISOString()
    await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  }
  rows.push({
    id: meta.id,
    title: meta.title,
    action: changed ? 'patched' : 'skip',
    notes: learned.notesChars,
    bank: learned.bank,
    score: learned.score,
  })
}

console.log(dry ? '干跑，不写盘：' : '补数完成：')
for (const row of rows) console.log('  ' + JSON.stringify(row))
