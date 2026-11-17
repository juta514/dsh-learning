/**
 * 智能助理学院 — 交付入库。
 *
 * 把定稿笔记、题库、双向溯源索引写成知识库文件，再交给 ReMe 长期记忆，
 * 最后回读检索验证「真的能查到」。课堂只是学习现场，这里是它唯一被允许
 * 写知识库的地方；任何一步失败都如实记账，不谎报成功。
 *
 *   node lib/commit.js --selftest
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha256 = text => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')

function within(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) return t
  throw new Error(`拒绝写入知识目录之外的路径：${t}`)
}

function slugify(value) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70)
  return cleaned || 'untitled'
}

const yamlQuote = value => JSON.stringify(String(value ?? ''))

const LIBRARY_SKILL_HEAD = `---
name: learned-library
description: '已学习资料的统一检索入口。智能助理学院把规范、规格书、课件学完后，会把精读笔记、题库与原文溯源索引写成 docs/learned/ 下的文件，本技能维护全部学习产物的清单。回答涉及"学过什么、某份规范讲了什么、知识点地图、学习产物、考前复习"时加载，按清单定位文件后再 read。'
---

# 已学习资料清单

本文件由智能助理学院自动维护，只追加不覆盖。每一条对应一次完整的精读闭环：全文切片 → 逐片精读 → 八项自动校验 → 人工复核 → 按条款出题 → 双向溯源 → 入库。清单路径相对于 \`skills/product-knowledge/docs/\`，用文件读取工具打开即可。规范原件在 \`docs/standards/\`，学习产物是理解记录，不替代原件。

| 学习产物 | 主题 | 笔记倍数 | 覆盖率 | 题数 | 状态 |
|---|---|---|---|---|---|
`

async function postJson(url, body, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = { answer: String(text).slice(0, 300) } }
    return { ok: response.ok, status: response.status, data: parsed }
  } finally {
    clearTimeout(timer)
  }
}

/** 题库的 Markdown 版本：入库文件与长期记忆用同一份文本。 */
export function quizMarkdown(state, quiz) {
  const lines = [`# ${state.title} · 考核题库`, '',
    `> 共 ${quiz.length} 题，每条条款至少一题；判分关键词是原文原句，可回查片段。`, '']
  quiz.forEach((question, index) => {
    lines.push(`## 第 ${index + 1} 题（条款 ${question.clause}｜${question.angle}）⟦${(question.segments || []).join(' ')}⟧`, '',
      question.q, '', `- 判分关键词（原文逐字）：${question.answer_contains}`,
      question.rubric?.length ? `- 判分要点：${question.rubric.join('；')}` : '', '')
  })
  return `${lines.join('\n').trim()}\n`
}

/** 题库 + 溯源索引，接在笔记正文后面，一份文件读完。 */
export function renderDelivery(state, quiz, provenance) {
  const lines = ['', '## 九、考核题库', '']
  const questions = quiz || []
  if (!questions.length) lines.push('（题库为空）')
  questions.forEach((q, i) => {
    lines.push(`### 第 ${i + 1} 题（条款 ${q.clause}｜${q.angle}）⟦${(q.segments || []).join(' ')}⟧`, '',
      q.q, '', `- 判分关键词（原文逐字）：${q.answer_contains}`,
      q.rubric?.length ? `- 判分要点：${q.rubric.join('；')}` : '', '')
  })
  lines.push('## 十、原文溯源索引', '')
  lines.push('| 原文片段 | 对应知识点 | 对应题目 |')
  lines.push('| --- | --- | --- |')
  const rows = Object.entries(provenance?.bySegment || {}).slice(0, 400)
  for (const [segment, hit] of rows) {
    lines.push(`| ${segment} | ${(hit.notes || []).join(' ') || '—'} | ${(hit.questions || []).join(' ') || '—'} |`)
  }
  lines.push('', `原文封条：\`${provenance?.source?.sha256 || ''}\`；`
    + `笔记哈希：\`${provenance?.notes?.sha256 || ''}\`；两处哈希与文件一致才说明这份交付没被改过。`, '')
  return lines.join('\n')
}

/**
 * 学习台账：每份已学资料一条，按课堂幂等更新；同一份的新版会把旧版标成「已被新版取代」。
 * 文件是权威（人读 md + 机器读 json），ReMe 里再放一份压缩版供跨会话检索。
 */
