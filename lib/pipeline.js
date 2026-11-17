/**
 * 智能助理学院 — 工具入口与状态读取。
 *
 * `learn_document` 工具和 `/learn` 命令走这里：把资料抽成文字，开一间课堂，
 * 然后按学习引擎的计划一路推进到「等人工复核」或「已入库」。
 * 学习本身（切片、精读、校验、复核、出题、入库）都在 engine.js，这里只负责
 * 认文件、跑循环、写一份可供 /learn-status 轮询的状态镜像。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendMessage, openClassroom } from './classroom.js'
import * as engine from './engine.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

const PLAIN_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.xml', '.html', '.htm'])

export const DEFAULTS = {
  knowledgeRoot: '',
  skillsRoot: '',
  learnedDir: 'learned',
  stateRoot: '',
  attachmentsRoot: '',
  remeEndpoint: 'http://127.0.0.1:2333',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  temperature: 0.3,
  maxTokens: 24000,
  // 全文精读引擎的口径：分片、字数门限、回退次数、人工复核
  engine: 'v2',
  chunkChars: engine.DEFAULTS.chunkChars,
  noteRatioTarget: engine.DEFAULTS.noteRatioTarget,
  noteRatioFloor: engine.DEFAULTS.noteRatioFloor,
  enableManualReview: engine.DEFAULTS.enableManualReview,
  maxRepairRounds: engine.DEFAULTS.maxRepairRounds,
  maxAttempts: engine.DEFAULTS.maxAttempts,
  concurrentChunks: engine.DEFAULTS.concurrentChunks,
  quizBatch: engine.DEFAULTS.quizBatch,
  examPercent: engine.DEFAULTS.examPercent,
  examSampleMin: engine.DEFAULTS.examSampleMin,
  examSample: engine.DEFAULTS.examSample,
  memoryPartChars: engine.DEFAULTS.memoryPartChars,
  maxSourceChars: 60000,
  autoCommit: true,
  reindexScope: 'bm25',
  academyEnabled: true,
  passThreshold: 0.75,
  pythonExe: '',
  pyLibs: '',
  extractorScript: '',
}

/* ------------------------------------------------------------------ utils */

function within(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) return t
  throw new Error(`拒绝写入知识目录之外的路径：${t}`)
}

export function jsonExtract(raw) {
  const text = String(raw || '').trim()
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  try {
    const value = JSON.parse(text)
    if (isObject(value)) return value
  } catch { /* keep looking */ }
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = fence[1].trim()
    if (!inner.startsWith('{')) continue
    try {
      const value = JSON.parse(inner)
      if (isObject(value)) return value
    } catch { /* try the next fence */ }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象')
  let body = text.slice(start, end + 1)
  try {
    return JSON.parse(body)
  } catch {
    body = body.replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new Error(`模型返回的 JSON 无法解析：${String(error?.message || error).slice(0, 160)}`)
    }
  }
}

/** 一次 LLM 调用：课堂与工具共用同一套 stream 适配。 */
export function makeChat(ctx, cfg) {
  return async ({ system, prompt, maxTokens, signal }) => {
    const request = {
      provider: cfg.provider,
      model: cfg.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: cfg.temperature ?? 0.3,
      maxTokens: maxTokens ?? cfg.maxTokens ?? 8000,
    }
    if (signal) request.signal = signal
    let text = ''
    let reasoning = ''
    let reason = ''
    for await (const chunk of ctx.llm.stream(request)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'finish') reason = String(chunk.reason?.kind ?? chunk.reason?.code ?? chunk.reason ?? '')
    }
    let finish = reason
    // 推理模型常把预算花在思考上：正文为空就如实报 reasoning-only，
    // 让调用方加预算重试，绝不把思考内容当成答案。
    if (!text.trim() && reasoning.trim()) finish = reason || 'reasoning-only'
    else finish = reason
    return { text, finish }
  }
}

