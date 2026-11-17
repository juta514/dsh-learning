/**
 * 智能助理学院 — the Web half of dsh-learning-academy.
 *
 * Everything here lives inside the plugin bundle. Nothing is written into the
 * dsh frontend source and no rebuild is needed: the page is an exact webServer
 * route and every JSON endpoint rides the authenticated `/api` channel as an
 * exact Fetch route (owner Peer only). The entry itself lives in the left
 * sidebar, contributed by the `@learning/dsh-academy-panel` client plugin
 * (`sidebar.panellist#academy` plus a keyed `main` seat around this page), so
 * this package no longer injects a floating button into the index document.
 * Uninstall the bundle and the page plus every route disappear together; drop
 * the panel plugin and the navigation row disappears.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, basename, extname, resolve, sep, dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  openClassroom, appendMessage, getClassroom, listClassrooms,
} from './classroom.js'
import {
  openTeaching, advance, sayToClass, decideClass, teachingState, openClass, jsonOf,
} from './teaching.js'
import * as engine from './engine.js'
import {
  listMaterials, readMaterial, ingestMaterial, materialSource, addAttempt,
  prepareAttempt, syncFromClassroom, setCardSummary,
} from './library.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_FILE = join(HERE, 'academy.html')

const PLAIN_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.log', '.xml', '.html', '.htm',
])
const DOC_EXT = new Set(['.pdf', '.docx', '.pptx'])
const execFileAsync = promisify(execFile)
const SOFFICE = process.env.DSH_SOFFICE_PATH || 'C:/Program Files/LibreOffice/program/soffice.exe'
const PREVIEW_EXT = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'])

/**
 * Office 文件转 PDF 只为「在浏览器里直接打开」：结果按路径+大小+修改时间缓存，
 * 同一份文件只转一次，不重复下载。上传的原件一个字节都不动，仍可原样下载。
 */