export async function upsertLearningRecords({ cfg, state, quiz, input, reme, slug, learnedDir, docPath, quizPath, examPaperPath, answerKeyPath, provenancePath, noteSha }) {
  const dir = within(cfg.knowledgeRoot, resolve(cfg.knowledgeRoot, learnedDir))
  const jsonPath = within(cfg.knowledgeRoot, resolve(dir, 'LEARNING-RECORDS.json'))
  const mdPath = within(cfg.knowledgeRoot, resolve(dir, 'LEARNING-RECORDS.md'))
  let records = []
  try {
    const raw = JSON.parse(await readFile(jsonPath, 'utf8'))
    if (Array.isArray(raw?.records)) records = raw.records
  } catch { /* 第一次生成 */ }
  const rel = value => {
    const text = String(value || '')
    const prefix = `${cfg.knowledgeRoot}${sep}`
    return (text.startsWith(prefix) ? text.slice(prefix.length) : text).split(sep).join('/')
  }
  const exam = state.exam || {}
  const accepted = (state.pendingCorrections || []).filter(item => item.status === 'accepted').length
  const entry = {
    title: String(state.title || ''),
    slug,
    classroomId: input.classroomId || '',
    version: Number(state.sourceVersion) || 1,
    sourceName: state.sourceFile?.name || state.sourceName || 'source.md',
    sourceSha: state.sourceHash || '',
    noteSha: noteSha || '',
    coverage: state.study?.coverage ? `${state.study.coverage.covered}/${state.study.coverage.total}` : '',
    ratio: state.study?.ratio ?? null,
    points: Object.values(state.study?.chunks || {}).flatMap(row => row.points || []).length,
    questions: (quiz || []).length,
    exam: {
      sampled: (exam.sample || []).length,
      passed: exam.passed || 0,
      rate: exam.passRate == null ? null : exam.passRate,
    },
    reviewedAt: String(state.review?.decidedAt || '').slice(0, 10),
    corrections: accepted,
    status: 'active',
    files: {
      doc: rel(docPath),
      quiz: rel(quizPath),
      exam: rel(examPaperPath),
      answers: rel(answerKeyPath),
      provenance: rel(provenancePath),
    },
    reme: { parts: reme.parts || 0, manifest: '' },
    updatedAt: new Date().toISOString(),
  }
  const at = entry.classroomId ? records.findIndex(item => item.classroomId === entry.classroomId) : -1
  if (at >= 0) records[at] = { ...records[at], ...entry }
  else records.push(entry)
  // 同一份资料只留版本最高的为「在用」，其余标成被取代
  const latest = new Map()
  for (const item of records) {
    const key = item.slug
    const version = Number(item.version) || 1
    if (!latest.has(key) || version > latest.get(key)) latest.set(key, version)
  }
  for (const item of records) {
    item.status = (latest.get(item.slug) || 1) > (Number(item.version) || 1) ? 'superseded' : 'active'
  }
  await writeFile(jsonPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), records }, null, 2)}\n`, 'utf8')
  await writeFile(mdPath, renderLearningRecords(records, learnedDir), 'utf8')
  // 记忆里放一份：别的会话搜「学习记录 / 学习台账」就能命中
  let remePath = ''
  try {
    if (cfg.remeEndpoint) {
      const body = renderLearningRecordsBody(records)
      const write = await postJson(`${cfg.remeEndpoint}/daily_write`, {
        name: 'learning-records',
        description: '学习台账：每份已学资料在哪一版、学得怎么样、路径与记忆分段（跨会话快速查找）',
        session_id: 'digest',
        content: body,
        metadata: { memory_tags: ['智能助理学院', '学习记录'], records: records.length },
      })
      const path = String(write.data?.metadata?.path || '')
      const read = path ? await postJson(`${cfg.remeEndpoint}/read`, { path }, 30000).catch(() => null) : null
      const stored = read?.ok ? stripFrontmatter(String(read.data?.answer ?? '')) : ''
      remePath = path && normalizeStored(stored) === normalizeStored(body) ? path : ''
      if (remePath) await postJson(`${cfg.remeEndpoint}/reindex`, { scope: 'bm25' }, 60000).catch(() => null)
    }
  } catch { /* 台账记忆是辅助，失败不影响交付 */ }
  return { mdPath, jsonPath, remePath, ok: true, count: records.length }
}

/** 台账的人读版本：一张表 + 快速检索示例。 */
export function renderLearningRecords(records, learnedDir = 'learned') {
  const rows = [...records].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const lines = [
    '# 学习台账（learning records）', '',
    '> 每份已经学完并通过复核的资料：在哪一版、哪个课堂、学得怎么样、怎么回查。',
    '> 机器可读副本：`LEARNING-RECORDS.json`；本文件由交付时自动生成，不要手改。', '',
    '| 标题 | 版本 | 课堂 | 覆盖 | 倍数 | 题数 | 抽考 | 复核日期 | 勘误 | 状态 | 笔记文件 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of rows) {
    const status = item.status === 'superseded' ? '已被新版取代' : '在用'
    const exam = item.exam?.sampled ? `${item.exam.passed}/${item.exam.sampled}` : '—'
    const doc = String(item.files?.doc || '').split('/').pop() || '—'
    lines.push(`| ${String(item.title).replace(/\|/g, '／')} | ${item.version} | ${item.classroomId || '—'} | ${item.coverage || '—'} | ${item.ratio ?? '—'}× | ${item.questions ?? 0} | ${exam} | ${item.reviewedAt || '—'} | ${item.corrections || 0} | ${status} | ${doc} |`)
  }
  lines.push('', '## 怎么快速查', '',
    '- 按标题：`reme_search("学习记录 示例物料清单")`',
    '- 按主题：`reme_search("学习记录 物料分类")`',
    '- 按课堂：`reme_search("学习记录 class-2026...")`',
    `- 直接读文件：\`${learnedDir}/LEARNING-RECORDS.md\`（机器可读：\`LEARNING-RECORDS.json\`）`, '')
  return lines.join('\n')
}

/** 台账的记忆版：压成几条，够检索命中即可。 */
export function renderLearningRecordsBody(records) {
  const rows = [...records].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 40)
  const lines = ['# 学习记录（台账）', '',
    '> 每份已学资料：第几版、哪个课堂、覆盖/倍数/题数、抽考、复核日期、文件与记忆分段。', '']
  for (const item of rows) {
    const status = item.status === 'superseded' ? '（已被新版取代）' : ''
    const exam = item.exam?.sampled ? `抽考 ${item.exam.passed}/${item.exam.sampled}` : '抽考 —'
    lines.push(`- ${item.title}${status}（第 ${item.version} 版 · ${item.classroomId || '—'} · ${item.coverage || '—'} · ${item.ratio ?? '—'}× · ${item.questions ?? 0} 题 · ${exam} · 复核 ${item.reviewedAt || '—'}）`)
    const files = Object.values(item.files || {}).filter(Boolean).join(' ｜ ')
    if (files) lines.push(`  ${files}${item.reme?.parts ? ` ｜ 记忆 ${item.reme.parts} 段` : ''}`)
  }
  lines.push('', '检索示例：reme_search("学习记录 物料分类")；完整台账见知识库 learned/LEARNING-RECORDS.md。')
  return lines.join('\n')
}

