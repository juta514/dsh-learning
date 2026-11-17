/**
 * 智能助理学院 — 教材库内核。
 *
 * 课堂学的是一本教材，不是一次上传。教材库把「书」和「上课」分开：
 * 上传只入库，零模型调用，状态是 uploaded；进课堂才开始学，状态转
 * studying；结课转 completed。同一本教材换版不新建书，版本号加一，旧
 * 版本的原样留着，旧课堂记录也留在原来的版本上，日后才能做换版差异。
 *
 * 目录布局（都在 stateRoot 下）：
 *   library/<materialId>/meta.json          书目录：版本、附件、学习记录
 *   library/<materialId>/v<N>/source.md     该版合并后的正文，课堂只认这一份
 *   library/<materialId>/v<N>/parts/NN-*.md 该版每个附件的抽取结果
 *   library/<materialId>/attempts/N/…       第 N 次学习的归档（指向课堂）
 *
 * 零依赖，只用 Node 内置模块。可脱离 Web 与模型单独跑：
 *   node lib/library.js --selftest
 */

import {
  mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDocument } from './pipeline.js'

export const MATERIAL_STATUS = Object.freeze(['uploaded', 'studying', 'completed'])
export const STATUS_LABEL = Object.freeze({
  uploaded: '未学习', studying: '学习中', completed: '已完成',
})
const MAX_PARTS = 20

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function within(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) return t
  throw httpError('路径超出教材库范围', 400)
}

function safeMaterialId(raw) {
  const value = String(raw || '').trim()
  if (!/^mat-[A-Za-z0-9_-]{6,80}$/.test(value)) throw httpError('教材 ID 不合法', 400)
  return value
}

function safeName(raw) {
  const base = basename(String(raw || '').replace(/\\/g, '/'))
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base || 'part.txt'
}

function slug(raw) {
  return safeName(raw).replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40) || 'part'
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function newMaterialId() {
  return `mat-${stamp()}-${randomBytes(4).toString('hex')}`
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/**
 * 卡片上那句简介。优先用入库时写下的，没有就从正文开头挑两行：
 * 去掉 frontmatter、注释、标题行和表格，剩下的第一段话就是。
 */
export function introOf(text, limit = 120) {
  const body = String(text || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const lines = body.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line
      && !/^#{1,6}\s/.test(line)
      && !/^\|/.test(line)
      && !/^[-=*_]{3,}$/.test(line))
  let out = lines.slice(0, 6).join(' ')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length > limit) out = `${out.slice(0, limit).replace(/[，、；：,;:]+$/, '')}…`
  return out
}

async function sourceIntro(stateRoot, id, record) {
  const file = join(materialDir(stateRoot, id), record.source || `v${record.version || 1}/source.md`)
  try { return introOf(await readFile(file, 'utf8')) } catch { return '' }
}