/* --------------------------------------------------------------- ingest */

async function locateFile(cfg, options) {
  if (options.filePath) {
    const p = resolve(options.filePath)
    await stat(p)
    return p
  }
  const id = String(options.attachmentId || '').trim()
  if (!id) throw new Error('请给出文件路径，或随 /learn 命令附上要学习的文件')
  if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('附件 ID 不是合法的 sha256')
  const dir = join(cfg.attachmentsRoot, 'files', id.slice(0, 2), id)
  if (options.attachmentName) {
    const candidate = join(dir, basename(options.attachmentName))
    try { await stat(candidate); return candidate } catch { /* fall through */ }
  }
  const entries = await readdir(dir)
  if (!entries.length) throw new Error(`附件目录为空：${dir}`)
  return join(dir, entries[0])
}

/**
 * 抽文字，同时把「哪些内容抽不出来」如实带出来：扫描页、图片、脚注、页眉。
 * 完整读取的前提是知道自己没读到什么，而不是假装原文只有这些字。
 */
/** 解析可用的 Python：配置优先，否则按 python3 / python 找。失败信息要可操作。 */
let cachedPython = null
async function resolvePython(cfg) {
  if (cfg.pythonExe) return cfg.pythonExe
  if (cachedPython) return cachedPython
  for (const candidate of ['python3', 'python']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 8000, windowsHide: true })
      cachedPython = candidate
      return candidate
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到可用的 Python：请安装 Python 3，或在配置里设置 pythonExe')
}