/**
 * 交付一次学习产物。
 *
 * @param input 课堂状态、笔记正文、题库、溯源索引与配置
 * @returns 交付报告（写到哪里、ReMe 是否写入并回读命中）
 */
export async function commitLearning(input) {
  const { cfg, state, notesText, quiz, provenance } = input
  if (!cfg.knowledgeRoot) throw new Error('缺少 knowledgeRoot，无法交付')
  const slug = slugify(state.title)
  const learnedDir = cfg.learnedDir || 'learned'
  const dir = within(cfg.knowledgeRoot, resolve(cfg.knowledgeRoot, learnedDir))
  await mkdir(dir, { recursive: true })
  const docPath = within(cfg.knowledgeRoot, resolve(dir, `${slug}.md`))
  const examNote = input.examPaper
    ? `\n## 十一、人员考核\n\n- 试卷：\`${slug}.exam.md\`（可直接打印，闭卷）\n- 答案与判分要点：\`${slug}.answer-key.md\`（内部用，勿发考生）\n`
    : ''
  const accepted = (state.pendingCorrections || []).filter(item => item.status === 'accepted')
  const erratum = accepted.length
    ? `\n## 十二、勘误记录（已确认的更正）\n\n${accepted.map((item, index) => {
      const at = String(item.decidedAt || item.at || '').slice(0, 10)
      return `${index + 1}. ${at}：${item.text}${item.support ? `（原文：${item.support}）` : ''}`
    }).join('\n')}\n`
    : ''
  const sourceSeal = provenance?.source?.sha256 || state.sourceHash || ''
  const versionLine = `> 交付版本：第 ${state.sourceVersion || 1} 版（原文 sha ${String(sourceSeal).slice(0, 16)}…）；本文件与复核锁定的笔记一致。\n`
  const body = `${notesText.trimEnd()}\n\n${versionLine}${renderDelivery(state, quiz, provenance)}${examNote}${erratum}`
  // 旧版先归档：同名文件直接覆盖会丢历史，归档按旧内容哈希命名，重交不会重复写
  let archivedPath = ''
  try {
    const previous = await readFile(docPath, 'utf8')
    if (previous.trim() && previous.trimEnd() !== body.trimEnd()) {
      const archiveDir = within(cfg.knowledgeRoot, resolve(dir, 'archive'))
      await mkdir(archiveDir, { recursive: true })
      const oldSeal = createHash('sha256').update(previous).digest('hex').slice(0, 12)
      const candidate = within(cfg.knowledgeRoot, resolve(archiveDir, `${slug}-${oldSeal}.md`))
      const exists = await readFile(candidate, 'utf8').then(() => true).catch(() => false)
      if (!exists) await writeFile(candidate, previous, 'utf8')
      archivedPath = candidate
    }
  } catch { /* 第一次交付，没有旧版 */ }
  await writeFile(docPath, `${body.trimEnd()}\n`, 'utf8')
  const examPaperPath = within(cfg.knowledgeRoot, resolve(dir, `${slug}.exam.md`))
  const answerKeyPath = within(cfg.knowledgeRoot, resolve(dir, `${slug}.answer-key.md`))
  if (input.examPaper) await writeFile(examPaperPath, input.examPaper, 'utf8')
  if (input.answerKey) await writeFile(answerKeyPath, input.answerKey, 'utf8')
  const quizPath = within(cfg.knowledgeRoot, resolve(dir, `${slug}.quiz.json`))
  await writeFile(quizPath, `${JSON.stringify({ title: state.title, questions: quiz }, null, 2)}\n`, 'utf8')
  const provenancePath = within(cfg.knowledgeRoot, resolve(dir, `${slug}.provenance.json`))
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')

  // 资料索引：同一份只记一行
  let indexPath = ''
  let indexChanged = false
  let index = ''
  const indexFile = within(cfg.knowledgeRoot, resolve(cfg.knowledgeRoot, 'INDEX.md'))
  try {
    index = await readFile(indexFile, 'utf8')
  } catch { index = '# 资料索引（docs/）\n' }
  const marker = `${learnedDir}/${slug}.md`
  const cov = state.study?.coverage
  // 资料索引：同一份只保留一行；已有就更新成这次的数字（比率/覆盖/题数会变）
  const rowText = `| \`${marker}\` | ${String(state.title).replace(/\|/g, '／')} | ${state.study?.ratio ?? 0}× | `
    + `${cov ? `${cov.covered}/${cov.total}` : '—'} | ${(quiz || []).length} | 已复核 |`
  {
    const lines = index.split('\n')
    const at = lines.findIndex(line => line.includes(marker))
    if (at >= 0) {
      if (lines[at] !== rowText) {
        lines[at] = rowText
        await writeFile(indexFile, lines.join('\n'), 'utf8')
        indexPath = indexFile
        indexChanged = true
      }
    } else {
      if (!index.includes(`## 7. ${learnedDir}/ 学习产物`)) {
        index += `\n## 7. ${learnedDir}/ 学习产物\n\n由智能助理学院自动生成，含精读笔记、题库与原文溯源索引。\n\n| 文件 | 主题 | 笔记倍数 | 覆盖率 | 题数 | 状态 |\n|---|---|---|---|---|---|\n`
      }
      index = `${index.trimEnd()}\n${rowText}\n`
      await writeFile(indexFile, index, 'utf8')
      indexPath = indexFile
      indexChanged = true
    }
  }

  // 学习台账指针：完整字段在台账文件，索引里只放一行指路
  if (!index.includes('LEARNING-RECORDS.md')) {
    index = `${index.trimEnd()}\n\n> 学习台账（课堂/版本/抽考/复核/勘误）：\`${learnedDir}/LEARNING-RECORDS.md\`\n`
    await writeFile(indexFile, index, 'utf8')
    indexChanged = true
  }

  // 技能清单：同一份就更新那一行（旧版留下的 0.13/需复核 必须被这次覆盖），
  // 顺手清掉指向已不存在文件的死行，别让模型顺着清单去读空文件。
  let skillPath = ''
  let skillChanged = false
  let skillPruned = 0
  let skillError = ''
  if (cfg.skillsRoot) {
    const skillFile = within(cfg.skillsRoot, resolve(cfg.skillsRoot, 'learned-library', 'SKILL.md'))
    try {
      await mkdir(resolve(skillFile, '..'), { recursive: true })
      let content = ''
      try { content = await readFile(skillFile, 'utf8') } catch { content = LIBRARY_SKILL_HEAD }
      const skillRow = `| \`docs/${marker}\` | ${String(state.title).replace(/\|/g, '／')} | ${state.study?.ratio ?? 0}× | `
        + `${cov ? `${cov.covered}/${cov.total}` : '—'} | ${(quiz || []).length} | 已复核 |`
      const lines = content.split('\n')
      // 表头/说明按当前格式归一：旧版是 4 列「末轮得分」，新版是 6 列
      const headAt = lines.findIndex(line => /^\|\s*学习产物\s*\|/.test(line))
      if (headAt >= 0) {
        const wanted = '| 学习产物 | 主题 | 笔记倍数 | 覆盖率 | 题数 | 状态 |'
        if (lines[headAt] !== wanted) { lines[headAt] = wanted; skillChanged = true }
        if (headAt + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[headAt + 1])) {
          lines[headAt + 1] = '| --- | --- | --- | --- | --- | --- |'
        }
      }
      const introAt = lines.findIndex(line => line.includes('得分低于达标线的条目标为需复核'))
      if (introAt >= 0) {
        lines[introAt] = '清单路径相对于 `skills/product-knowledge/docs/`，用文件读取工具打开即可。规范原件在 `docs/standards/`，学习产物是理解记录，不替代原件；每个条目都附笔记倍数、覆盖率与题数，可据此判断该不该采用。'
        skillChanged = true
      }
      const at = lines.findIndex(line => line.includes(marker))
      if (at >= 0) {
        if (lines[at] !== skillRow) { lines[at] = skillRow; skillChanged = true }
      } else {
        if (lines.length && lines[lines.length - 1] === '') lines.pop()
        lines.push(skillRow)
        skillChanged = true
      }
      // 清理死链接：清单里的路径必须真实存在
      for (let i = lines.length - 1; i >= 0; i--) {
        const match = /^\|\s*`(docs\/[^`]+\.md)`/.exec(lines[i])
        if (!match) continue
        const target = within(cfg.knowledgeRoot, resolve(cfg.knowledgeRoot, match[1].replace(/^docs\//, '')))
        const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
        if (!exists) { lines.splice(i, 1); skillPruned += 1; skillChanged = true }
      }
      if (!lines.join('\n').includes('LEARNING-RECORDS.md')) {
        lines.push('', `完整学习台账：\`docs/${learnedDir}/LEARNING-RECORDS.md\`（课堂/版本/抽考/复核/勘误）。`)
        skillChanged = true
      }
      if (skillChanged) await writeFile(skillFile, `${lines.join('\n').trimEnd()}\n`, 'utf8')
      skillPath = skillFile
    } catch (error) {
      skillError = String(error?.message || error)
    }
  }

  // 定稿笔记必须就是复核时锁定的那一份，否则拒绝入库
  const noteSha = sha256(notesText)
  if (provenance?.notes?.sha256 && provenance.notes.sha256 !== noteSha) {
    throw new Error('定稿笔记与复核时锁定的哈希不一致，拒绝入库：先重新复核再交付')
  }

  // ReMe 长期记忆：全文逐段写入 → 逐段读回比对 → 重建索引 → 检索冒烟。
  // 存进去的是定稿笔记的逐字切片，不是摘要；读回有一个字不一致就判失败。
  const reme = {
    ok: false, dailyWrite: false, reindex: false, searchHit: false,
    exact: false, parts: 0, partsWritten: 0, records: [], missing: [], mismatched: [], error: '',
  }
  if (!cfg.remeEndpoint) {
    reme.error = '未配置 remeEndpoint，长期记忆未写入'
  } else {
    try {
      const built = memoryRecords({
        state,
        notesText,
        maxChars: cfg.memoryPartChars,
        quizText: input.quizText || quizMarkdown(state, quiz || []),
        provenance,
        slug,
        docPath,
        classroomId: input.classroomId,
        quiz: quiz || [],
      })
      if (!built.reconstruction.partsAreVerbatim) throw new Error('内部错误：分段拼接与定稿笔记不一致，拒绝写入')
      reme.parts = built.parts

      // 内容变过：先删上一版的分段，避免旧口径留在记忆里被检索到
      const previous = Array.isArray(input.state?.commit?.reme?.records) ? input.state.commit.reme.records : []
      if (previous.length && input.state?.commit?.notesSha256 && input.state.commit.notesSha256 !== built.noteSha) {
        for (const record of previous) {
          if (record?.path) await postJson(`${cfg.remeEndpoint}/delete`, { path: record.path }, 15000).catch(() => null)
        }
      }

      for (const record of built.records) {
        let write = { ok: false, data: {} }
        try {
          write = await postJson(`${cfg.remeEndpoint}/daily_write`, {
            name: record.name,
            description: record.description,
            session_id: record.session,
            content: record.body,
            metadata: record.metadata,
          })
        } catch (error) {
          reme.error = `写入失败：${String(error?.message || error).slice(0, 160)}`
        }
        const path = String(write.data?.metadata?.path || '')
        const wrote = Boolean(write.ok && write.data?.success !== false && path)
        let exact = false
        if (wrote) {
          const read = await postJson(`${cfg.remeEndpoint}/read`, { path }, 30000)
            .catch(() => ({ ok: false, data: {} }))
          const stored = read.ok ? stripFrontmatter(String(read.data?.answer ?? '')) : ''
          exact = normalizeStored(stored) === normalizeStored(record.body)
        }
        reme.records.push({
          kind: record.kind, name: record.name, path,
          chars: record.body.length, sha256: sha256(record.body), written: wrote, exact,
        })
        if (!wrote) reme.missing.push(record.name)
        else if (!exact) reme.mismatched.push(record.name)
        else if (record.kind === 'part') reme.partsWritten += 1
      }

      reme.dailyWrite = reme.missing.length === 0
      const reindex = await postJson(`${cfg.remeEndpoint}/reindex`, { scope: cfg.reindexScope || 'bm25' }, 120000)
      reme.reindex = Boolean(reindex.ok && reindex.data?.success !== false)
      const probe = built.records.find(record => record.kind === 'part') || built.records[0]
      const probeTerm = (String(probe?.body || '').match(/[\u4e00-\u9fa5]{6,}/g) || [])[0] || String(state.title)
      const search = await postJson(`${cfg.remeEndpoint}/search`, {
        query: `${state.title} ${probeTerm}`,
        limit: 8,
      }, 30000)
      const answerText = String(search.data?.answer ?? '')
      reme.searchHit = answerText.includes(probeTerm) || answerText.includes(String(state.title))
      reme.exact = reme.missing.length === 0 && reme.mismatched.length === 0
      reme.ok = reme.exact && reme.reindex
      if (!reme.exact) reme.error = `长期记忆不完整：缺 ${reme.missing.length} 段、读回不一致 ${reme.mismatched.length} 段`
      // 查重：把与这份笔记相关的其它记录列出来（不合并、不删除），
      // 同一主题在别的会话里也记过时，至少让人看得见，再决定要不要整合。
      const overlap = { probes: 0, count: 0, hits: [] }
      const ownTag = `/learn-${slug}-`
      const probes = [String(state.title), `${String(state.title)} 精读笔记`]
      const firstPoint = Object.values(state.study?.chunks || {})
        .flatMap(chunk => chunk.points || [])
        .find(point => point && point.title)
      if (firstPoint?.title) probes.push(`${String(state.title)} ${firstPoint.title}`)
      const seenPaths = new Set()
      for (const query of probes) {
        try {
          const found = await postJson(`${cfg.remeEndpoint}/search`, { query, limit: 10 }, 30000)
          overlap.probes += 1
          const text = String(found.data?.answer || '')
          for (const match of text.matchAll(/=+\s+(\S+?):\d+-\d+\s+\[score=([\d.]+)/g)) {
            const path = match[1]
            if (path.includes(ownTag) || /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(path) || seenPaths.has(path)) continue
            seenPaths.add(path)
            overlap.hits.push({ path, score: Number(match[2]), probe: query })
          }
        } catch (error) {
          // 查重是辅助信息，检索失败不影响入库结果
          overlap.error = String(error?.message || error).slice(0, 200)
        }
      }
      overlap.count = overlap.hits.length
      reme.overlap = overlap
    } catch (error) {
      reme.error = String(error?.message || error).slice(0, 200)
    }
  }

  // 学习台账：文件（权威）+ 一条记忆（跨会话可检索）
  let ledger = { mdPath: '', jsonPath: '', remePath: '', error: '' }
  try {
    ledger = await upsertLearningRecords({
      cfg, state, quiz, input, reme, slug, learnedDir,
      docPath, quizPath, examPaperPath, answerKeyPath, provenancePath, noteSha,
    })
  } catch (error) {
    ledger.error = String(error?.message || error).slice(0, 200)
  }

  const memoryText = reme.ok
    ? `长期记忆 ${reme.parts} 段全文已写入并逐段读回一致`
    : `长期记忆未完成（${reme.error || '未知原因'}）`
  const summary = `已入库：${docPath}（笔记 ${state.study?.effectiveChars ?? 0} 字 / ${state.study?.ratio ?? 0} 倍，`
    + `覆盖 ${cov ? `${cov.covered}/${cov.total}` : '—'}，${(quiz || []).length} 题）；`
    + `${memoryText}`
    + `${indexChanged ? '；资料索引已追加' : ''}${skillChanged ? '；技能清单已追加' : ''}`
    + (archivedPath ? '；旧版已归档到 archive/' : '')
    + (ledger.mdPath ? '；学习台账已更新' : '')
    + (reme.overlap?.count ? `；另有 ${reme.overlap.count} 条相关记录（未合并，见 commit.json 的 reme.overlap）` : '')

  return {
    ok: true,
    at: new Date().toISOString(),
    slug,
    docPath,
    archivedPath,
    quizPath,
    provenancePath,
    examPaperPath: input.examPaper ? examPaperPath : '',
    answerKeyPath: input.answerKey ? answerKeyPath : '',
    indexPath,
    indexChanged,
    skillPath,
    skillChanged,
    skillPruned,
    skillError,
    notesSha256: noteSha,
    sourceSha256: provenance?.source?.sha256 || state.sourceHash,
    reme,
    ledger,
    summary,
  }
}