async function previewPdfOf(absPath, stateRoot) {
  const info = await stat(absPath)
  const key = createHash('sha1').update(`${absPath}:${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 16)
  const cacheDir = join(stateRoot, 'cache', 'preview')
  const target = join(cacheDir, `${key}.pdf`)
  try { return await readFile(target) } catch { /* 还没转 */ }
  await mkdir(cacheDir, { recursive: true })
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-preview-'))
  try {
    await execFileAsync(SOFFICE, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, absPath], { timeout: 60000 })
    const pdfName = basename(absPath).replace(/\.[^.]+$/, '.pdf')
    const buf = await readFile(join(outDir, pdfName))
    await writeFile(target, buf)
    return buf
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 读原件。raw=true 给逐字节原文件（下载用）；否则能内嵌的给内嵌，
 * Office 转一份 PDF 预览（只缓存一次），并在载荷里附上原件的 sha256 供核对。
 */
async function originalPayload(absPath, displayName, stateRoot, raw = false) {
  const ext = extname(String(displayName || absPath)).toLowerCase()
  const original = await readFile(absPath)
  const seal = createHash('sha256').update(original).digest('hex')
  if (!raw && PREVIEW_EXT.has(ext)) {
    try {
      const pdf = await previewPdfOf(absPath, stateRoot)
      return {
        name: displayName, mime: 'application/pdf', bytes: pdf.length, base64: pdf.toString('base64'),
        preview: true, originalName: displayName, originalBytes: original.length, sha256: seal,
      }
    } catch (error) {
      return {
        name: displayName, mime: mimeOf(displayName), bytes: original.length, base64: original.toString('base64'),
        preview: false, sha256: seal, note: `预览生成失败：${String(error?.message || error).slice(0, 120)}`,
      }
    }
  }
  return { name: displayName, mime: mimeOf(displayName), bytes: original.length, base64: original.toString('base64'), preview: false, sha256: seal }
}

/** 按扩展名给原始文件一个 MIME，浏览器才知道该预览还是下载。 */
function mimeOf(name) {
  const ext = (String(name || '').toLowerCase().match(/\.[^.]+$/) || [''])[0]
  return {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.html': 'text/html',
    '.htm': 'text/html',
  }[ext] || 'application/octet-stream'
}
const ALLOWED_EXT = new Set([...PLAIN_EXT, ...DOC_EXT])
const MAX_BYTES = 20 * 1024 * 1024

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function fail(message, status = 400) {
  return json({ error: message }, status)
}

function safeName(raw) {
  const base = basename(String(raw || '').replace(/\\/g, '/'))
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base || 'course.txt'
}

function within(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) return t
  throw new Error('路径超出知识库范围')
}

/** Tiny frontmatter reader: values are JSON scalars or plain text. */
function frontmatter(text) {
  const out = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { /* keep raw */ }
    } else if (/^(true|false)$/i.test(value)) {
      value = /^true$/i.test(value)
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value)
    }
    out[kv[1]] = value
  }
  return out
}

/** Courses come from session states, plus any learned .md that predates them. */
async function listCourses(cfg) {
  const sessionsDir = join(cfg.stateRoot, 'sessions')
  const courses = []
  const seenDocs = new Set()

  let entries = []
  try { entries = await readdir(sessionsDir, { withFileTypes: true }) } catch { /* no sessions yet */ }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('learn-')) continue
    let state
    try {
      state = JSON.parse(await readFile(join(sessionsDir, entry.name, 'state.json'), 'utf8'))
    } catch { continue }
    const r = state.result || {}
    const docRel = String(r.docRel || '').replace(/\\/g, '/')
    if (docRel) seenDocs.add(docRel)
    courses.push({
      id: state.id || entry.name,
      status: state.status || 'running',
      stage: state.stage || '',
      startedAt: state.startedAt || null,
      finishedAt: state.finishedAt || null,
      title: r.title || state.source?.name || entry.name,
      source: state.source?.name || '',
      sourceBytes: state.source?.bytes || 0,
      score: r.score ?? null,
      knowledgePoints: r.knowledgePoints ?? null,
      questions: r.questions ?? null,
      corrections: r.corrections ?? null,
      reviewRequired: Boolean(r.reviewRequired),
      memorySearchHit: Boolean(r.memorySearchHit),
      docRel,
      stages: Object.keys(state.stages || {}),
      error: state.error ? String(state.error).slice(0, 300) : '',
    })
  }

  const learnedDir = join(cfg.knowledgeRoot, cfg.learnedDir)
  let files = []
  try { files = await readdir(learnedDir) } catch { /* not created yet */ }
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const rel = `${cfg.learnedDir}/${file}`
    if (seenDocs.has(rel)) continue
    let text
    try { text = await readFile(join(learnedDir, file), 'utf8') } catch { continue }
    const fm = frontmatter(text)
    const score = typeof fm.quiz_score === 'number' ? fm.quiz_score : Number(fm.quiz_score) || null
    courses.push({
      id: fm.learning_session || `external-${createHash('sha256').update(file).digest('hex').slice(0, 10)}`,
      status: fm.review_required ? 'completed_needs_review' : 'completed',
      stage: 'done',
      startedAt: fm.learned_at || null,
      finishedAt: fm.learned_at || null,
      title: fm.title || file.replace(/\.md$/i, ''),
      source: fm.source_file || file,
      sourceBytes: 0,
      score,
      knowledgePoints: Number(fm.knowledge_points) || null,
      questions: Number(fm.quiz_questions) || null,
      corrections: null,
      reviewRequired: Boolean(fm.review_required),
      memorySearchHit: null,
      docRel: rel,
      stages: [],
      error: '',
    })
  }

  courses.sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')))
  return courses
}

async function readCourse(cfg, rel) {
  const clean = String(rel || '').replace(/\\/g, '/')
  if (!clean.toLowerCase().endsWith('.md') || clean.includes('..')) {
    throw new Error('不是合法的课程讲义')
  }
  const full = within(cfg.knowledgeRoot, join(cfg.knowledgeRoot, clean))
  const markdown = await readFile(full, 'utf8')
  const fm = frontmatter(markdown)
  return { rel: clean, title: fm.title || basename(clean, '.md'), markdown }
}

async function readState(cfg, id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!safe) throw new Error('缺少会话 ID')
  const dir = within(cfg.stateRoot, join(cfg.stateRoot, 'sessions', safe))
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
}

async function handleUpload(request, ctx, cfg, runPipeline) {
  if (request.method !== 'POST') return fail('只支持 POST', 405)
  let body
  try { body = await request.json() } catch { return fail('请求体不是合法 JSON') }

  const name = safeName(body?.name)
  const ext = extname(name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    return fail(`暂不支持 ${ext || '无扩展名'} 文件；旧版 .doc/.ppt/.chm 请先转成 .docx/.pptx/.pdf`, 415)
  }
  const encoded = String(body?.contentBase64 || '')
  if (!encoded || encoded.length > MAX_BYTES * 1.5) return fail('文件为空或超过 20 MB', 413)
  const buffer = Buffer.from(encoded, 'base64')
  if (!buffer.length || buffer.length > MAX_BYTES) return fail('文件为空或超过 20 MB', 413)

  const uploadsDir = join(cfg.stateRoot, 'uploads')
  await mkdir(uploadsDir, { recursive: true })
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const filePath = join(uploadsDir, `${sha256.slice(0, 12)}-${name}`)
  await writeFile(filePath, buffer)

  const id = `learn-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`
  const options = {
    id,
    filePath,
    title: String(body?.title || '').slice(0, 120),
    tags: String(body?.tags || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8),
  }

  // Fire and forget: the UI request must not hold the HTTP exchange open for
  // the several minutes the six-stage pipeline needs.
  void runPipeline(ctx, cfg, options).catch(error => {
    try {
      ctx.root?.logger?.('learning-academy')?.warn?.(`academy pipeline ${id} failed: ${String(error?.message || error)}`)
    } catch { /* logger is optional */ }
  })

  return json({ id, name, bytes: buffer.length, sha256: sha256.slice(0, 16) })
}

const MATERIAL_FIELDS = [
  'id', 'title', 'tags', 'status', 'version', 'createdAt', 'updatedAt', 'source',
  'intro', 'summary', 'summaryStatus', 'keywords',
]

function materialSummary(meta) {
  const out = {}
  for (const key of MATERIAL_FIELDS) out[key] = meta[key]
  const latest = (meta.versions || []).at(-1) || {}
  out.parts = latest.parts || 0
  out.chars = latest.chars || 0
  out.versions = (meta.versions || []).length
  out.attempts = (meta.attempts || []).length
  out.files = (latest.files || []).map(f => ({ part: f.part, name: f.name, chars: f.chars }))
  // 抽取告警要跟着卡片走：扫描页、图片、脚注这类「没读到」的内容不该被当成原文没有
  out.warnings = (latest.warnings || []).slice(0, 10)
  out.statusLabel = { uploaded: '未学习', studying: '学习中', completed: '已完成' }[meta.status] || '未学习'
  return out
}

/** 适用范围比正文第一句更像「课程简介」，摘到了就先用它。 */
function scopeText(scope) {
  if (!scope) return ''
  const bits = []
  if (Array.isArray(scope.appliesTo) && scope.appliesTo.length) {
    bits.push(`适用：${scope.appliesTo.slice(0, 3).join('、')}`)
  }
  if (scope.version) bits.push(`版本 ${scope.version}`)
  if (scope.effectiveDate) bits.push(`生效 ${scope.effectiveDate}`)
  return bits.join(' · ')
}

/** 新引擎（v2）默认开启；保留 v1 开关，用于旧课堂与回滚。 */
function engineOf(cfg) {
  return cfg && cfg.engine === 'v1' ? null : engine
}

/** 读课堂进度：v2 课堂用学习引擎，旧课堂仍走旧授课引擎。 */
async function stateOf(cfg, id) {
  if (engineOf(cfg) && await engine.isV2(cfg.stateRoot, id)) return engine.teachingState(cfg.stateRoot, id, cfg)
  return teachingState(cfg.stateRoot, id)
}

// 教材列表要为每本书算学完后的笔记字数、题库与考核分，这些都在课堂的
// teaching.json 里。按 mtime+size 缓存，翻页与刷新就不会反复解析大 JSON。
const teachingCache = new Map()

async function teachingFacts(cfg, classId) {
  const file = join(cfg.stateRoot, 'classrooms', classId, 'teaching.json')
  let info
  try { info = await stat(file) } catch { return null }
  const hit = teachingCache.get(classId)
  if (hit && hit.mtime === info.mtimeMs && hit.size === info.size) return hit.value
  const state = await stateOf(cfg, classId)
  const value = {
    stage: state.stage || '',
    stageLabel: state.stageLabel || '',
    stageDetail: state.stage === 'exam' && state.exam?.round > 1
      ? `第 ${state.exam.round} 轮判卷`
      : (state.prep?.map ? `${state.prep.map} 条条款` : ''),
    notesChars: Number(state.brief?.notesChars) || 0,
    bank: Number(state.prep?.questions) || 0,
    exam: {
      asked: Number(state.exam?.asked) || 0,
      answered: Number(state.exam?.answered) || 0,
      total: Number(state.exam?.total) || 0,
      avg: state.exam?.avg ?? null,
      passLine: Number(state.brief?.exam?.passLine) || 75,
    },
    coverage: state.brief?.coverage
      ? `${state.brief.coverage.covered}/${state.brief.coverage.total}` : '',
    scope: state.scope || null,
  }
  teachingCache.set(classId, { mtime: info.mtimeMs, size: info.size, value })
  return value
}

/** 一次请求最多带 20 个附件，逐个校验扩展名与大小。 */
function decodeFiles(rawFiles) {
  const list = Array.isArray(rawFiles) ? rawFiles.slice(0, 20) : []
  const files = []
  for (const item of list) {
    const name = safeName(item?.name)
    const ext = extname(name).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      throw Object.assign(new Error(`${name}：暂不支持 ${ext || '无扩展名'} 文件；旧版 .doc/.ppt/.chm 请先转成 .docx/.pptx/.pdf`), { status: 415 })
    }
    const encoded = String(item?.contentBase64 || '')
    if (!encoded || encoded.length > MAX_BYTES * 1.5) {
      throw Object.assign(new Error(`${name}：文件为空或超过 20 MB`), { status: 413 })
    }
    const buffer = Buffer.from(encoded, 'base64')
    if (!buffer.length || buffer.length > MAX_BYTES) {
      throw Object.assign(new Error(`${name}：文件为空或超过 20 MB`), { status: 413 })
    }
    files.push({ name, buffer })
  }
  return files
}

/**
 * 卡片摘要：上传一入库就开始写，不挡上传返回。
 * 只读原文开头与章节标题，让模型说清「这份文件是什么、管哪几块」。
 * 写不出来就标 failed，卡片回退到原来那段截取出来的 intro，不留空白。
 */
async function writeCardSummary(cfg, deps, id) {
  const chat = deps && deps.chat
  if (!chat) return
  try {
    const { meta, text } = await materialSource(cfg.stateRoot, id)
    const heads = text.split(/\r?\n/)
      .filter(line => /^#{1,3}\s/.test(line))
      .slice(0, 16)
      .map(line => line.replace(/^#+\s*/, '').trim())
    const res = await chat({
      system: '你是资料管理员，替一份课件写卡片摘要。只依据原文，不评价好坏、不补常识。\n'
        + '只输出 JSON：{"summary":"两三句话：先说这份文件是什么、谁在什么场景用，再说它主要规定了哪几块；90 至 150 字",'
        + '"keywords":["3 到 5 个关键词"]}',
      prompt: `文件名：${meta.title}\n章节标题：${heads.join('、') || '（无小标题）'}\n\n原文开头：\n${text.slice(0, 7000)}`,
      maxTokens: 6000,
    })
    const data = jsonOf(res.text) || {}
    const summary = String(data.summary || '').replace(/\s+/g, ' ').trim()
    if (!summary) throw new Error('模型没给出摘要')
    await setCardSummary(cfg.stateRoot, id, {
      summary,
      keywords: Array.isArray(data.keywords) ? data.keywords : [],
      status: 'done',
    })
  } catch (error) {
    await setCardSummary(cfg.stateRoot, id, {
      status: 'failed',
      error: String(error?.message || error),
    }).catch(() => {})
  }
}

/**
 * 入库。这是整条链路上唯一不花模型额度的一步：抽字、合并、记版本，
 * 状态停在上传。学不学、什么时候学，由「开始学习」决定。
 */
async function handleMaterialUpload(request, cfg, deps = {}) {
  if (request.method !== 'POST') return fail('只支持 POST', 405)
  let body
  try { body = await request.json() } catch { return fail('请求体不是合法 JSON') }
  try {
    const raw = Array.isArray(body?.files) ? body.files : (body?.name ? [body] : [])
    const files = decodeFiles(raw)
    if (!files.length) return fail('没有收到文件', 400)
    const meta = await ingestMaterial(cfg.stateRoot, cfg, {
      files,
      title: String(body?.title || '').slice(0, 160),
      tags: String(body?.tags || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8),
      materialId: body?.id || '',
    })
    // 摘要不挡上传：先把书交出去，模型在后台通读，写完卡片自己补上
    if (meta.summaryStatus === 'pending') void writeCardSummary(cfg, deps, meta.id)
    return json({ material: materialSummary(meta) })
  } catch (error) {
    return fail(String(error?.message || error), Number(error?.status) || 500)
  }
}

/** 只认当前这一版的最后一次学习：换版之后旧课堂不该被当成「这版学到哪」。 */
function currentAttempt(meta) {
  const version = Number(meta.version) || 1
  return (meta.attempts || []).filter(a => Number(a.version) === version).at(-1) || null
}

/** 建一间课堂并把这一版原文导进去。不调模型。 */
async function buildClassroom(cfg, meta, attemptNo) {
  const { text, record } = await materialSource(cfg.stateRoot, meta.id)
  const room = await openClassroom(cfg.stateRoot, {
    title: `${meta.title} · v${meta.version}`,
    materialId: meta.id,
    materialVersion: meta.version,
    attempt: attemptNo,
    materialTitle: meta.title,
  })
  const warnings = (record?.warnings || []).slice(0, 20)
  if (warnings.length) {
    // 抽不出来的内容必须先说清楚，否则「全文读完」是假的
    await appendMessage(cfg.stateRoot, room.classroom.id, {
      id: `extract-warn-${meta.id}-v${meta.version}`,
      role: 'system',
      kind: 'system',
      content: `抽取告警（这些内容这次读不到，别当成原文没有）：\n- ${warnings.join('\n- ')}`,
      meta: { step: 'extract-warnings', count: warnings.length },
    }).catch(() => {})
  }
  const sourceName = `library/${meta.id}/v${meta.version}/source.md`
  const opened = engineOf(cfg)
    ? await engine.openTeaching(cfg.stateRoot, { id: room.classroom.id, title: meta.title, source: text, sourceName, cfg })
    : await openTeaching(cfg.stateRoot, { id: room.classroom.id, title: meta.title, source: text, sourceName })
  return { room, opened, warnings }
}

/** 开一间新课堂并立刻记成第 N 次学习（用户明确要再学一遍时走这里）。 */
async function openAttempt(cfg, meta) {
  const attemptNo = (meta.attempts || []).length + 1
  const { room, opened } = await buildClassroom(cfg, meta, attemptNo)
  await addAttempt(cfg.stateRoot, meta.id, {
    n: attemptNo, classroomId: room.classroom.id, version: meta.version,
  })
  return { room, opened, attemptNo }
}

/**
 * 进课堂：有课堂就进原来那间，没有才建一间。
 * 新开的这间只是「待转正」——用户在教室里点开始上课，才记成一次学习。
 */
async function handleMaterialEnter(request, cfg) {
  if (request.method !== 'POST') return fail('只支持 POST', 405)
  let body
  try { body = await request.json() } catch { return fail('请求体不是合法 JSON') }
  try {
    const meta = await readMaterial(cfg.stateRoot, String(body?.id || ''))
    const last = currentAttempt(meta)
    if (last?.classroomId) {
      try {
        const room = await getClassroom(cfg.stateRoot, last.classroomId)
        let teaching = null
        try { teaching = await stateOf(cfg, last.classroomId) } catch { teaching = null }
        return json({
          material: materialSummary(meta),
          classroomId: last.classroomId,
          classroom: room.classroom,
          teaching,
          attempts: meta.attempts || [],
          existing: true,
        })
      } catch { /* 课堂目录不在了，按没开过课处理 */ }
    }
    // 上次进来过但还没开始上课：还进原来那间，不重复建
    const pending = meta.pending
    if (pending?.classroomId && Number(pending.version) === Number(meta.version)) {
      try {
        const room = await getClassroom(cfg.stateRoot, pending.classroomId)
        let teaching = null
        try { teaching = await stateOf(cfg, pending.classroomId) } catch { teaching = null }
        return json({
          material: materialSummary(meta),
          classroomId: pending.classroomId,
          classroom: room.classroom,
          teaching,
          attempts: meta.attempts || [],
          existing: true,
          pending: true,
        })
      } catch { /* 课堂目录没了，重建 */ }
    }
    const attemptNo = (meta.attempts || []).length + 1
    const { room, opened } = await buildClassroom(cfg, meta, attemptNo)
    await prepareAttempt(cfg.stateRoot, meta.id, {
      n: attemptNo, classroomId: room.classroom.id, version: meta.version,
    })
    const after = await readMaterial(cfg.stateRoot, meta.id)
    return json({
      material: materialSummary(after),
      classroomId: room.classroom.id,
      classroom: room.classroom,
      teaching: opened.teaching,
      chapters: opened.chapters,
      attempts: after.attempts || [],
      existing: false,
      pending: true,
    })
  } catch (error) {
    return fail(String(error?.message || error), Number(error?.status) || 500)
  }
}

/** 课堂真的开始走了：把「待转正」的那次落成学习记录，教材状态转学习中。 */
async function bindPendingAttempt(cfg, classroom) {
  if (!classroom?.materialId || !classroom?.attempt) return null
  try {
    const meta = await readMaterial(cfg.stateRoot, classroom.materialId)
    const has = (meta.attempts || []).some(a => Number(a.n) === Number(classroom.attempt))
    if (has) return null
    return await addAttempt(cfg.stateRoot, classroom.materialId, {
      n: Number(classroom.attempt),
      classroomId: classroom.id,
      version: Number(classroom.materialVersion) || meta.version,
    })
  } catch {
    return null
  }
}

/** 再学一遍：不管之前学到哪，另起第 N 次，旧课堂与旧记录原样留着。 */
async function handleMaterialLearn(request, cfg) {
  if (request.method !== 'POST') return fail('只支持 POST', 405)
  let body
  try { body = await request.json() } catch { return fail('请求体不是合法 JSON') }
  try {
    const id = String(body?.id || '')
    const mode = String(body?.mode || 'auto')
    const meta = await readMaterial(cfg.stateRoot, id)
    if (mode !== 'new' && meta.status === 'studying') {
      const last = currentAttempt(meta)
      if (last?.classroomId) {
        try {
          const room = await getClassroom(cfg.stateRoot, last.classroomId)
          let teaching = null
          try { teaching = await stateOf(cfg, last.classroomId) } catch { teaching = null }
          if (teaching && teaching.stage !== 'finished') {
            return json({
              material: materialSummary(meta),
              classroomId: last.classroomId,
              classroom: room.classroom,
              teaching,
              attempts: meta.attempts || [],
              resumed: true,
            })
          }
        } catch { /* 课堂目录没了就新开一间 */ }
      }
    }
    // 有一间待转正的空课堂就把它转正，避免出现两间同号的课堂
    const pending = meta.pending
    if (pending?.classroomId && Number(pending.version) === Number(meta.version)) {
      try {
        const room = await getClassroom(cfg.stateRoot, pending.classroomId)
        let teaching = null
        try { teaching = await stateOf(cfg, pending.classroomId) } catch { teaching = null }
        if (!teaching || teaching.stage === 'ready') {
          await addAttempt(cfg.stateRoot, meta.id, {
            n: Number(pending.n), classroomId: pending.classroomId, version: meta.version,
          })
          const after = await readMaterial(cfg.stateRoot, id)
          return json({
            material: materialSummary(after),
            classroomId: pending.classroomId,
            classroom: room.classroom,
            teaching,
            attempts: after.attempts || [],
            resumed: false,
          })
        }
      } catch { /* 指针坏了就新建 */ }
    }
    const { room, opened } = await openAttempt(cfg, meta)
    const after = await readMaterial(cfg.stateRoot, id)
    return json({
      material: materialSummary(after),
      classroomId: room.classroom.id,
      classroom: room.classroom,
      teaching: opened.teaching,
      chapters: opened.chapters,
      attempts: after.attempts || [],
      resumed: false,
    })
  } catch (error) {
    return fail(String(error?.message || error), Number(error?.status) || 500)
  }
}

function classroomError(error) {
  const code = Number(error?.status)
  const status = code >= 400 && code < 500 ? code : 500
  return fail(String(error?.message || error), status)
}

/** Model channel for the teaching engine: one adapter over ctx.llm.stream. */
function makeChat(ctx, cfg) {
  return async ({ system, prompt, maxTokens, signal }) => {
    const request = {
      provider: cfg.provider,
      model: cfg.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: cfg.temperature,
      maxTokens: maxTokens ?? cfg.maxTokens,
    }
    if (signal) request.signal = signal
    let text = ''
    let reasoning = ''
    let reason = ''
    for await (const chunk of ctx.llm.stream(request)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      // FinishReason 是个对象（{ kind: 'max-tokens' }），不是字符串
      else if (chunk.type === 'finish') reason = String(chunk.reason?.kind ?? chunk.reason?.code ?? chunk.reason ?? '')
    }
    // Reasoning models can eat the whole budget before emitting the answer.
    // 正文为空时如实报 reasoning-only，让调用方加预算重试；不把思考当答案。
    let finish = reason
    if (!text.trim() && reasoning.trim()) finish = reason || 'reasoning-only'
    return { text, finish }
  }
}

/** The classroom is a chat box: every utterance is appended and notebook rebuilt. */
async function handleClassroomPost(request, cfg, deps = {}) {
  let body
  try { body = await request.json() } catch { return fail('请求体不是合法 JSON') }
  const action = String(body?.action || '')
  const id = body?.id
  try {
    if (action === 'open') {
      return json(await openClassroom(cfg.stateRoot, {
        id,
        courseId: body?.courseId,
        title: body?.title,
      }))
    }
    if (action === 'append') {
      return json(await appendMessage(cfg.stateRoot, id, body?.message || {}))
    }
    if (action === 'teach') {
      // The classroom can take the original text directly, or reuse the text a
      // finished upload already extracted (sessions/<id>/source.txt).
      let source = body?.source == null ? '' : String(body.source)
      let sourceName = String(body?.sourceName || '')
      const sessionId = String(body?.sessionId || '')
      if (!source.trim() && sessionId) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return fail('会话 ID 不合法')
        const file = within(join(cfg.stateRoot, 'sessions'), join(cfg.stateRoot, 'sessions', sessionId, 'source.txt'))
        try { source = await readFile(file, 'utf8') } catch { return fail('这次上传没有留下原文，请重新上传或直接选文件导入', 404) }
        sourceName = `${sessionId}/source.txt`
      }
      const options = { id, title: body?.title, source, sourceName }
      return json(engineOf(cfg)
        ? await engine.openTeaching(cfg.stateRoot, { ...options, cfg })
        : await openTeaching(cfg.stateRoot, options))
    }
    if (action === 'advance') {
      const v2 = engineOf(cfg) && await engine.isV2(cfg.stateRoot, id)
      const out = v2
        ? await engine.advance(cfg.stateRoot, { id, chat: deps.chat, cfg })
        : await advance(cfg.stateRoot, { id, chat: deps.chat, cfg })
      const room = await getClassroom(cfg.stateRoot, id)
      const stage = out?.state?.stage || out?.teaching?.stage
      // 课堂真的走起来了，才把这次学习落账（进来看一眼不算学过）
      if (stage && stage !== 'ready') await bindPendingAttempt(cfg, room.classroom)
      const material = stage === 'finished'
        ? await syncFromClassroom(cfg.stateRoot, room.classroom, stage)
        : null
      return json({ ...out, classroom: room.classroom, messages: room.messages, notes: room.notes, material })
    }
    if (action === 'say') {
      const out = engineOf(cfg) && await engine.isV2(cfg.stateRoot, id)
        ? await engine.sayToClass(cfg.stateRoot, { id, chat: deps.chat, text: body?.text, kind: body?.kind, cfg })
        : await sayToClass(cfg.stateRoot, { id, chat: deps.chat, text: body?.text, kind: body?.kind })
      return json(out)
    }
    // 复核（v2）：通过就出题入库，退回就按意见重拆。旧课堂仍用结课确认。
    if (action === 'review' || action === 'decide') {
      const v2 = engineOf(cfg) && await engine.isV2(cfg.stateRoot, id)
      const approve = action === 'review' ? Boolean(body?.approve) : Boolean(body?.agree)
      const out = v2
        ? await engine.reviewDecision(cfg.stateRoot, { id, approve, comment: body?.comment, cfg })
        : await decideClass(cfg.stateRoot, { id, chat: deps.chat, agree: approve, comment: body?.comment, cfg })
      const room = await getClassroom(cfg.stateRoot, id)
      const stage = out?.teaching?.stage
      const material = stage === 'finished'
        ? await syncFromClassroom(cfg.stateRoot, room.classroom, stage)
        : null
      return json({ ...out, messages: room.messages, notes: room.notes, material })
    }
    if (action === 'recommit') {
      if (!(engineOf(cfg) && await engine.isV2(cfg.stateRoot, id))) {
        return fail('这间课堂不是全文精读流程，没有可重新交付的产物', 409)
      }
      const out = await engine.recommit(cfg.stateRoot, { id, cfg })
      return json(out)
    }
    // 旧引擎课堂升级到全文精读流程：保留全部对话，重新切账本排计划
    if (action === 'upgrade') {
      if (!engineOf(cfg)) return fail('当前配置跑的是旧引擎（engine: v1），先切到 v2 再升级课堂', 409)
      if (await engine.isV2(cfg.stateRoot, id)) return fail('这间课堂已经是全文精读流程', 409)
      const out = await engine.adopt(cfg.stateRoot, { id, cfg })
      return json(out)
    }
    if (action === 'gate') {
      if (engineOf(cfg) && await engine.isV2(cfg.stateRoot, id)) {
        return fail('这间课堂走的是全文精读流程：校验与复核在课堂里完成，没有开课前审核门', 409)
      }
      // 审核卡在硬问题上时的开课许可：approve 就直接开课，不 approve 就按意见改包重审
      const out = await openClass(cfg.stateRoot, {
        id, chat: deps.chat, approve: body?.approve, comment: body?.comment,
      })
      const room = await getClassroom(cfg.stateRoot, id)
      const stage = out?.teaching?.stage
      if (stage && stage !== 'ready') await bindPendingAttempt(cfg, room.classroom)
      return json({ ...out, messages: room.messages, notes: room.notes })
    }
    // 重建检索索引（按钮/工具共用）：scope 默认向量，all 需显式指定
    if (action === 'reindex') {
      const scope = String(body?.scope || 'embedding')
      try {
        const out = await engine.reindexMemory(cfg, scope)
        return json(out)
      } catch (error) {
        return fail(String(error?.message || error), 400)
      }
    }
    // 查看上传的原件（不是抽取文本）：优先课堂目录 original/，没有就从教材库找回
    if (action === 'original') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''))) return fail('课堂 ID 不合法')
      const teaching = await stateOf(cfg, String(id))
      const file = teaching?.sourceFile
      let absPath = ''
      let name = ''
      if (file?.path) {
        absPath = within(join(cfg.stateRoot, 'classrooms'), file.path)
        name = file.name
      } else {
        // 升级前导入的课堂没有 original/：去教材库找用过这间课堂的那一版上传
        const libRoot = join(cfg.stateRoot, 'library')
        for (const dir of await readdir(libRoot).catch(() => [])) {
          const meta = await readJson(join(libRoot, dir, 'meta.json'), null)
          const hit = (meta?.attempts || []).find(item => item.classroomId === String(id))
          if (!hit) continue
          const version = (meta.versions || []).find(item => item.version === hit.version) || (meta.versions || []).slice(-1)[0]
          const fileMeta = (version?.files || [])[0]
          if (!fileMeta?.stored) continue
          absPath = within(cfg.stateRoot, join(cfg.stateRoot, fileMeta.stored))
          name = fileMeta.name
          break
        }
      }
      if (!absPath) return fail('这间课堂没有保存原件（这版课件没有通过教材库上传）', 404)
      return json(await originalPayload(absPath, name || 'source.bin', cfg.stateRoot, Boolean(body?.raw)))
    }
    // 查看原文：返回抽取后的原文与原件信息（原件在课堂目录 original/ 下）
    if (action === 'source') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''))) return fail('课堂 ID 不合法')
      const base = within(join(cfg.stateRoot, 'classrooms'), join(cfg.stateRoot, 'classrooms', String(id)))
      try {
        const text = await readFile(join(base, 'source.md'), 'utf8')
        const teaching = await stateOf(cfg, String(id))
        return json({
          name: teaching?.sourceFile?.name || 'source.md',
          text,
          chars: text.length,
          version: teaching?.sourceVersion || 1,
          previous: teaching?.previous || null,
          change: teaching?.sourceChange || null,
          original: teaching?.sourceFile || null,
        })
      } catch {
        return fail('这间课堂还没有原文', 404)
      }
    }
    // 导出人员考核试卷 / 答案册：题库生成后就有，可随时下载
    if (action === 'export') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''))) return fail('课堂 ID 不合法')
      const kind = String(body?.kind || 'exam')
      const file = kind === 'answers' ? 'answer-key.md' : 'exam-paper.md'
      const path = within(join(cfg.stateRoot, 'classrooms'), join(cfg.stateRoot, 'classrooms', String(id), file))
      try {
        const content = await readFile(path, 'utf8')
        return json({ name: `${file.replace(/\.md$/, '')}-${id}.md`, content })
      } catch {
        return fail('这间课堂还没生成题库，先跑到「按原文密度出题库」这一步', 404)
      }
    }
    if (action === 'state') {
      return json({ teaching: await stateOf(cfg, id) })
    }
    return fail('不支持的课堂操作：支持 open / append / teach / advance / say / decide / review / gate / state')
  } catch (error) {
    return classroomError(error)
  }
}

/**
 * Register the academy page and its JSON endpoints. The navigation entry is a
 * separate client plugin, so this function no longer touches the index document.
 * `ctx.inject` (rather than the plugin's static `inject` array) keeps the
 * tools and slash commands usable in compositions without a web server.
 */
export async function mountAcademy(ctx, cfg, runPipeline) {
  const fallbackHtml = await readFile(PAGE_FILE, 'utf8')
  const deps = { chat: null, ctx }
  try { deps.chat = makeChat(ctx, cfg) } catch { deps.chat = null }

  ctx.inject(['webServer', 'connection'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/academy',
      handler: async (_req, res) => {
        // Read per request so editing the self-contained page does not need a
        // Web restart; the boot-time copy is only a fallback.
        let html = fallbackHtml
        try { html = await readFile(PAGE_FILE, 'utf8') } catch { /* keep fallback */ }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(html)
      },
    }), 'learning-academy: academy page')

    const routes = [
      {
        path: '/api/academy/materials',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch() {
          try {
            const out = await listMaterials(cfg.stateRoot)
            // 卡片上要写「学到哪 / 学完笔记多少字 / 题库多少题 / 考核几分」，
            // 这些只在课堂状态里，按课堂读一次；读不到就少显示几项，不拖垮列表。
            for (const m of out.materials) {
              const classId = m.lastAttempt?.classroomId
              if (!classId) {
                // 流水线时代学完的教材没有课堂，学习结果直接记在 attempt 上。
                if (m.lastAttempt?.stats) m.stats = m.lastAttempt.stats
                continue
              }
              try {
                const facts = await teachingFacts(cfg, classId)
                if (!facts) continue
                m.classroomId = classId
                m.stage = facts.stage
                m.stageLabel = facts.stageLabel
                m.stageDetail = facts.stageDetail
                m.stats = {
                  notesChars: facts.notesChars,
                  bank: facts.bank,
                  exam: facts.exam,
                  coverage: facts.coverage,
                }
                const scope = scopeText(facts.scope)
                if (scope) m.intro = scope
              } catch { /* 课堂状态坏了不该让整个教材库读不出来 */ }
            }
            return json(out)
          } catch (error) { return fail(String(error?.message || error), 500) }
        },
      },
      {
        path: '/api/academy/material',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          try {
            const url = new URL(request.url)
            const id = url.searchParams.get('id')
            const version = Number(url.searchParams.get('version')) || undefined
            const wanted = await materialSource(cfg.stateRoot, id, version)
            const body = {
              material: materialSummary(wanted.meta),
              version: wanted.version,
              record: {
                version: wanted.record.version,
                parts: wanted.record.parts,
                chars: wanted.record.chars,
                files: (wanted.record.files || []).map(f => ({ part: f.part, name: f.name, chars: f.chars })),
                createdAt: wanted.record.createdAt,
                status: wanted.record.status,
              },
              attempts: wanted.meta.attempts || [],
              history: (wanted.meta.versions || []).map(v => ({
                version: v.version, status: v.status, chars: v.chars, parts: v.parts,
                createdAt: v.createdAt, completedAt: v.completedAt || '',
              })),
            }
            if (url.searchParams.get('file') === '1') {
              // 原始上传文件（不是抽取文本）：按需取某一版某个附件
              const part = Number(url.searchParams.get('part')) || 1
              const fileMeta = (wanted.record.files || [])[part - 1]
              if (!fileMeta || !fileMeta.stored) return fail('这一版没有保存原件', 404)
              const abs = within(cfg.stateRoot, join(cfg.stateRoot, fileMeta.stored))
              const payload = await originalPayload(abs, fileMeta.name, cfg.stateRoot, url.searchParams.get('raw') === '1')
              return json({ ...payload, version: wanted.version })
            }
            if (url.searchParams.get('source') === '1') body.markdown = wanted.text
            return json(body)
          } catch (error) { return fail(String(error?.message || error), Number(error?.status) || 404) }
        },
      },
      {
        path: '/api/academy/material/upload',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleMaterialUpload(request, cfg, deps)
          .catch(error => fail(String(error?.message || error), 500)),
      },
      {
        path: '/api/academy/material/enter',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleMaterialEnter(request, cfg)
          .catch(error => fail(String(error?.message || error), 500)),
      },
      {
        path: '/api/academy/material/learn',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleMaterialLearn(request, cfg)
          .catch(error => fail(String(error?.message || error), 500)),
      },
      {
        path: '/api/academy/courses',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch() {
          try { return json({ courses: await listCourses(cfg), generatedAt: new Date().toISOString() }) }
          catch (error) { return fail(String(error?.message || error), 500) }
        },
      },
      {
        path: '/api/academy/course',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          try {
            const rel = new URL(request.url).searchParams.get('rel')
            return json(await readCourse(cfg, rel))
          } catch (error) { return fail(String(error?.message || error), 404) }
        },
      },
      {
        path: '/api/academy/status',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          try {
            const id = new URL(request.url).searchParams.get('id')
            const state = await readState(cfg, id)
            return json({
              id: state.id,
              status: state.status,
              stage: state.stage,
              startedAt: state.startedAt,
              finishedAt: state.finishedAt,
              error: state.error,
              stages: Object.keys(state.stages || {}),
              result: state.result ? {
                title: state.result.title,
                score: state.result.score,
                docRel: state.result.docRel,
              } : null,
            })
          } catch {
            // The pipeline may not have written state.json yet. Treat a freshly
            // submitted id as queued so the progress poll does not flash an error.
            const id = new URL(request.url).searchParams.get('id') || ''
            if (/^learn-\d{14}-[a-f0-9]{8}$/.test(id)) {
              return json({ id, status: 'running', stage: 'ingest', stages: [], result: null })
            }
            return fail('找不到该学习会话', 404)
          }
        },
      },
      {
        path: '/api/academy/upload',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleUpload(request, ctx, cfg, runPipeline)
          .catch(error => fail(String(error?.message || error), 500)),
      },
      {
        path: '/api/academy/classrooms',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch() {
          try { return json(await listClassrooms(cfg.stateRoot)) }
          catch (error) { return classroomError(error) }
        },
      },
      {
        path: '/api/academy/classroom',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          if (request.method === 'POST') return handleClassroomPost(request, cfg, deps)
          if (request.method !== 'GET') return fail('只支持 GET 与 POST', 405)
          try {
            const id = new URL(request.url).searchParams.get('id')
            const room = await getClassroom(cfg.stateRoot, id)
            let teaching = null
            try { teaching = await stateOf(cfg, id) } catch { teaching = null }
            return json({ ...room, teaching })
          } catch (error) { return classroomError(error) }
        },
      },
      {
        path: '/api/academy/classroom/notes',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          try {
            const id = new URL(request.url).searchParams.get('id')
            const data = await getClassroom(cfg.stateRoot, id)
            return json({
              id: data.classroom.id,
              title: data.classroom.title,
              updatedAt: data.classroom.updatedAt,
              markdown: data.notes,
            })
          } catch (error) { return classroomError(error) }
        },
      },
    ]

    for (const route of routes) {
      webCtx.effect(() => webCtx.connection.fetch.register(route), `learning-academy: ${route.path}`)
    }

    try {
      ctx.root?.logger?.('learning-academy')?.info?.('academy mounted at /academy with 12 authenticated API routes (教材库 + classroom chat + teaching engine)')
    } catch { /* optional logger */ }
  })
}