export async function extractDocument(cfg, filePath) {
  const ext = extname(filePath).toLowerCase()
  if (PLAIN_EXT.has(ext)) {
    const buf = await readFile(filePath)
    return { text: buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), warnings: [] }
  }
  // 抽取脚本默认用包内自带的 lib/extract.py：装到哪个目录都能找到，不必配绝对路径
  const script = cfg.extractorScript || join(HERE, 'extract.py')
  const python = await resolvePython(cfg)
  const { stdout, stderr } = await execFileAsync(
    python,
    [script, filePath, String(cfg.maxSourceChars * 2)],
    {
      env: { ...process.env, YOULIAN_PY_LIBS: cfg.pyLibs, PYTHONUTF8: '1' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300000,
      windowsHide: true,
    },
  )
  if (!stdout.trim()) throw new Error(`抽取失败：${String(stderr || '').slice(0, 300) || '无文本输出'}`)
  if (/\[抽取文本已截断/.test(stdout)) {
    throw new Error('原文超过抽取上限被截断，拒绝在残缺文本上开课；请拆分文件或调高 maxSourceChars 后重试')
  }
  const warnings = String(stderr || '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('YOULIAN_EXTRACT_WARN:'))
    .map(line => line.slice('YOULIAN_EXTRACT_WARN:'.length).trim())
    .filter(Boolean)
    .slice(0, 20)
  return { text: stdout.replace(/\r\n/g, '\n'), warnings }
}

export async function extractText(cfg, filePath) {
  return (await extractDocument(cfg, filePath)).text
}

/* ------------------------------------------------------------- pipeline */

/**
 * 跑一次完整学习：抽字 → 开课 → 按计划推进。
 * 默认在「等人工复核」处停下（enableManualReview），去学院页面复核后自动出题入库。
 *
 * @param ctx 插件上下文（提供 ctx.llm）
 * @param cfg 插件配置
 * @param options 文件、标题、标签与会话
 * @returns 学习结果或待复核状态
 */
export async function runPipeline(ctx, cfg, options) {
  const id = options?.id
    || `learn-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)}`
  const dir = within(cfg.stateRoot, join(cfg.stateRoot, 'sessions', id))
  await mkdir(dir, { recursive: true })
  const state = {
    id,
    status: 'running',
    stage: 'ingest',
    classroomId: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    source: null,
    error: null,
    result: null,
  }
  const persist = async () => {
    await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  await persist()

  try {
    const filePath = await locateFile(cfg, options)
    const extracted = await extractDocument(cfg, filePath)
    const raw = extracted.text
    const bytes = await readFile(filePath)
    const title = String(options.title || '').trim() || basename(filePath).replace(/\.[^.]+$/, '')
    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    // 同一份原文已经学过：不再重复学、不再重复写记忆，直接把已有的课堂交回去
    if (!options.force) {
      const learned = await engine.findBySource(cfg.stateRoot, sourceHash)
      if (learned) {
        state.status = 'completed'
        state.stage = 'done'
        state.finishedAt = new Date().toISOString()
        state.result = { title: learned.title, source: basename(filePath), classroomId: learned.id, reused: true, summary: `同一份原文已学过：${learned.title}（${learned.id}），未重复学习。` }
        await persist()
        return { id, status: 'completed', title: learned.title, source: basename(filePath), classroomId: learned.id, reused: true }
      }
    }
    state.source = {
      filePath,
      name: basename(filePath),
      sha256: sourceHash,
      bytes: bytes.length,
      extractedChars: raw.length,
      warnings: extracted.warnings,
    }
    state.stage = 'teach'
    await persist()

    const room = await openClassroom(cfg.stateRoot, { id, title })
    state.classroomId = room.classroom.id
    await persist()
    if (extracted.warnings.length) {
      await appendMessage(cfg.stateRoot, room.classroom.id, {
        id: `extract-warn-${id}`,
        role: 'system',
        kind: 'system',
        content: `抽取告警（这些内容这次读不到，别当成原文没有）：\n- ${extracted.warnings.join('\n- ')}`,
        meta: { step: 'extract-warnings', count: extracted.warnings.length },
      }).catch(() => {})
    }
    await engine.openTeaching(cfg.stateRoot, {
      id: room.classroom.id,
      title,
      source: raw,
      sourceName: basename(filePath),
      sourceFile: filePath,
      cfg,
    })
    const chat = makeChat(ctx, cfg)
    const budgetMs = Math.max(60000, Number(options.budgetMs) || 20 * 60 * 1000)
    const startedAt = Date.now()
    let last = null
    for (let step = 0; step < 400; step++) {
      if (options.signal?.aborted) throw new Error('学习被取消')
      if (Date.now() - startedAt > budgetMs) {
        state.status = 'running'
        state.stage = last?.state?.stage || state.stage
        await persist()
        return {
          id,
          status: 'running',
          title,
          source: state.source.name,
          classroomId: room.classroom.id,
          stage: state.stage,
          note: '本轮时间预算用完，进度都在盘上；去学院页面点「继续上课」接着走。',
        }
      }
      const out = await engine.advance(cfg.stateRoot, { id: room.classroom.id, chat, cfg })
      last = out
      state.stage = out.state?.stage || state.stage
      await persist()
      if (out.blocked || out.state?.plan?.blocked) {
        state.status = 'blocked'
        state.error = `自动校验未通过：${out.blocked?.reason || out.state?.plan?.blocked?.reason || ''}`
        state.finishedAt = new Date().toISOString()
        await persist()
        return { id, status: 'blocked', title, source: state.source.name, classroomId: room.classroom.id, error: state.error }
      }
      if (out.state?.stage === 'review') {
        state.status = 'awaiting_review'
        state.finishedAt = new Date().toISOString()
        await persist()
        return { id, status: 'awaiting_review', title, source: state.source.name, classroomId: room.classroom.id, stage: 'review' }
      }
      if (out.state?.stage === 'finished') break
    }
    const teaching = await engine.teachingState(cfg.stateRoot, room.classroom.id, cfg)
    const commit = teaching.commit || {}
    const questions = (teaching.questions || []).length
    const points = teaching.brief?.clauses?.total || 0
    state.status = 'completed'
    state.stage = 'done'
    state.finishedAt = new Date().toISOString()
    state.result = {
      title,
      source: state.source.name,
      score: teaching.review?.report?.ratio || 0,
      passThreshold: cfg.passThreshold ?? 0.75,
      knowledgePoints: points,
      questions,
      corrections: teaching.brief?.validation?.missingTokens?.length || 0,
      docPath: commit.docPath || '',
      reviewRequired: teaching.stage !== 'finished' || !commit.reme?.ok,
      librarySkillPath: commit.skillPath || '',
      libraryChanged: Boolean(commit.skillChanged),
      sessionDir: dir,
      classroomId: room.classroom.id,
      reme: { dailyWriteOk: Boolean(commit.reme?.dailyWrite), reindexOk: Boolean(commit.reme?.reindex) },
      memorySearchHit: Boolean(commit.reme?.searchHit),
      summary: commit.summary || '',
    }
    await persist()
    return state.result
  } catch (error) {
    state.status = 'failed'
    state.error = String(error?.stack || error?.message || error)
    state.finishedAt = new Date().toISOString()
    await persist()
    throw error
  }
}

/* --------------------------------------------------------------- status */

export async function readStatus(cfg, id) {
  const base = within(cfg.stateRoot, join(cfg.stateRoot, 'sessions'))
  const readOne = async name => {
    const text = await readFile(join(base, name, 'state.json'), 'utf8')
    const state = JSON.parse(text)
    // 学习引擎的进度在课堂里，镜像只用来轮询阶段；能读到就补上实时阶段
    if (state.classroomId) {
      try {
        const teaching = await engine.teachingState(cfg.stateRoot, state.classroomId, cfg)
        state.live = { stage: teaching.stage, stageLabel: teaching.stageLabel, plan: teaching.plan, study: teaching.study }
      } catch { /* 课堂还没建好 */ }
    }
    return state
  }
  if (id) return readOne(within(base, join(base, id)))
  let entries = []
  try { entries = await readdir(base, { withFileTypes: true }) } catch { return [] }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, 8)
  const out = []
  for (const name of dirs) {
    try { out.push(await readOne(name)) } catch { /* skip incomplete */ }
  }
  return out
}

export function summarize(state) {
  if (Array.isArray(state)) {
    return state.map(s => {
      const stage = s.live?.stageLabel || s.stage || ''
      return `${String(s.status).padEnd(18)} ${String(stage).padEnd(10)} ${s.id}  ${s.source?.name || ''}`
    }).join('\n') || '（暂无学习会话）'
  }
  const lines = [
    `会话：${state.id}`,
    `状态：${state.status}　阶段：${state.live?.stageLabel || state.stage}`,
    `来源：${state.source?.name || '—'}`,
    `开始：${state.startedAt}`,
  ]
  if (state.live?.study) {
    lines.push(`进度：精读 ${state.live.study.partsDone}/${state.live.study.partsTotal} 片，`
      + `覆盖 ${state.live.study.coverage || '—'}，笔记 ${state.live.study.ratio || 0} 倍`)
  }
  if (state.live?.plan) lines.push(`计划：${state.live.plan.done}/${state.live.plan.steps} 步，回退 ${state.live.plan.retries} 次`)
  if (state.result) {
    const r = state.result
    lines.push(
      `笔记倍数：${r.score}　知识点：${r.knowledgePoints}　题数：${r.questions}`,
      `知识文件：${r.docPath || '—'}`,
      `长期记忆：daily_write ${r.reme?.dailyWriteOk ? '成功' : '未成功'}，reindex ${r.reme?.reindexOk ? '成功' : '未成功'}`,
    )
  }
  if (state.status === 'awaiting_review') {
    lines.push(`待人工复核：课堂 ${state.classroomId}（在学院页面复核通过后自动出题入库）`)
  }
  if (state.error) lines.push(`错误：${String(state.error).split('\n')[0]}`)
  return lines.join('\n')
}