/**
 * 把定稿笔记按知识点块切成若干段：每段是笔记正文的**逐字切片**，
 * 段与段首尾相接，拼起来必须与原文一字不差。不截断、不摘要、不改写。
 *
 * @param notesText 定稿笔记全文
 * @param maxChars 每段目标字数（只在知识点块边界处切）
 * @returns 逐字片段数组
 */
export function splitNotesForMemory(notesText, maxChars = 4000) {
  const text = String(notesText ?? '')
  if (!text) return []
  const heads = []
  for (const match of text.matchAll(/^###\s/gm)) heads.push(match.index)
  const bounds = [...new Set([0, ...heads.filter(index => index > 0), text.length])].sort((a, b) => a - b)
  const blocks = []
  for (let i = 0; i < bounds.length - 1; i++) blocks.push([bounds[i], bounds[i + 1]])
  const parts = []
  let start = blocks.length ? blocks[0][0] : 0
  let end = start
  for (const [a, b] of blocks) {
    if (end > start && b - start > maxChars) {
      parts.push(text.slice(start, end))
      start = a
    }
    end = b
  }
  if (end > start) parts.push(text.slice(start, end))
  return parts
}

/** ReMe 存储时按日期在前加 frontmatter，读回比对要把这一层剥掉（含它后面那一行空行）。 */
export function stripFrontmatter(text) {
  const body = String(text ?? '')
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body)
  const rest = match ? body.slice(match[0].length) : body
  return rest.replace(/^\r?\n/, '')
}

/** 读回比对的口径：只统一换行与行尾空白，其余一个字符都不许差。 */
export function normalizeStored(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\n+$/, '')
}