async function atomicWrite(file, content) {
  await mkdir(join(file, '..'), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function libraryRoot(stateRoot) {
  return within(stateRoot, join(stateRoot, 'library'))
}

export function materialDir(stateRoot, id) {
  return within(libraryRoot(stateRoot), join(libraryRoot(stateRoot), safeMaterialId(id)))
}

/** 正文合并：单文件原样；多文件各成一级标题，章节因此按附件分得开。 */
export function mergeParts(parts, meta = {}) {
  if (parts.length === 1) return parts[0].text
  const head = `<!-- youlian-material ${meta.id || ''} v${meta.version || 1} · ${parts.length} 个附件 -->\n`
  const body = parts.map(p => [
    `# 附件 ${p.part}：${p.name}`,
    `<!-- ${p.chars} 字 · sha ${p.sha256.slice(0, 12)} -->`,
    '',
    p.text.trim(),
    '',
  ].join('\n')).join('\n')
  return `${head}\n${body}`.replace(/\n{3,}/g, '\n\n')
}

async function writeVersion(stateRoot, id, version, parts, meta) {
  const dir = join(materialDir(stateRoot, id), `v${version}`)
  const partsDir = join(dir, 'parts')
  await mkdir(partsDir, { recursive: true })
  const files = []
  for (const p of parts) {
    const rel = `parts/${String(p.part).padStart(2, '0')}-${slug(p.name)}.md`
    await writeFile(join(dir, rel), p.text, 'utf8')
    files.push({
      part: p.part,
      name: p.name,
      ext: p.ext,
      sha256: p.sha256,
      bytes: p.bytes,
      chars: p.chars,
      stored: p.stored || '',
      text: rel,
    })
  }
  const source = mergeParts(parts, { id, version })
  await writeFile(join(dir, 'source.md'), source, 'utf8')
  const warnings = [...new Set(parts.flatMap(p => p.warnings || []))].slice(0, 20)
  return {
    version,
    createdAt: new Date().toISOString(),
    parts: parts.length,
    chars: source.length,
    source: `v${version}/source.md`,
    status: 'uploaded',
    completedAt: '',
    files,
    warnings,
    ...meta,
  }
}

/**
 * 入库。给了 materialId 就是换版，否则新建一本。
 * 一次调用里给几个文件，就是这本书的几个附件（parts）。
 */
export async function ingestMaterial(stateRoot, cfg, options = {}) {
  const incoming = Array.isArray(options.files) ? options.files.filter(f => f && f.buffer?.length) : []
  if (!incoming.length) throw httpError('没有收到文件', 400)
  if (incoming.length > MAX_PARTS) throw httpError(`一次最多 ${MAX_PARTS} 个附件`, 413)

  const replaceId = options.materialId ? safeMaterialId(options.materialId) : ''
  let meta = null
  if (replaceId) {
    meta = await readJson(join(materialDir(stateRoot, replaceId), 'meta.json'), null)
    if (!meta) throw httpError('找不到这本教材', 404)
  }
  const id = replaceId || newMaterialId()
  const version = meta ? Number(meta.version || 1) + 1 : 1

  const uploadsDir = join(stateRoot, 'uploads')
  await mkdir(uploadsDir, { recursive: true })
  const parts = []
  for (const [i, file] of incoming.entries()) {
    const name = safeName(file.name)
    const buffer = file.buffer
    const hash = sha256(buffer)
    const stored = join(uploadsDir, `${hash.slice(0, 12)}-${name}`)
    if (!(await stat(stored).catch(() => null))) await writeFile(stored, buffer)
    let text
    let warnings = []
    try {
      const extracted = await extractDocument(cfg, stored)
      text = extracted.text
      warnings = extracted.warnings
    } catch (error) {
      throw httpError(`${name} 抽不出文字：${String(error?.message || error).slice(0, 160)}`, 415)
    }
    if (!String(text || '').trim()) {
      throw httpError(`${name} 抽不出文字（可能是扫描件或加密文件），请先转成可复制文字的 PDF 或 Word`, 415)
    }
    parts.push({
      part: i + 1,
      name,
      ext: extname(name).toLowerCase(),
      sha256: hash,
      bytes: buffer.length,
      chars: text.length,
      text,
      warnings,
      stored: `uploads/${basename(stored)}`,
    })
  }

  const record = await writeVersion(stateRoot, id, version, parts, {})
  const now = new Date().toISOString()
  const title = String(options.title || '').trim().slice(0, 160)
    || (meta?.title || safeName(incoming[0].name).replace(/\.[^.]+$/, ''))
  if (!meta) {
    meta = {
      id,
      title,
      tags: Array.isArray(options.tags) ? options.tags.slice(0, 8) : [],
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: 'uploaded',
      versions: [],
      attempts: [],
      source: options.source || 'upload',
      // 卡片上那段摘要由模型通读后写，上传一返回就先标成「在写」
      summaryStatus: 'pending',
    }
  }
  // 换版内容变了，旧摘要不能再挂在卡片上，重写一份
  if (replaceId) meta.summaryStatus = 'pending'
  meta.title = title
  meta.updatedAt = now
  meta.version = version
  meta.status = 'uploaded'
  // 简介只在第一次建书时写下来，换版不覆盖：卡片上那句话描述的是这本书。
  if (!meta.intro) meta.intro = introOf(parts[0].text)
  meta.versions = Array.isArray(meta.versions) ? meta.versions : []
  meta.attempts = Array.isArray(meta.attempts) ? meta.attempts : []
  meta.versions.push(record)
  // 换版不动旧版本的状态：v1 学完了就是学完了，v2 从「未学习」重新开始。
  if (Array.isArray(options.tags) && options.tags.length) meta.tags = options.tags.slice(0, 8)

  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

/** 卡片摘要：模型通读原文后写两三句，落在这里；不动 updatedAt，免得摘要写完把书顶到最前面。 */
export async function setCardSummary(stateRoot, id, patch = {}) {
  const meta = await readMaterial(stateRoot, id)
  if (typeof patch.summary === 'string' && patch.summary.trim()) meta.summary = patch.summary.trim().slice(0, 400)
  if (Array.isArray(patch.keywords)) {
    meta.keywords = patch.keywords.map(x => String(x).trim()).filter(Boolean).slice(0, 8)
  }
  meta.summaryStatus = patch.status || (meta.summary ? 'done' : 'failed')
  meta.summaryAt = new Date().toISOString()
  if (patch.error) meta.summaryError = String(patch.error).slice(0, 200)
  else if (meta.summaryError) delete meta.summaryError
  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

export async function readMaterial(stateRoot, id) {
  const meta = await readJson(join(materialDir(stateRoot, id), 'meta.json'), null)
  if (!meta) throw httpError('找不到这本教材', 404)
  meta.versions = Array.isArray(meta.versions) ? meta.versions : []
  meta.attempts = Array.isArray(meta.attempts) ? meta.attempts : []
  if (!meta.status) meta.status = meta.versions.at(-1)?.status || 'uploaded'
  return meta
}

export async function listMaterials(stateRoot) {
  const root = libraryRoot(stateRoot)
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return { materials: [] } }
  const materials = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mat-')) continue
    const meta = await readJson(join(root, entry.name, 'meta.json'), null)
    if (!meta || !meta.id) continue
    const versions = Array.isArray(meta.versions) ? meta.versions : []
    const attempts = Array.isArray(meta.attempts) ? meta.attempts : []
    const latest = versions.at(-1) || {}
    // 换版之后旧版的学习记录还在，但卡片和「进入课堂」认的是当前这一版：
    // v2 一次没学过，就不该把 v1 的课堂和分数摆出来。
    const current = Number(meta.version || latest.version || 1)
    const lastAttempt = attempts.filter(a => Number(a.version) === current).at(-1) || null
    // 迁移进来的老书没有 intro 字段，第一次列出来时补一份，之后就不再读正文了。
    let intro = String(meta.intro || '').trim()
    if (!intro) {
      intro = await sourceIntro(stateRoot, meta.id, latest)
      if (intro) {
        meta.intro = intro
        await atomicWrite(join(root, entry.name, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`).catch(() => {})
      }
    }
    materials.push({
      id: meta.id,
      title: meta.title || '(未命名教材)',
      intro,
      summary: String(meta.summary || ''),
      summaryStatus: String(meta.summaryStatus || (meta.summary ? 'done' : '')),
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      tags: meta.tags || [],
      status: meta.status || latest.status || 'uploaded',
      statusLabel: STATUS_LABEL[meta.status || latest.status] || '未学习',
      version: Number(meta.version || latest.version || 1),
      versions: versions.length,
      parts: Number(latest.parts || 0),
      chars: Number(latest.chars || 0),
      createdAt: meta.createdAt || '',
      updatedAt: meta.updatedAt || latest.createdAt || '',
      attemptCount: attempts.length,
      attempts: attempts.length,
      lastAttempt,
      files: (latest.files || []).map(f => ({ part: f.part, name: f.name, chars: f.chars })),
      history: versions.map(v => ({
        version: v.version, status: v.status, chars: v.chars, parts: v.parts, createdAt: v.createdAt,
      })),
    })
  }
  materials.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return { materials }
}

/** 直接用已经抽好的正文建一本教材：迁移旧课堂、以及测试时用，不走抽取。 */
export async function createFromText(stateRoot, options = {}) {
  const text = String(options.text || '')
  if (!text.trim()) throw httpError('正文为空，不能建教材', 400)
  const id = options.id ? safeMaterialId(options.id) : newMaterialId()
  const name = safeName(options.partName || 'source.md')
  const buffer = Buffer.from(text, 'utf8')
  const part = {
    part: 1,
    name,
    ext: extname(name).toLowerCase() || '.md',
    sha256: sha256(buffer),
    bytes: buffer.length,
    chars: text.length,
    text,
    stored: options.stored || '',
  }
  const record = await writeVersion(stateRoot, id, 1, [part], {})
  const now = new Date().toISOString()
  const meta = {
    id,
    title: String(options.title || '').trim().slice(0, 160) || id,
    intro: introOf(text),
    tags: Array.isArray(options.tags) ? options.tags.slice(0, 8) : [],
    createdAt: options.createdAt || now,
    updatedAt: now,
    version: 1,
    status: 'uploaded',
    versions: [record],
    attempts: [],
    source: options.source || 'text',
  }
  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

/** 取某一版正文。不给版本就取最新版。 */
export async function materialSource(stateRoot, id, version) {
  const meta = await readMaterial(stateRoot, id)
  const wanted = Number(version) || meta.version
  const record = (meta.versions || []).find(v => Number(v.version) === wanted)
  if (!record) throw httpError(`这版（v${wanted}）不存在`, 404)
  const file = within(materialDir(stateRoot, id), join(materialDir(stateRoot, id), record.source || `v${wanted}/source.md`))
  const text = await readFile(file, 'utf8')
  return { meta, version: wanted, record, text }
}

export async function setStatus(stateRoot, id, status, extra = {}) {
  if (!MATERIAL_STATUS.includes(status)) throw httpError('教材状态不合法', 400)
  const meta = await readMaterial(stateRoot, id)
  meta.status = status
  meta.updatedAt = new Date().toISOString()
  const latest = meta.versions.at(-1)
  if (latest) {
    latest.status = status
    if (status === 'completed') latest.completedAt = meta.updatedAt
  }
  if (extra.version) {
    const record = meta.versions.find(v => Number(v.version) === Number(extra.version))
    if (record) {
      record.status = status
      if (status === 'completed') record.completedAt = meta.updatedAt
    }
  }
  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

/**
 * 进课堂但还没开始上课：记一个待转正的指针，不算一次学习，也不改状态。
 * 用户在教室里点「开始上课」之后才由 addAttempt 转成真正的第 N 次。
 */
export async function prepareAttempt(stateRoot, id, options = {}) {
  const meta = await readMaterial(stateRoot, id)
  const pending = {
    n: Number(options.n) || (meta.attempts || []).length + 1,
    classroomId: String(options.classroomId || ''),
    version: Number(options.version || meta.version),
    openedAt: new Date().toISOString(),
  }
  meta.pending = pending
  meta.updatedAt = pending.openedAt
  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return pending
}

/** 开一次学习：第 N 次。课堂建好后由调用方 bindAttempt 回填课堂 ID。 */
export async function addAttempt(stateRoot, id, options = {}) {
  const meta = await readMaterial(stateRoot, id)
  const n = Number(options.n) || (meta.attempts || []).length + 1
  const attempt = {
    n,
    classroomId: options.classroomId || '',
    version: Number(options.version || meta.version),
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outcome: '',
  }
  meta.attempts.push(attempt)
  meta.status = 'studying'
  // 待转正的那次就是这个 n：转正之后指针就该消失。
  if (meta.pending && Number(meta.pending.n) === n) delete meta.pending
  meta.updatedAt = attempt.startedAt
  const latest = meta.versions.find(v => Number(v.version) === attempt.version)
  if (latest && latest.status !== 'completed') latest.status = 'studying'
  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  await atomicWrite(
    join(materialDir(stateRoot, id), 'attempts', String(n), 'attempt.json'),
    `${JSON.stringify({ ...attempt, materialId: id, title: meta.title }, null, 2)}\n`,
  )
  return { n, attempt }
}

export async function bindAttempt(stateRoot, id, n, patch = {}) {
  const meta = await readMaterial(stateRoot, id)
  const attempt = (meta.attempts || []).find(a => Number(a.n) === Number(n))
  if (!attempt) throw httpError('找不到这次学习记录', 404)
  Object.assign(attempt, patch)
  meta.updatedAt = new Date().toISOString()
  await atomicWrite(join(materialDir(stateRoot, id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  const file = join(materialDir(stateRoot, id), 'attempts', String(n), 'attempt.json')
  const stored = await readJson(file, { ...attempt, materialId: id, title: meta.title })
  await atomicWrite(file, `${JSON.stringify({ ...stored, ...patch, materialId: id, title: meta.title }, null, 2)}\n`)
  return attempt
}

export async function closeAttempt(stateRoot, id, n, outcome = 'finished') {
  const attempt = await bindAttempt(stateRoot, id, n, {
    finishedAt: new Date().toISOString(),
    outcome,
  })
  await setStatus(stateRoot, id, 'completed')
  return attempt
}

/** 由课堂 meta 里的绑定信息，推进教材状态；没绑教材的课堂直接忽略。 */
export async function syncFromClassroom(stateRoot, classroomMeta, stage) {
  const materialId = classroomMeta?.materialId
  if (!materialId) return null
  try {
    if (stage === 'finished') {
      if (classroomMeta.attempt) await closeAttempt(stateRoot, materialId, classroomMeta.attempt)
      else await setStatus(stateRoot, materialId, 'completed')
    } else if (classroomMeta.attempt) {
      await bindAttempt(stateRoot, materialId, classroomMeta.attempt, { outcome: String(stage || 'studying') })
    }
    return await readMaterial(stateRoot, materialId)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Offline self-test                                                  */
/* ------------------------------------------------------------------ */

async function runSelftest() {
  let passed = 0
  const failures = []
  const check = (label, ok) => {
    if (ok) passed++
    else failures.push(label)
  }
  const root = join(process.env.TEMP || '/tmp', `dsh-library-${randomBytes(4).toString('hex')}`)
  await mkdir(root, { recursive: true })
  const cfg = { maxSourceChars: 60000, pythonExe: '', extractorScript: '', pyLibs: '' }
  const file = (name, text) => ({ name, buffer: Buffer.from(text, 'utf8') })

  try {
    const one = await ingestMaterial(root, cfg, {
      files: [file('正文.md', '# 第一章 范围\n本规范适用于整机检验。\n')],
      title: '整机检验规范',
      tags: ['规范'],
    })
    check('单文件入库生成教材 ID', /^mat-/.test(one.id))
    check('单文件 parts 为 1', one.versions[0].parts === 1)
    check('新书状态是未学习', one.status === 'uploaded')
    const src = await materialSource(root, one.id)
    check('单文件正文原样保留', src.text.startsWith('# 第一章 范围'))
    check('新书卡片摘要标成待写', one.summaryStatus === 'pending')
    await setCardSummary(root, one.id, {
      summary: '这份规范讲整机检验的范围与抽样比例，给检验岗在出货前用。',
      keywords: ['整机检验', '抽样'],
      status: 'done',
    })
    const card = (await listMaterials(root)).materials.find(m => m.id === one.id)
    check('摘要写到卡片字段上', card.summary.startsWith('这份规范讲整机检验') && card.summaryStatus === 'done')
    check('关键词随卡片一起返回', card.keywords.includes('抽样'))
    check('卡片带上传时间', Boolean(card.createdAt))

    const multi = await ingestMaterial(root, cfg, {
      files: [
        file('正文.docx.md', '# 正文\n抽样按每批 5% 执行。\n'),
        file('附录A.md', '# 附录 A\n表格 T1 列出公差。\n'),
        file('附件2.md', '# 附件二\n包装标识要求。\n'),
      ],
      title: '一份规范带两个附件',
    })
    check('多文件合成一本', multi.versions[0].parts === 3 && multi.versions[0].files.length === 3)
    const merged = await materialSource(root, multi.id)
    check('合并正文按附件分章', /^# 附件 1：正文\.docx\.md/m.test(merged.text) && /^# 附件 3：附件2\.md/m.test(merged.text))
    check('合并正文含书名与版本注记', merged.text.includes(`youlian-material ${multi.id} v1`))
    check('附件正文各自落盘', await stat(join(materialDir(root, multi.id), 'v1', 'parts', '02-附录A.md')).then(() => true).catch(() => false))

    const bumped = await ingestMaterial(root, cfg, {
      materialId: multi.id,
      files: [file('正文-v2.md', '# 正文（第二版）\n抽样改为每批 8%。\n')],
      title: '一份规范带两个附件',
    })
    check('换版升到 v2 且只 1 个附件', bumped.version === 2 && bumped.versions[1].parts === 1)
    check('旧版仍在且保住已完成状态位', bumped.versions[0].version === 1 && bumped.versions.length === 2)
    check('新版状态回到未学习', bumped.status === 'uploaded' && bumped.versions[1].status === 'uploaded')
    const v1 = await materialSource(root, multi.id, 1)
    check('旧版正文仍可读', v1.text.includes('抽样按每批 5%') && v1.version === 1)
    const v2 = await materialSource(root, multi.id)
    check('不给版本取最新版', v2.version === 2 && v2.text.includes('8%'))

    const attempt = await addAttempt(root, multi.id, { classroomId: 'class-test-1', version: 2 })
    check('开学习记录为第 1 次', attempt.n === 1 && attempt.attempt.classroomId === 'class-test-1')
    check('学习中状态', (await readMaterial(root, multi.id)).status === 'studying')
    check('attempts 目录落盘', await stat(join(materialDir(root, multi.id), 'attempts', '1', 'attempt.json')).then(() => true).catch(() => false))
    await closeAttempt(root, multi.id, 1, 'finished')
    const after = await readMaterial(root, multi.id)
    check('结课转已完成', after.status === 'completed' && after.attempts[0].outcome === 'finished')
    check('只结最新版，旧版状态不动', after.versions[0].status === 'uploaded' && after.versions[1].status === 'completed')

    const second = await addAttempt(root, multi.id, { classroomId: 'class-test-2', version: 2 })
    check('重学是第 2 次，不覆盖第 1 次', second.n === 2 && (await readMaterial(root, multi.id)).attempts.length === 2)

    const listed = await listMaterials(root)
    check('列表含两本教材', listed.materials.length === 2)
    const brief = listed.materials.find(m => m.id === multi.id)
    check('列表带状态中文标签', brief.statusLabel === '学习中' && brief.version === 2)
    check('列表带学习次数', brief.attemptCount === 2)
    check('列表带简介且不含标题符号', Boolean(brief.intro) && !/[#*>]/.test(brief.intro))
    check('简介取自正文而非文件名', brief.intro.includes('抽样'))
    check('列表按更新时间排序', listed.materials[0].updatedAt >= listed.materials[1].updatedAt)

    const pending = await prepareAttempt(root, multi.id, { classroomId: 'class-pending-1', version: 2 })
    const withPending = await readMaterial(root, multi.id)
    check('进课堂先记待转正指针，不算一次学习', pending.n === 3
      && withPending.attempts.length === 2 && withPending.pending.classroomId === 'class-pending-1')
    await addAttempt(root, multi.id, { n: 3, classroomId: 'class-pending-1', version: 2 })
    const promoted = await readMaterial(root, multi.id)
    check('开始上课后指针转正且消失', promoted.attempts.length === 3 && !promoted.pending
      && promoted.attempts[2].classroomId === 'class-pending-1')

    let rejected = 0
    const mustReject = async fn => { try { await fn(); return false } catch { rejected++; return true } }
    await mustReject(() => readMaterial(root, '../escape'))
    await mustReject(() => materialSource(root, 'mat-20260101000000-aaaa1111', 99))
    await mustReject(() => ingestMaterial(root, cfg, { files: [file('x.png.md', '   ')] }))
    await mustReject(() => ingestMaterial(root, cfg, { files: [] }))
    await mustReject(() => setStatus(root, multi.id, 'archived'))
    check('五类非法输入都被拒绝', rejected === 5)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n教材库内核自检：${passed} 项通过，${failures.length} 项失败`)
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