function segmentsOfNotes(notesText) {
  return [...new Set([...String(notesText).matchAll(/⟦(S\d+)⟧/g)].map(match => match[1]))]
}

/**
 * ReMe 要存的记录：定稿笔记逐字分段 + 题库 + 重建清单。
 * 每段正文就是笔记切片本身，说明信息全部放在 ReMe 的 name/description/metadata 里，
 * 这样把各段正文按顺序拼起来就能一字不差地还原整份笔记。
 *
 * @param input 定稿笔记、题库、溯源、标题与路径
 * @returns 记录数组与重建清单
 */
export function memoryRecords(input) {
  const { state, notesText, quizText, provenance, slug, docPath, classroomId } = input
  const noteSha = sha256(notesText)
  const note8 = noteSha.slice(0, 8)
  const partChars = Math.max(200, Number(input.maxChars) || 4000)
  const parts = splitNotesForMemory(notesText, partChars)
  const sourceSha = provenance?.source?.sha256 || state.sourceHash || ''
  const coverage = state.study?.coverage
  const base = `learn-${slug}-${note8}`
  const session = `learn-${String(classroomId || '').slice(-24)}`
  const tags = ['智能助理学院', '精读笔记']
  const records = parts.map((body, index) => {
    const partNo = String(index + 1).padStart(2, '0')
    const segs = segmentsOfNotes(body)
    return {
      kind: 'part',
      name: `${base}-p${partNo}`,
      body,
      description: `精读笔记 第 ${index + 1}/${parts.length} 段（笔记 sha ${note8}）；本段 ${body.length} 字符，对应原文片段 ${segs.slice(0, 12).join(' ') || '—'}`,
      metadata: {
        memory_tags: tags,
        classroom: classroomId || '',
        part: index + 1,
        total: parts.length,
        note_sha256: noteSha,
        source_sha256: sourceSha,
        source_file: state.sourceName || '',
        segments: segs.slice(0, 40),
      },
      session,
    }
  })
  records.push({
    kind: 'quiz',
    name: `${base}-quiz`,
    body: quizText,
    description: `精读题库（笔记 sha ${note8}）：${(input.quiz || []).length} 题，每条条款至少一题，判分关键词全部可回查原文片段`,
    metadata: { memory_tags: tags, classroom: classroomId || '', note_sha256: noteSha, questions: (input.quiz || []).length },
    session,
  })
  const manifest = [
    `# ${state.title} · 精读笔记重建清单`,
    '',
    `- 笔记全文 sha256：\`${noteSha}\``,
    `- 原文封条：\`${sourceSha}\`（${state.sourceChars || 0} 字 / ${state.ledgerStats?.segments ?? ''} 个片段）`,
    `- 覆盖：${coverage ? `${coverage.covered}/${coverage.total}` : '—'}；有效字数 ${state.study?.effectiveChars ?? 0}（${state.study?.ratio ?? 0} 倍）`,
    `- 完整文件：\`${docPath}\``,
    `- 分段数：${parts.length}；题库：${(input.quiz || []).length} 题`,
    '',
    '把下列各段正文按编号顺序原样拼接，即为定稿笔记全文（sha256 见上，逐段哈希可逐段核对）：',
    '',
    '| 段 | ReMe 名称 | 字符数 | 段 sha256 |',
    '| --- | --- | --- | --- |',
    ...records.filter(record => record.kind === 'part').map((record, index) => (
      `| p${String(index + 1).padStart(2, '0')} | \`${record.name}\` | ${record.body.length} | \`${sha256(record.body).slice(0, 16)}\` |`
    )),
    '',
    '每一段在写入后都会按 ReMe 的 /read 读回原文逐字比对哈希，读回不一致即判入库失败。',
  ].join('\n')
  records.push({
    kind: 'manifest',
    name: `${base}-manifest`,
    body: manifest,
    description: `精读笔记重建清单：${parts.length} 段 + 题库，笔记 sha ${note8}，可按段还原全文`,
    metadata: { memory_tags: tags, classroom: classroomId || '', note_sha256: noteSha, parts: parts.length },
    session,
  })
  // 主题索引：一处记录「这个主题的课堂知识在哪」，检索先命中它，
  // 再去读分段，避免同一主题在多个来源各答各的。
  const corrections = (state.pendingCorrections || []).filter(item => item.status === 'accepted')
  const topicBody = [
    `# 主题索引：${state.title}`,
    '',
    `- 课堂笔记全文：\`${docPath}\``,
    `- 记忆分段：${parts.length} 段（\`${base}-p01\` … \`${base}-p${String(parts.length).padStart(2, '0')}\`），重建清单 \`${base}-manifest\``,
    `- 题库：${(input.quiz || []).length} 题（\`${base}-quiz\`）；人员考核试卷与答案册随知识库文件一起交付`,
    `- 原文封条：\`${sourceSha}\`（${state.sourceChars || 0} 字 / ${state.ledgerStats?.segments ?? ''} 片段）；课堂 ${classroomId || ''}`,
    `- 引用优先级：本主题以课堂笔记为第一引用，其它会话知识仅作参考；两者冲突时走更正流程`,
    corrections.length ? `- 已确认勘误：${corrections.length} 条（见知识库文件「勘误记录」）` : '',
  ].filter(Boolean).join('\n')
  records.push({
    kind: 'topic',
    name: `topic-${slug}`,
    body: topicBody,
    description: `主题索引：${state.title}（课堂笔记 ${parts.length} 段 / 题库 ${(input.quiz || []).length} 题 / 练习卷）`,
    metadata: { memory_tags: ['智能助理学院', '主题索引'], classroom: classroomId || '', note_sha256: noteSha, parts: parts.length },
    session,
  })
  return {
    noteSha,
    records,
    manifest,
    parts: parts.length,
    reconstruction: { partsAreVerbatim: parts.join('') === notesText, noteSha },
  }
}

/* ------------------------------------------------------------------ */

async function runSelftest() {
  let passed = 0
  const failures = []
  const check = (label, ok, extra = '') => {
    if (ok) passed++
    else failures.push(label)
    if (process.env.COMMIT_VERBOSE || !ok) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  }
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createServer } = await import('node:http')
  const root = await mkdtemp(`${tmpdir()}/dsh-commit-`)
  const knowledgeRoot = `${root}/docs`
  const skillsRoot = `${root}/skills`

  /** 模拟 ReMe：daily_write / read / delete / reindex / search。 */
  const stubReme = (options = {}) => new Promise(resolve => {
    const store = new Map()
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}
        const send = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
        const path = `/daily/2026-11-16/${body.name || 'x'}.md`
        if (req.url === '/daily_write') {
          if (options.dropName && body.name === options.dropName) {
            // 收下了但没真的存：模拟「接口说成功、内容其实丢了」
            return send({ success: true, metadata: { path } })
          }
          store.set(path, `---\nname: ${body.name}\ndescription: ${body.description || ''}\n---\n${body.content}`)
          return send({ success: true, metadata: { path, name: body.name } })
        }
        if (req.url === '/read') {
          const text = store.get(body.path)
          return send(text == null ? { success: false, answer: '' } : { success: true, answer: text })
        }
        if (req.url === '/delete') { store.delete(body.path); return send({ success: true, metadata: { deleted: true } }) }
        if (req.url === '/reindex') return send({ success: true })
        if (req.url === '/search') return send({ success: true, answer: [...store.values()].join('\n').slice(0, 2000) })
        return send({ success: false })
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, store, url: `http://127.0.0.1:${server.address().port}` }))
  })

  const notesText = [
    '---', 'title: 抽样检验规范', '---', '', '# 抽样检验规范 · 精读笔记', '',
    '## 一、覆盖与校验', '', '- 片段覆盖：18/18，无遗漏', '',
    '## 三、知识点', '',
    '### P01 抽样比例 ⟦S0001⟧', '', '> 原文：抽样比例：每批抽 5%，不足 20 件时改为全检。⟦S0001⟧', '',
    '- 解释：按批抽，不按工单抽；比例按件数算。', '- 适用条件：进料与出货检验都按这一条。', '',
    '### P02 复检 ⟦S0002⟧', '', '> 原文：复检比例为 10%。⟦S0002⟧', '',
    '- 解释：被拒收的批次只能申请一次复检。', '- 例外：复检仍不合格时整批退回。', '',
    '### P03 记录 ⟦S0003⟧', '', '> 原文：检验记录保存三年，到期由质量部销毁。⟦S0003⟧', '',
    '- 解释：记录与批次绑定，保存期从检验日起算。', '',
  ].join('\n')
  const provenance = {
    source: { sha256: 'a'.repeat(64) },
    notes: { sha256: sha256(notesText) },
    bySegment: { S0001: { notes: ['P01'], questions: ['Q1'] } },
  }
  const state = {
    title: '抽样检验规范', sourceName: 'fixture.md', sourceHash: 'a'.repeat(64), sourceChars: 500,
    ledgerStats: { segments: 20 },
    study: {
      effectiveChars: 1200, ratio: 2.4,
      coverage: { covered: 18, total: 18 },
      chunks: { 1: { points: [{ title: '抽样比例', explain: '每批抽 5%', segments: ['S0001'] }] } },
    },
  }
  const quiz = [{ id: 'Q1', clause: 'K1', angle: '判定边界', q: '一批 18 件怎么抽？', answer_contains: '不足 20 件时改为全检', segments: ['S0001'] }]
  const cfg = { knowledgeRoot, skillsRoot, learnedDir: 'learned', remeEndpoint: '', memoryPartChars: 260 }
  const cfgWithReme = endpoint => ({ ...cfg, remeEndpoint: endpoint })

  const reme = await stubReme()
  let lossy = null
  try {
    // 分段口径：逐字切片，拼回去必须一字不差
    const parts = splitNotesForMemory(notesText, 260)
    check('分段是定稿笔记的逐字切片', parts.join('') === notesText, `parts=${parts.length}`)
    check('分段在知识点边界处切', parts.length >= 2 && parts.every(part => part.startsWith('---') ? part.includes('###') : true))

    // 入库文件
    const report = await commitLearning({
      cfg: cfgWithReme(reme.url),
      state, notesText, quiz, provenance, classroomId: 'class-x',
    })
    const doc = await readFile(report.docPath, 'utf8')
    check('写出学习产物', report.docPath.endsWith('.md') && doc.includes('# 抽样检验规范'))
    check('产物含题库与双向溯源', doc.includes('考核题库') && doc.includes('原文溯源索引') && doc.includes('| S0001 |'))
    check('题库与溯源单独落盘', report.quizPath.endsWith('.quiz.json') && report.provenancePath.endsWith('.provenance.json'))
    check('资料索引与技能清单各追加一行',
      (await readFile(`${knowledgeRoot}/INDEX.md`, 'utf8')).includes('learned/抽样检验规范.md')
      && (await readFile(`${skillsRoot}/learned-library/SKILL.md`, 'utf8')).includes('docs/learned/抽样检验规范.md'))

    // 长期记忆：全文分段写入 + 逐段读回比对
    check('写入的是定稿笔记全文，不是摘要', report.reme.parts >= 2 && report.reme.partsWritten === report.reme.parts,
      `parts=${report.reme.parts} written=${report.reme.partsWritten}`)
    check('逐段读回与写入逐字一致', report.reme.mismatched.length === 0 && report.reme.records.every(record => record.written && record.exact))
    check('长期记忆判为成功', report.reme.ok === true && report.reme.exact === true)
    const partRecords = report.reme.records.filter(record => record.kind === 'part')
    const storedBodies = partRecords.map(record => stripFrontmatter(reme.store.get(record.path) || '')).join('')
    check('把各段读回内容拼起来就是定稿笔记', storedBodies === notesText)
    check('重建清单里写了全文哈希', report.reme.records.some(record => record.kind === 'manifest'
      && (reme.store.get(record.path) || '').includes(sha256(notesText))))

    // 静默丢一段：必须判失败，不许谎报
    const dropName = partRecords[1]?.name || partRecords[0].name
    lossy = await stubReme({ dropName })
    const lossyReport = await commitLearning({
      cfg: cfgWithReme(lossy.url),
      state, notesText, quiz, provenance, classroomId: 'class-x',
    }).catch(error => ({ error }))
    check('写入接口说成功但内容丢了也要判失败', lossyReport.reme ? lossyReport.reme.ok === false : true)
    if (lossyReport.reme) {
      check('失败时点名哪一段不一致', lossyReport.reme.mismatched.includes(dropName), lossyReport.reme.mismatched.join(','))
      check('失败原因写清缺段/不一致', /不完整|不一致/.test(lossyReport.reme.error))
    }

    // 内容变了重交：旧分段要删掉，不能把旧口径留在记忆里
    state.commit = report
    const changed = `${notesText}\n补充一行：复检必须书面申请。\n`
    const changedProvenance = { ...provenance, notes: { sha256: sha256(changed) } }
    const second = await commitLearning({
      cfg: cfgWithReme(reme.url),
      state, notesText: changed, quiz, provenance: changedProvenance, classroomId: 'class-x',
    })
    check('重交写入新分段并读回一致', second.reme.ok === true && second.reme.mismatched.length === 0)
    check('学习台账生成并可机读',
      Boolean(report.ledger?.mdPath) && Boolean(report.ledger?.jsonPath)
      && (await readFile(report.ledger.mdPath, 'utf8')).includes(state.title)
      && JSON.parse(await readFile(report.ledger.jsonPath, 'utf8')).records.some(item => item.classroomId === 'class-x'),
      report.ledger?.mdPath || '（没有台账路径）')
    // 新版进来：同一份资料的旧版要被标成「已被新版取代」
    await upsertLearningRecords({
      cfg: cfgWithReme(reme.url),
      state: { ...state, sourceVersion: 2, review: { decidedAt: '2026-11-18T00:00:00.000Z' } },
      quiz,
      input: { classroomId: 'class-y' },
      reme: { parts: 1 },
      slug: report.slug,
      learnedDir: 'learned',
      docPath: report.docPath,
      quizPath: report.quizPath,
      examPaperPath: '',
      answerKeyPath: '',
      provenancePath: report.provenancePath,
      noteSha: report.notesSha256,
    })
    const ledgerRows = JSON.parse(await readFile(report.ledger.jsonPath, 'utf8')).records
    check('新版进来后旧版标成被取代',
      ledgerRows.find(item => item.classroomId === 'class-x')?.status === 'superseded'
      && ledgerRows.find(item => item.classroomId === 'class-y')?.status === 'active',
      JSON.stringify(ledgerRows.map(item => `${item.classroomId}:${item.version}:${item.status}`)))
    check('重交覆盖前把旧版归档',
      Boolean(second.archivedPath) && second.archivedPath.includes('archive')
      && (await readFile(second.archivedPath, 'utf8')).length > 0,
      second.archivedPath || '（没有归档路径）')
    // 主题索引的名字按主题固定（一份主题一条），重交时要保留；其余旧段必须删掉
    const oldNames = report.reme.records.filter(record => !String(record.path || '').includes('/topic-')).map(record => record.path)
    check('重交删掉上一版分段', oldNames.every(path => !reme.store.has(path)))

    // 复核后笔记被改：拒绝入库
    let rejected = false
    try {
      await commitLearning({ cfg, state, notesText: `${notesText}\n偷改一行\n`, quiz, provenance, classroomId: 'class-x' })
    } catch (error) { rejected = /哈希不一致/.test(String(error?.message || error)) }
    check('定稿笔记与复核哈希不一致时拒绝入库', rejected)

    // 未配置 ReMe 时如实标记
    const offline = await commitLearning({ cfg, state, notesText, quiz, provenance, classroomId: 'class-x' })
    check('未配置 ReMe 时如实标记', offline.reme.ok === false && offline.reme.error.includes('未配置'))
    check('结论文案带分段数与读回结论', offline.summary.includes('覆盖 18/18') && offline.summary.includes('1 题'))

    let escaped = false
    try { await commitLearning({ cfg: { ...cfg, knowledgeRoot: root, learnedDir: '../../escape' }, state, notesText, quiz, provenance }) } catch { escaped = true }
    check('拒绝写知识目录之外', escaped)
  } finally {
    reme.server.close()
    if (lossy) lossy.server.close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
  console.log(`\n交付入库自检：${passed} 项通过，${failures.length} 项失败`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  if (failures.length) process.exitCode = 1
  return { passed, failed: failures.length }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
  runSelftest().catch(error => { console.error(error); process.exitCode = 1 })
}
