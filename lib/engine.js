/**
 * 智能助理学院 v2 — 学习引擎。
 *
 * 一条可审计的精读链路，全部判据都是确定性的：
 *
 *   scope → map(按章拆条款) → read(分片) → absorb(逐片精读写知识点)
 *         → validate(八项校验) → clarify(疑点) → review(人工复核)
 *         → quiz(按条款出题) → bind(双向溯源) → commit(入库 + ReMe)
 *
 * 三条硬规矩：
 * 1) 原文先切片段账本，覆盖率、引用、硬指标、表格行、字数比全部按片段判，
 *    不采信模型「我读完了」的自报；
 * 2) 校验不过只回退失败的分片或整片重拆，超过尝试上限整堂停下等人工，
 *    绝不跳步继续；
 * 3) 人工复核通过之前一步都不许出题；复核后笔记哈希锁定，改一个字就失效。
 *
 * 零依赖，模型调用可注入：
 *   node lib/engine.js --selftest
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendMessage, classroomsRoot, getClassroom } from './classroom.js'
import { jsonOf, isRecallQuestion } from './teaching.js'
import {
  RULE_CUE, buildLedger, chunkRanges, coverageOf, copyStats, countChars, densityOf,
  missingTokens, normalize, quoteSupported, ratioOf, seal, tokensOf,
} from './ledger.js'
import { STEP_LABEL, makePlan, markStep, nextBatch, nextStep, planSnapshot, requeue, stepById } from './plan.js'
import { commitLearning } from './commit.js'

export const SCHEMA = 2

const STAGE_LABEL = Object.freeze({
  ready: '等待开课',
  prep: '准备课程',
  study: '精读与校验',
  clarify: '课堂答疑',
  review: '等您复核',
  exam: '出题与绑定',
  finished: '已入库',
  blocked: '等您处理',
})

const ANGLES = Object.freeze(['概念与定义', '流程与顺序', '判定边界', '数据口径', '责任划分', '反例与常见错法'])
const ANGLE_SET = new Set(ANGLES)

export const DEFAULTS = Object.freeze({
  chunkChars: 1600,
  noteRatioTarget: 2,
  noteRatioFloor: 1,
  enableManualReview: true,
  maxRepairRounds: 3,
  maxAttempts: 3,
  concurrentChunks: 2,
  quizBatch: 6,
  examPercent: 0.15,
  examSampleMin: 4,
  examSample: 30,
  memoryPartChars: 4000,
  maxSourceChars: 60000,
  autoCommit: true,
  temperature: 0.3,
  maxTokens: 24000,
})

export const PROMPTS = {
  scope: '你是这门课的教务。先摘清这份资料管什么、不管什么、是哪一版，只摘原文写到的。\n'
    + '只输出 JSON：{"applies_to":["适用的产品/岗位/工序/场景"],"version":"版本号",'
    + '"effective_date":"生效日期","supersedes":"替代了哪一版",'
    + '"mandatory":["强制条款（每条一句，写清章节与要求）"],"recommended":["推荐/示例/附录"],'
    + '"terms":[{"term":"术语","meaning":"原文给的解释"}]}\n'
    + '原文没写的写空字符串或空数组，绝对不要推断。',

  map: '你是课程设计者。下面是一段课件的片段，每行前面的 ⟦S0001⟧ 是片段编号。\n'
    + '把这段课件拆成一条条可执行的条款，不是按字数切块。只输出 JSON：\n'
    + '{"modules":[{"id":"M1","title":"模块名"}],'
    + '"clauses":[{"id":"K1","chapter":"C01","title":"条款名",'
    + '"trigger":"什么情况下适用","action":"必须做什么、禁止做什么",'
    + '"role":"谁做、谁审","params":"数值/时限/格式","exception":"可以不这样做的情形",'
    + '"criteria":"怎么算合规","source":"片段里的一整句原话","segments":["S0001"]}]}\n'
    + '要求：一条只讲一条独立规则；source 必须逐字来自你列的 segments；'
    + '条款要抓规则、不要逐行抄：同一张表的行可以合并成一条条款（segments 把用到的行都列上），'
    + '连续的同类字段说明也可以合并；本章条款总数控制在 10–20 条，优先拆「必须/不得/比例/时限/责任人/例外」；'
    + '数值、比例、时限、责任人、例外、判定边界一个都不许省；按学习顺序排列；只输出那一个 JSON，不要任何解释文字。',

  mapFix: '上一轮这些条款的原文依据对不上片段编号，或者漏了片段。只修这几条，其余不动。\n'
    + '只输出 JSON：{"clauses":[...字段与上一轮完全一致...]}\n'
    + 'source 必须逐字来自 segments 里列出的片段，改不了就删掉这一条，不许编。',

  absorb: '你是替智能助理精读这份资料的学员。下面是第 {i}/{n} 片原文，每行前的 ⟦S####⟧ 是片段编号。\n'
    + '要求（必须逐条做到）：\n'
    + '1）一片不落：本片每个实质性片段编号都必须出现在某条知识点的 segments 里；\n'
    + '2）一个细节不丢：数值、比例、时限、条款号、型号、角色、例外、判定边界全部写进笔记；\n'
    + '3）每条知识点写清：原文依据（逐字抄，一个字都不许改）、解释、适用条件、例外与边界、判据、示例、易错点；\n'
    + '4）解释部分的总字数要达到本片原文的 {ratio} 倍以上（照抄原文不算字数），宁可写细，不许水话；\n'
    + '5）原文没写清的地方进 doubts，不许猜。\n'
    + '只输出 JSON：{"points":[{"id":"","segments":["S0001"],"quote":"原文逐字","title":"",'
    + '"explain":"","conditions":"","exceptions":"","criteria":"","example":"","misconception":""}],"doubts":["..."]}',

  absorbFix: '上一轮这段精读没过校验，问题在下面列出来了。只补不足，不要重写已经合格的条目。\n'
    + '只输出 JSON：{"points":[新增或修订的知识点],"doubts":["..."]}\n'
    + '规则与上一轮相同：segments 必须覆盖缺的片段编号，quote 必须逐字来自这些片段。',

  clarify: '你是这门课的教授。学员提出了一个没弄懂的问题，只依据下面这段原文回答，两三句讲清；'
    + '原文没写到的，直接说「原文没写，不能编，等助教确认」。只输出纯文本，不要 JSON。',

  quiz: '你是这门课的教授。下面列出本课的条款与它们的原文片段，为每一条条款至少出一道考核题。\n'
    + '出题标准：题面给一个具体情形（具体型号、数量、工序或角色），让学员判断该怎么判、取什么值、由谁做；'
    + '禁止「XX 的定义是什么」「包含哪些」这类复述题。\n'
    + '只输出 JSON：{"questions":[{"clause":"K1","angle":"判定边界|数据口径|流程与顺序|责任划分|反例与常见错法|概念与定义",'
    + '"q":"题干","answer_contains":"判分时必须出现的原文原句（逐字，来自该条款的片段）","segments":["S0001"],"rubric":["判分要点"]}]}\n'
    + '要求：answer_contains 必须逐字来自你列的 segments；每条条款至少一题；宁可少而准，不许凑数。',

  ask: '你是这门课的学员（正在学习的智能助理），助教在课堂上问了你一个问题。你要用自己学到的笔记和下面给出的原文片段回答：\n'
    + '1）先一句话给结论；\n'
    + '2）再给依据，每条依据后面用 ⟦S####⟧ 标出它来自哪个片段；\n'
    + '3）片段里没有明确规定的，直接说「原文没有规定」，并说明原文在这一块只写了什么；\n'
    + '4）不许补充片段以外的规则、数字、型号或结论；不许把「原文没写」说成「不需要」。\n'
    + '只输出纯文本，不要 JSON，不要复述问题。',

  chat: '你是这门课的学员（正在学习的智能助理），助教刚在课堂上和你说了句话。\n'
    + '自然、简短地回应（不超过两句、60 字内），可以寒暄、可以确认安排；\n'
    + '不要编造规范内容、不要引用原文、不要主动讲课；若对方的话涉及课程内容你没把握，就说「这个我记一下，你可以直接问我」。\n'
    + '只输出纯文本。',

  // 课堂对话主路径：模型先理解这句话，再自己决定怎么回、要不要查、要不要记。
  converse: '你是这门课的学员（正在学习的智能助理）。助教在课堂上跟你说话。\n'
    + '先理解这句话在说什么，再按类型回应：\n'
    + '1) chat（寒暄、闲聊、进度安排）：自然简短地回应，不讲课；\n'
    + '2) question（问本课内容，哪怕问得很随意，比如「有几大类」「是不是必须」）：用下面给的材料回答。'
    + '结论先行；每条依据后面用 ⟦S####⟧ 标出片段；材料里没有的，直接说「原文没有规定」，'
    + '并说明原文在这一块实际写了什么；\n'
    + '3) knowledge（补充或纠正本课的做法、数值、责任、边界）：说明你记下了什么、会改哪一部分。\n'
    + '材料不够时，用 need 提出还想检索的词（最多 4 个），我会再取一轮原文给你，然后你再回答。\n'
    + '只输出 JSON：{"intent":"chat|question|knowledge","reply":"给助教看的回答（纯文本）",'
    + '"used":["S0001"],"record":"若 intent=knowledge，一句话写清记下的要点","quote":"原文原句，核不上就留空",'
    + '"need":["还想检索的词"]}\n'
    + '硬要求：reply 里的 ⟦S####⟧ 只能来自材料；不许出现材料里没有的数字、型号、条款号；不许编。',

  overviewChapter: '【任务:通读本章】你正在先通读全文、建立整体框架，还没到逐条精读。下面是本章原文。\n'
    + '只做四件事：\n'
    + '1）本章在讲什么（100 字内）；\n'
    + '2）本章出现的关键术语与定义（术语、原文给的解释）；\n'
    + '3）本章与其他章可能的关系（依赖、前提、例外），写清是哪一章；\n'
    + '4）本章没写清、需要后文确认的疑点。\n'
    + '只输出 JSON：{"digest":"","terms":[{"term":"","meaning":""}],'
    + '"relations":[{"target":"章标题或编号","type":"depends|prerequisite|exception","text":""}],"doubts":[""]}\n'
    + '只用原文，不推断；没有的字段给空数组。',

  overviewMerge: '【任务:全文框架】你在通读各章之后，要把它们汇总成一份全局框架；后面拆条款、逐片精读都会带着它走。\n'
    + '只输出 JSON：{"summary":"这份资料到底在讲什么（150 字内）",'
    + '"terms":[{"term":"","meaning":"","chapters":["C01"]}],'
    + '"threads":[{"name":"","chapters":["C01"],"text":""}],'
    + '"relations":[{"from":"C01","to":"C02","type":"depends|prerequisite|exception","text":""}],"doubts":[""]}\n'
    + '要求：术语只收原文给过定义的；主线要能串起全部章节；不要编造章节或术语。',

  reconcile: '【任务:综合核对】你逐片精读完了，现在拿笔记回头对一遍初读框架，回答三件事：\n'
    + '1）笔记是否支撑初读框架？哪些判断被推翻或修正了——写清「原来以为什么、笔记说明什么、依据哪个片段」；\n'
    + '2）跨章条款关系与口径冲突（冲突必须带原文原句）；\n'
    + '3）原文没写清的地方。\n'
    + '只输出 JSON：{"summary":"","threads":[{"name":"","chapters":["C01"],"clauses":["K1"],"text":""}],'
    + '"relations":[{"from":"K1","to":"K2","type":"depends|refines|conflicts|prerequisite","text":""}],'
    + '"conflicts":[{"clauses":["K1"],"text":"","quote":"原文原句"}],"gaps":[{"text":"","quote":""}],'
    + '"corrections":[{"was":"初读以为…","now":"笔记说明…","quote":"原文原句"}]}\n'
    + '要求：只用原文与笔记；冲突、纠正都必须带原文原句；没有就输出空数组，不许编。',

  quizDense: '你是这门课的教授。本课原文 {chars} 字，题库目标是 {need} 道题（约每 100 字一题），'
    + '这一批只出「{chapter}」这一章的题，需要再出 {count} 道。\n'
    + '出题标准：题面给一个具体情形（具体型号、数量、工序或角色），让学员判断该怎么判、取什么值、由谁做；'
    + '禁止「XX 的定义是什么」「包含哪些」这类复述题；同一段原文最多两题。\n'
    + '只输出 JSON：{"questions":[{"clause":"K1","chapter":"{chapter}","angle":"判定边界|数据口径|流程与顺序|责任划分|反例与常见错法|概念与定义",'
    + '"q":"题干","answer_contains":"判分时必须出现的原文原句（逐字，来自该片段）","segments":["S0001"],"rubric":["判分要点"]}]}\n'
    + '要求：answer_contains 必须逐字来自你列的 segments，且 segments 必须落在「{chapter}」里。',

  answerClosed: '你是这门课的学员，正在闭卷抽考：只允许看自己的笔记，不许看原文。\n'
    + '只回答这一题；先给结论，再给依据（指到笔记里的哪一条）；拿不准就说拿不准。\n'
    + '只输出 JSON：{"conclusion":"","basis":"","unsure":""}',

  grade: '你是这门课的教授。学员是闭卷作答，只能看自己的笔记；你手里有原文片段与判分关键词。\n'
    + '评分：结论与关键数值都对 90-100；结论对但依据或细节不足 70-89；结论错、答非所问、只复述原文 0-59。\n'
    + '只输出 JSON：{"score":0到100,"passed":true|false,"comment":"两句内","gap":"最关键的缺口","correct":"答错时给出正确口径"}',

  gradeBatch: '你是这门课的教授，要一次性判完同一份闭卷抽考的全部题目。\n'
    + '每题都有：题干、判分关键词（原文原句）、原文片段、学员闭卷作答。\n'
    + '评分：结论与关键数值都对 90-100；结论对但依据或细节不足 70-89；结论错、答非所问、只复述原文 0-59。\n'
    + '只输出 JSON：{"results":[{"id":"原样返回题目 id","score":0到100,"passed":true|false,'
    + '"comment":"两句内","gap":"最关键的缺口","correct":"答错时给出正确口径"}]}\n'
    + '要求：题数、id 必须与输入一一对应，不许合并、不许漏题、不许新增。',

  quality: '你是独立审读者，不是这份笔记的作者。只读笔记，找出这四类问题：\n'
    + '1）restate：只是把原文换个说法，没有解释；\n'
    + '2）thin：没写清为什么这么规定、或者遇到具体情形怎么判；\n'
    + '3）contradiction：前后说法不一致；\n'
    + '4）missing：漏了关键条件、例外或数值。\n'
    + '只输出 JSON：{"findings":[{"point":"知识点 id","kind":"restate|thin|contradiction|missing","message":"","quote":""}]}\n'
    + '每条必须点名到具体知识点；没有就输出空数组，不许凑数。',
}

/* ------------------------------------------------------------- 小工具 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function safeId(raw) {
  const value = String(raw || '').trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw httpError('课堂 ID 不合法', 400)
  return value
}

function within(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)) return t
  throw httpError('路径超出课堂目录范围', 400)
}

function dirOf(stateRoot, id) {
  const root = classroomsRoot(stateRoot)
  return within(root, join(root, safeId(id)))
}

async function atomicWrite(file, content) {
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, content, 'utf8')
  try { await rename(temp, file) } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

const sha256 = text => createHash('sha256').update(String(text || ''), 'utf8').digest('hex')

/** 同一间课堂的写操作串行化：一次只允许一个推进/复核动作落地。 */
const locks = new Map()
function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(fn)
  locks.set(key, next)
  // 只用来清锁：两个分支都要接住，否则拒绝会变成未处理的 unhandledRejection
  const release = () => { if (locks.get(key) === next) locks.delete(key) }
  next.then(release, release)
  return next
}

/** 推理模型会把预算花在思考上：空正文或截断就加预算重试，不把思考当答案。 */
const MAX_BUDGET = 24000
/** 单次模型调用上限：一次卡死不能把整堂课挂住，超时按失败处理并由步骤重试。 */
const CALL_TIMEOUT_MS = 240000

async function callOnce(chat, args) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
  try {
    return await chat({ ...args, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`模型调用超时（${Math.round(CALL_TIMEOUT_MS / 1000)} 秒）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function callJson(chat, { system, prompt, maxTokens = 8000, tries = 3 }) {
  if (!chat) throw httpError('这个课堂没有可用的模型通道', 503)
  let budget = Math.max(2000, maxTokens)
  let last = ''
  for (let attempt = 1; attempt <= tries; attempt++) {
    const raw = await callOnce(chat, { system, prompt: attempt > 1 ? `${prompt}\n\n提醒：上一次没有给出可解析的 JSON，这次直接输出一个 JSON 对象。` : prompt, maxTokens: budget })
    const text = String((raw && typeof raw === 'object' ? raw.text : raw) || '').trim()
    const finish = String(raw && typeof raw === 'object' ? (raw.finish || '') : '')
    const cut = finish === 'length' || finish === 'max-tokens' || finish === 'reasoning-only'
    if (!text) {
      last = '模型没有返回正文（推理吃掉了预算）'
      budget = Math.min(MAX_BUDGET, Math.round(budget * 1.8))
      continue
    }
    const data = jsonOf(text)
    if (data) return { data, text, truncated: cut }
    last = cut ? '模型输出被长度上限截断' : '模型没有返回可解析的 JSON'
    if (cut || attempt < tries) budget = Math.min(MAX_BUDGET, Math.round(budget * 1.8))
  }
  throw new Error(last || '模型调用失败')
}

async function callText(chat, { system, prompt, maxTokens = 2000, tries = 3 }) {
  if (!chat) throw httpError('这个课堂没有可用的模型通道', 503)
  let budget = Math.max(1500, maxTokens)
  for (let attempt = 1; attempt <= tries; attempt++) {
    const raw = await callOnce(chat, { system, prompt, maxTokens: budget })
    const text = String((raw && typeof raw === 'object' ? raw.text : raw) || '').trim()
    const finish = String(raw && typeof raw === 'object' ? (raw.finish || '') : '')
    if (text) return text
    if (finish !== 'length' && finish !== 'max-tokens' && finish !== 'reasoning-only') break
    budget = Math.min(MAX_BUDGET, Math.round(budget * 1.8))
  }
  throw new Error('模型只出了推理、没有正文，预算被推理吃掉了')
}

/* --------------------------------------------------------------- 状态 */

function freshState({ title, sourceName, source, ledger, plan, density }) {
  return {
    schema: SCHEMA,
    version: 2,
    stage: 'ready',
    title,
    sourceName: sourceName || '',
    sourceChars: countChars(source),
    sourceHash: sha256(String(source).replace(/\r\n/g, '\n')),
    seal: ledger.seal,
    ledgerStats: ledger.stats,
    density,
    plan,
    chunkCount: plan.steps.filter(s => s.kind === 'absorb').length,
    prep: {
      scope: null,
      map: { clauses: [], modules: [], done: 0, total: plan.steps.filter(s => s.kind === 'map').length, orphan: 0 },
    },
    study: { chunks: {}, coverage: null, effectiveChars: 0, ratio: 0, copyRate: 0, repairs: 0 },
    doubts: [],
    overview: { chapters: {}, frame: null },
    synthesis: null,
    quality: null,
    validation: null,
    review: null,
    quiz: { questions: [], done: 0, total: 0, target: 0, byChapter: {}, plan: {}, saturated: {} },
    exam: { sample: [], answers: [], results: [], round: 0, passRate: null, passed: 0, total: 0, at: '' },
    classNotes: [],
    provenance: null,
    commit: null,
    activity: [],
    errors: [],
    progress: null,
    notes: [],
    updatedAt: new Date().toISOString(),
  }
}

async function loadState(stateRoot, id) {
  const st = await readJson(join(dirOf(stateRoot, id), 'teaching.json'), null)
  if (!st) throw httpError('这间课堂还没开课：先导入原文', 409)
  if (st.schema !== SCHEMA) throw httpError('这间课堂是旧引擎开的课，用旧引擎继续', 409)
  // 断点恢复：进程被杀时留下的「正在跑」要退回待跑，不能永远卡住。
  // 只在状态文件确实陈旧时才恢复——否则页面的一次只读查看会把正在跑的那一步踢回待跑。
  const updatedAt = Date.parse(st.updatedAt || '')
  const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > 10 * 60 * 1000
  let recovered = false
  if (stale) {
    for (const step of st.plan?.steps || []) {
      if (step.status === 'doing') { step.status = 'todo'; recovered = true }
    }
  }
  // 没有正在推进的步骤（progress 为空）时，任何「正在跑」的动作都是残留：
  // 不清理的话，动作流会一直显示"模型在跑"，哪怕这一轮早就结束了。
  const dangling = (st.activity || []).filter(act => act.status === 'running')
  if (!st.progress && dangling.length) {
    for (const act of dangling) {
      act.status = 'fail'
      act.result = '上一次执行被中断，已退回待跑'
      act.doneAt = act.doneAt || new Date().toISOString()
    }
    recovered = true
  }
  if (recovered) {
    st.progress = null
    for (const act of st.activity || []) {
      if (act.status === 'running') { act.status = 'fail'; act.result = '上一次执行被中断，已退回待跑' }
    }
    await saveState(stateRoot, id, st)
  }
  return st
}

async function saveState(stateRoot, id, st) {
  st.updatedAt = new Date().toISOString()
  await atomicWrite(join(dirOf(stateRoot, id), 'teaching.json'), `${JSON.stringify(st, null, 2)}\n`)
}

async function say(stateRoot, id, payload) {
  return appendMessage(stateRoot, id, payload)
}

function pct(a, b) { return b ? Math.round((a / b) * 100) : 0 }

/* --------------------------------------------------------------- 账本 */

async function ensureLedger(stateRoot, id) {
  const dir = dirOf(stateRoot, id)
  const source = await readFile(join(dir, 'source.md'), 'utf8')
  const ledger = await readJson(join(dir, 'ledger.json'), null)
  if (ledger && ledger.seal?.sha256 === seal(source).sha256) return { source, ledger }
  return { source, ledger: null }
}

/** 按计划里的字数预算重算分片（与开课时的分片一致）。 */
function chunksOf(st, ledger) {
  return chunkRanges(ledger, st.plan?.chunkChars || DEFAULTS.chunkChars)
}

/* ------------------------------------------------------------ 渲染 */

export function renderNotes(st, ledger) {
  const chunks = chunksOf(st, ledger)
  const byId = new Map((ledger.segments || []).map(s => [s.id, s]))
  const points = []
  for (const chunk of chunks) {
    const row = st.study.chunks[chunk.index]
    for (const point of row?.points || []) {
      const first = (point.segments || []).map(id => byId.get(id)).filter(Boolean)[0]
      points.push({ ...point, order: first ? first.order : 99999, chunk: chunk.index })
    }
  }
  points.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)))

  const header = [
    '---',
    `title: ${JSON.stringify(`${st.title} · 精读笔记`)}`,
    `source_file: ${JSON.stringify(st.sourceName || 'source.md')}`,
    `source_sha256: ${JSON.stringify(st.sourceHash)}`,
    `source_chars: ${st.sourceChars}`,
    `segments: ${ledger.stats.segments}`,
    `density: ${st.density?.high ? 'high' : 'low'}`,
    `note_chars: ${st.study.effectiveChars || 0}`,
    `note_ratio: ${st.study.ratio || 0}`,
    '---',
    '',
  ]
  const lines = [...header,
    `# ${st.title} · 精读笔记`, '',
    `> 由智能助理学院逐片精读生成：原文 ${st.sourceChars} 字切成 ${ledger.stats.segments} 个片段`
      + `（其中表格行 ${ledger.stats.tableRows}），分 ${chunks.length} 片全部读完。`
      + '每个知识点末尾的 ⟦S####⟧ 是原文片段编号，可逐字回查；引用行之后的解释是自己写的，不计入原文。', '',
    '## 一、覆盖与校验', '',
    `- 片段覆盖：${st.study.coverage?.covered ?? 0}/${st.study.coverage?.total ?? 0}`
      + `${(st.study.coverage?.missing || []).length ? `（缺 ${st.study.coverage.missing.length}）` : '，无遗漏'}`,
    `- 有效笔记字数：${st.study.effectiveChars || 0} 字，为原文的 ${st.study.ratio || 0} 倍`
      + `（引用与逐字复制不计入）`,
    `- 硬指标：原文抽出 ${st.validation?.tokensTotal ?? 0} 个数值/条款号/型号，缺 ${(st.validation?.missingTokens || []).length} 个`,
    `- 疑点：${st.doubts.length} 条，已答 ${st.doubts.filter(d => d.answer).length} 条`,
    '']

  if ((st.validation?.chunks || []).length) {
    lines.push('### 字数账本（逐片）', '')
    lines.push('| 分片 | 章节 | 原文字数 | 笔记字数 | 倍数 | 知识点 | 达标 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const chunk of st.validation.chunks) {
      lines.push(`| 第 ${chunk.index} 片 | ${(chunk.chapters || []).join(' ')} | ${chunk.sourceChars} | ${chunk.noteChars} | ${chunk.ratio}× | ${chunk.points} | ${chunk.pass ? '是' : `否（要求 ≥ ${chunk.target}×）`} |`)
    }
    lines.push('')
  }

  if (st.prep?.scope) {
    const scope = st.prep.scope
    lines.push('## 二、边界与版本', '',
      `- 适用：${(scope.applies_to || []).join('、') || '原文没写'}`,
      `- 版本：${scope.version || '原文没写'}${scope.effective_date ? `（生效 ${scope.effective_date}）` : ''}`,
      scope.mandatory?.length ? '- 强制条款：' : '',
      ...(scope.mandatory || []).map(x => `  - ${x}`),
      '')
  } else {
    lines.push('## 二、边界与版本', '', '原文没写清适用范围与版本，本课只按条款本身理解。', '')
  }

  lines.push('## 三、全文理解（初读框架 → 综合核对）', '')
  if (st.overview?.frame) {
    const frame = st.overview.frame
    lines.push('### 初读框架（先通读整篇得到，之后逐片精读都带着它）', '')
    lines.push(frame.summary || '（没有摘要）', '')
    if (frame.terms.length) {
      lines.push('| 术语 | 原文解释 | 出现章节 |', '| --- | --- | --- |')
      for (const term of frame.terms.slice(0, 20)) {
        lines.push(`| ${String(term.term).replace(/\|/g, '／')} | ${String(term.meaning).replace(/\|/g, '／')} | ${(term.chapters || []).join(' ')} |`)
      }
      lines.push('')
    }
    if (frame.threads.length) {
      lines.push('主线：', ...frame.threads.map(thread => `- **${thread.name}**（${(thread.chapters || []).join('、')}）：${thread.text}`), '')
    }
    if (frame.doubts.length) lines.push('初读疑点：', ...frame.doubts.map(doubt => `- ${doubt}`), '')
  }
  if (st.synthesis) {
    const synthesis = st.synthesis
    lines.push('### 综合核对（拿笔记回头对框架）', '')
    lines.push(synthesis.summary || '（没有摘要）', '')
    if (synthesis.threads.length) {
      lines.push('主线：', ...synthesis.threads.map(thread => `- **${thread.name}**（${(thread.chapters || []).join('、')}；条款 ${(thread.clauses || []).join(' ')}）：${thread.text}`), '')
    }
    if (synthesis.relations.length) {
      lines.push('条款关系：', ...synthesis.relations.map(relation => `- ${relation.from} → ${relation.to}（${relation.type}）：${relation.text}`), '')
    }
    if (synthesis.conflicts.length) {
      lines.push('口径冲突：', ...synthesis.conflicts.map(conflict => `- ${(conflict.clauses || []).join(' ')}：${conflict.text}${conflict.quote ? `（原文：${conflict.quote}）` : ''}`), '')
    }
    if (synthesis.corrections.length) {
      lines.push('初读纠正：', ...synthesis.corrections.map(item => `- 原来以为：${item.was}；笔记说明：${item.now}${item.quote ? `（原文：${item.quote}${item.verified === false ? '｜引用未能逐字核对' : ''}）` : ''}`), '')
    }
    if ((synthesis.droppedConflicts || []).length) {
      lines.push('未计入的冲突（引用对不上原文，已丢弃）：', ...synthesis.droppedConflicts.map(item => `- ${item.text}`), '')
    }
    if (synthesis.gaps.length) {
      lines.push('原文没写清：', ...synthesis.gaps.map(gap => `- ${gap.text}${gap.quote ? `（原文：${gap.quote}）` : ''}`), '')
    }
  }
  if (!st.overview?.frame && !st.synthesis) lines.push('还没有做通读建框架与综合核对。', '')
  lines.push('')

  lines.push('## 四、知识点（按原文顺序）', '')
  for (const point of points) {
    const ids = (point.segments || []).join(' ')
    lines.push(`### ${point.id} ${point.title || '知识点'} ⟦${ids}⟧`, '')
    if (point.quote) lines.push(`> 原文：${point.quote}`, '')
    const fields = [
      ['解释', point.explain], ['适用条件', point.conditions], ['例外与边界', point.exceptions],
      ['判据', point.criteria], ['示例', point.example], ['常见错误', point.misconception],
    ]
    for (const [label, value] of fields) {
      if (String(value || '').trim()) lines.push(`- ${label}：${String(value).trim()}`)
    }
    lines.push('')
  }

  if (st.prep?.map?.clauses?.length) {
    lines.push('## 五、条款清单（老师备课）', '')
    lines.push('| 条款 | 名称 | 适用情形 | 必须做/禁止 | 原文片段 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const clause of st.prep.map.clauses) {
      const cell = text => String(text || '').replace(/\|/g, '／').replace(/\r?\n/g, ' ')
      lines.push(`| ${cell(clause.id)} | ${cell(clause.title)} | ${cell(clause.trigger)} | ${cell(clause.action)} | ${(clause.segments || []).join(' ')} |`)
    }
    lines.push('')
  }

  if (st.doubts.length) {
    lines.push('## 六、疑点与答复', '')
    for (const doubt of st.doubts) {
      lines.push(`- 问：${doubt.q}`, `  答：${doubt.answer || '（未答）'}`)
    }
    lines.push('')
  }

  if ((st.classNotes || []).length) {
    lines.push('## 七、课堂补充与问答', '')
    lines.push('> 课堂上助教的纠正、学员的提问与教授的回答；原文能对上的标 ⟦S####⟧，对不上的标「课外补充」。', '')
    for (const entry of st.classNotes) {
      if (entry.kind === 'qa') {
        lines.push(`- 问：${entry.q}`, `  答：${entry.a}`)
        if ((entry.citations || []).length) lines.push(`  依据：${entry.citations.map(id => `⟦${id}⟧`).join(' ')}`)
      } else {
        lines.push(`- 助教纠正：${entry.text}`)
        if (entry.quote) lines.push(`  原文依据：${entry.quote}`)
        else lines.push('  原文依据：没有对应原句（课外补充，不当作本课规定）')
      }
      lines.push('')
    }
  }

  if (st.validation?.checks?.length) {
    lines.push('## 八、校验与质量审查', '')
    lines.push('| 检查 | 结果 | 说明 |')
    lines.push('| --- | --- | --- |')
    for (const check of st.validation.checks) {
      lines.push(`| ${check.label} | ${check.pass ? '通过' : '未通过'} | ${String(check.detail || '').replace(/\|/g, '／')} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trim()}\n`
}

/**
 * 人员考核试卷：只含题干与答题区，可以直接打印/发给同事做闭卷考试。
 * @param st 课堂状态
 * @returns Markdown 试卷
 */
export function renderExamPaper(st) {
  const questions = st.quiz?.questions || []
  const minutes = Math.max(30, Math.round(questions.length * 2.5))
  const per = questions.length ? (100 / questions.length).toFixed(1) : '0'
  const lines = [
    `# ${st.title} · 人员考核试卷`, '',
    `> 共 ${questions.length} 题；闭卷；建议 ${minutes} 分钟；每题 ${per} 分，总分 100 分。`,
    `> 来源：${st.sourceName || 'source.md'}（封条 ${String(st.sourceHash).slice(0, 16)}…）；版本 ${st.prep?.scope?.version || '未标注'}。`, '',
    '## 答题说明', '',
    '- 只依据本规范作答，不得查阅原文或其他资料。',
    '- 每题先写结论，再写依据（条款编号或原文原句）。',
    '- 题号必须与试卷一致，不得跳题；写错可划掉重写。', '',
    `## 姓名：＿＿＿＿＿＿　岗位：＿＿＿＿＿＿　日期：＿＿＿＿＿＿　得分：＿＿＿＿`, '',
  ]
  questions.forEach((question, index) => {
    lines.push(
      `### 第 ${index + 1} 题（${question.angle}｜${per} 分）`, '',
      question.q, '',
      '答题区：', '', '　', '',
    )
  })
  return `${lines.join('\n').trim()}\n`
}

/**
 * 答案与判分要点：判分关键词逐字来自原文，配合片段编号可回查。
 * @param st 课堂状态
 * @returns Markdown 答案册
 */
export function renderAnswerKey(st) {
  const questions = st.quiz?.questions || []
  const lines = [
    `# ${st.title} · 答案与判分要点（内部用，勿发考生）`, '',
    `> 共 ${questions.length} 题；判分以「判分关键词」是否答到为准，关键词全部逐字来自原文片段。`, '',
    '| 题号 | 条款 | 角度 | 风险 | 判分关键词（原文原句） | 原文片段 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  const cell = text => String(text || '').replace(/\|/g, '／').replace(/\r?\n/g, ' ')
  questions.forEach((question, index) => {
    lines.push(`| ${index + 1} | ${cell(question.clause) || '—'} | ${cell(question.angle)} | ${question.highRisk ? '高' : '中'} | ${cell(question.answer_contains)} | ${(question.segments || []).join(' ')} |`)
  })
  lines.push('', '## 逐题判分要点', '')
  questions.forEach((question, index) => {
    lines.push(`### 第 ${index + 1} 题`, '',
      `- 题干：${question.q}`,
      `- 判分关键词（必须答到）：${question.answer_contains}`,
      question.rubric?.length ? `- 判分要点：${question.rubric.join('；')}` : '',
      `- 原文片段：${(question.segments || []).join(' ') || '—'}`,
      '')
  })
  return `${lines.join('\n').trim()}\n`
}

/* ------------------------------------------------------------ 校验 */

/** 题库正文（含答案与判分要点），等价于答案册；单独导出见 exam-paper.md / answer-key.md。 */
export function renderQuiz(st) {
  return renderAnswerKey(st)
}

function check(label, pass, detail) {
  return { id: label, label, pass: Boolean(pass), detail: String(detail || '') }
}

/** 知识点本身的「不是水话」判据：至少两个实质说明字段，每个不少于 20 字。 */
function substanceOf(point) {
  const fields = ['explain', 'conditions', 'exceptions', 'criteria', 'example', 'misconception']
  const filled = fields.filter(key => countChars(point[key]) >= 20)
  return { filled: filled.length, explain: countChars(point.explain), ok: filled.length >= 2 && countChars(point.explain) >= 40 }
}

function allPoints(st) {
  return Object.values(st.study.chunks || {}).flatMap(row => row.points || [])
}

function median(values) {
  const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return 0
  return list[Math.floor(list.length / 2)]
}

/** 两条笔记「解释」的 3-gram 重合度：用来抓「换个说法的同一句套话」。 */
function explainGrams(point) {
  const text = normalize(String(point.explain || ''))
  const grams = new Set()
  for (let i = 0; i + 3 <= text.length; i++) grams.add(text.slice(i, i + 3))
  return grams
}

function duplicateExplainRate(points) {
  const grams = points.map(explainGrams)
  let pairs = 0
  for (let i = 0; i < grams.length; i++) {
    if (grams[i].size < 8) continue
    for (let j = i + 1; j < grams.length; j++) {
      if (grams[j].size < 8) continue
      let shared = 0
      for (const gram of grams[i]) if (grams[j].has(gram)) shared += 1
      const union = grams[i].size + grams[j].size - shared
      if (union && shared / union > 0.8) { pairs += 1; break }
    }
  }
  return points.length ? pairs / points.length : 0
}

/**
 * 通读第一章：先建局部理解（本章讲什么、术语、与其他章的关系、疑点）。
 * 这一步刻意排在拆条款与逐片精读之前：先有框架，再读细节。
 */
async function runOverviewChapter({ stateRoot, id, st, ledger, chat, step }) {
  const dir = dirOf(stateRoot, id)
  const chapterId = (step.chapters || [])[0]
  const chapter = (ledger.chapters || []).find(item => item.id === chapterId)
  if (!chapter) throw new Error(`找不到章节 ${chapterId}`)
  const segs = (ledger.segments || []).filter(segment => segment.chapter === chapterId && segment.kind !== 'page_marker')
  const text = segs.map(segment => segment.text).join('\n').slice(0, 14000)
  const { data } = await callJson(chat, {
    system: PROMPTS.overviewChapter,
    prompt: `课程：${st.title}\n本章：${chapter.id} ${chapter.title}（${chapter.chars} 字，第 ${(ledger.chapters || []).indexOf(chapter) + 1}/${(ledger.chapters || []).length} 章）\n\n原文：\n${text}`,
    maxTokens: 16000,
  })
  const terms = (data.terms || []).filter(item => item && item.term).slice(0, 16).map(item => ({
    term: String(item.term).slice(0, 40),
    meaning: String(item.meaning || '').slice(0, 200),
  }))
  const relations = (data.relations || []).filter(item => item && item.target).slice(0, 10).map(item => ({
    target: String(item.target).slice(0, 60),
    type: ['depends', 'prerequisite', 'exception'].includes(String(item.type)) ? String(item.type) : 'depends',
    text: String(item.text || '').slice(0, 300),
  }))
  const doubts = (data.doubts || []).map(item => String(item).slice(0, 200)).filter(Boolean).slice(0, 8)
  st.overview = st.overview || { chapters: {}, frame: null }
  st.overview.chapters[chapterId] = {
    digest: String(data.digest || '').slice(0, 600),
    terms,
    relations,
    doubts,
    at: new Date().toISOString(),
  }
  // 通读时的疑点也进答疑队列：通读后先答一轮，别让术语理解错带偏后面的精读
  st.doubts = [...(st.doubts || [])]
  for (const [index, text] of doubts.entries()) {
    const doubtId = `d-ov-${chapterId}-${index + 1}`
    if (st.doubts.some(item => item.id === doubtId)) continue
    st.doubts.push({ id: doubtId, q: text, chapter: chapterId, chunk: null, from: 'overview', answer: '', at: '' })
  }
  await atomicWrite(join(dir, 'overview.json'), `${JSON.stringify(st.overview, null, 2)}\n`)
  await say(stateRoot, id, {
    id: `teach-${id}-v2-overview-${chapterId}`,
    role: 'professor',
    kind: 'teach',
    content: `先通读第 ${chapter.id} 章「${chapter.title}」：${st.overview.chapters[chapterId].digest || '（没有摘要）'}`
      + `\n术语 ${terms.length} 个、跨章关系 ${relations.length} 处、待确认 ${doubts.length} 处。`,
    meta: { step: 'overview-chapter', chapter: chapterId, terms: terms.length, doubts: doubts.length },
  })
  return `第 ${chapter.id} 章：术语 ${terms.length}、关系 ${relations.length}、疑点 ${doubts.length}`
}

/** 把各章速读汇总成全文框架；之后拆条款与精读都带着它。 */
async function runOverviewMerge({ stateRoot, id, st, ledger, chat }) {
  const dir = dirOf(stateRoot, id)
  const chapters = ledger.chapters || []
  const parts = chapters.map(chapter => {
    const row = st.overview?.chapters?.[chapter.id] || {}
    return `【${chapter.id} ${chapter.title}】\n摘要：${row.digest || '（无）'}\n`
      + `术语：${(row.terms || []).map(item => `${item.term}=${item.meaning}`).join('；') || '（无）'}\n`
      + `关系：${(row.relations || []).map(item => `${item.type}→${item.target}`).join('；') || '（无）'}\n`
      + `疑点：${(row.doubts || []).join('；') || '（无）'}`
  }).join('\n\n').slice(0, 16000)
  const { data } = await callJson(chat, {
    system: PROMPTS.overviewMerge,
    prompt: `课程：${st.title}\n原文 ${st.sourceChars} 字，${chapters.length} 章。\n\n各章速读：\n${parts}`,
    maxTokens: 16000,
  })
  const chapterIds = new Set(chapters.map(chapter => chapter.id))
  const frame = {
    at: new Date().toISOString(),
    summary: String(data.summary || '').slice(0, 800),
    terms: (data.terms || []).filter(item => item && item.term).slice(0, 24).map(item => ({
      term: String(item.term).slice(0, 40),
      meaning: String(item.meaning || '').slice(0, 200),
      chapters: (item.chapters || []).map(String).filter(id => chapterIds.has(id)).slice(0, 8),
    })),
    threads: (data.threads || []).filter(item => item && item.name).slice(0, 8).map(item => ({
      name: String(item.name).slice(0, 40),
      text: String(item.text || '').slice(0, 600),
      chapters: (item.chapters || []).map(String).filter(id => chapterIds.has(id)).slice(0, 12),
    })),
    relations: (data.relations || []).filter(item => item && item.from && item.to).slice(0, 24).map(item => ({
      from: String(item.from).slice(0, 40),
      to: String(item.to).slice(0, 40),
      type: ['depends', 'prerequisite', 'exception'].includes(String(item.type)) ? String(item.type) : 'depends',
      text: String(item.text || '').slice(0, 300),
    })),
    doubts: (data.doubts || []).map(item => String(item).slice(0, 200)).filter(Boolean).slice(0, 12),
  }
  st.overview.frame = frame
  await atomicWrite(join(dir, 'overview.json'), `${JSON.stringify(st.overview, null, 2)}\n`)
  const covered = new Set(frame.threads.flatMap(item => item.chapters)).size
  await say(stateRoot, id, {
    id: `teach-${id}-v2-overview-frame`,
    role: 'professor',
    kind: 'teach',
    content: `全文框架建好了（后面拆条款、逐片精读都带着它）：\n${frame.summary}\n`
      + `术语 ${frame.terms.length} 个、主线 ${frame.threads.length} 条（覆盖 ${covered}/${chapters.length} 章）、`
      + `章节关系 ${frame.relations.length} 处、待确认 ${frame.doubts.length} 处。`,
    meta: { step: 'overview-merge', terms: frame.terms.length, threads: frame.threads.length, doubts: frame.doubts.length },
  })
  return `框架：术语 ${frame.terms.length}、主线 ${frame.threads.length}、关系 ${frame.relations.length}`
}

/** 精读时要带上的框架文本（术语、主线、章节关系、本章位置）。 */
function frameText(st, ledger, chapterId) {
  const frame = st.overview?.frame
  if (!frame) return ''
  const chapter = (ledger.chapters || []).find(item => item.id === chapterId)
  const index = (ledger.chapters || []).indexOf(chapter) + 1
  const threads = frame.threads.filter(item => item.chapters.includes(chapterId))
  return [
    '全文框架（通读时得到，精读必须带着它读，不许与它冲突）：',
    `- 主题：${frame.summary}`,
    frame.terms.length ? `- 术语：${frame.terms.slice(0, 12).map(item => `${item.term}=${item.meaning}`).join('；')}` : '',
    threads.length ? `- 本章在主线中的位置：${threads.map(item => `${item.name}：${item.text}`).join('；')}` : '',
    frame.relations.length
      ? `- 已知章节关系：${frame.relations.slice(0, 8).map(item => `${item.type} ${item.from}→${item.to}`).join('；')}`
      : '',
    chapter ? `- 你正在读：第 ${index}/${(ledger.chapters || []).length} 章「${chapter.title}」` : '',
  ].filter(Boolean).join('\n')
}

/**
 * 综合核对：逐片精读之后，拿笔记回头对初读框架。
 * 产出主线、条款关系、冲突、缺口与「初读纠正」；冲突与纠正都必须带原文原句。
 */
async function runReconcile({ stateRoot, id, st, ledger, chat, cfg }) {
  const dir = dirOf(stateRoot, id)
  const clauses = (st.prep.map.clauses || []).filter(clause => !clause.orphan)
  const frame = st.overview?.frame
  const points = allPoints(st).slice(0, 80).map(point => `${point.id}｜${point.title}｜${String(point.explain).slice(0, 80)}`)
  const clauseList = clauses.map(clause => `${clause.id}｜${clause.chapter}｜${clause.title}｜${clause.action}`).join('\n').slice(0, 14000)
  const { data } = await callJson(chat, {
    system: PROMPTS.reconcile,
    prompt: `课程：${st.title}\n原文 ${st.sourceChars} 字，${(ledger.chapters || []).length} 章，${clauses.length} 条条款。\n\n`
      + (frame
        ? `初读框架：\n主题：${frame.summary}\n术语：${frame.terms.map(item => `${item.term}=${item.meaning}`).join('；')}\n`
          + `主线：${frame.threads.map(item => `${item.name}：${item.text}`).join('；')}\n`
          + `章节关系：${frame.relations.map(item => `${item.type} ${item.from}→${item.to}`).join('；')}\n`
          + `初读疑点：${frame.doubts.join('；')}\n\n`
        : '（没有初读框架）\n\n')
      + `条款：\n${clauseList}\n\n笔记要点：\n${points.join('\n').slice(0, 12000)}`,
    maxTokens: 20000,
  })
  const clauseIds = new Set(clauses.map(clause => clause.id))
  const chapterIds = new Set((ledger.chapters || []).map(chapter => chapter.id))
  const clauseById = new Map(clauses.map(clause => [clause.id, clause]))
  const sourceSegs = (ledger.segments || []).map(segment => segment.text)
  const supports = quote => Boolean(String(quote || '').trim()) && quoteSupported(String(quote), sourceSegs)
  const threads = (data.threads || []).filter(thread => thread && thread.name).slice(0, 8).map(thread => {
    const cited = (thread.clauses || []).map(String).filter(id => clauseIds.has(id)).slice(0, 24)
    // 章别不再信模型标注：用主线引用的条款反推它落在哪些章
    const fromClauses = cited.map(id => clauseById.get(id)?.chapter).filter(id => id && chapterIds.has(id))
    const chapters = [...new Set([
      ...(thread.chapters || []).map(String).filter(id => chapterIds.has(id)),
      ...fromClauses,
    ])].slice(0, 12)
    return {
      name: String(thread.name).slice(0, 40),
      text: String(thread.text || '').slice(0, 800),
      chapters,
      clauses: cited,
    }
  })
  // 章覆盖不能指望模型自己标全：缺哪一章，就用通读时那一章的摘要兜一条「章概要」主线，
  // 标明来源是 chapter-digest，既保证覆盖也不假装是模型新写的。
  for (const chapter of (ledger.chapters || [])) {
    if (threads.some(thread => (thread.chapters || []).includes(chapter.id))) continue
    const digest = st.overview?.chapters?.[chapter.id]?.digest
    if (!digest) continue
    threads.push({
      name: `第 ${chapter.id} 章概要`,
      text: String(digest).slice(0, 600),
      chapters: [chapter.id],
      clauses: clauses.filter(clause => clause.chapter === chapter.id).slice(0, 6).map(clause => clause.id),
      source: 'chapter-digest',
    })
  }
  const relations = (data.relations || [])
    .filter(relation => relation && clauseIds.has(String(relation.from)) && clauseIds.has(String(relation.to)))
    .slice(0, 40)
    .map(relation => ({
      from: String(relation.from),
      to: String(relation.to),
      type: ['depends', 'refines', 'conflicts', 'prerequisite'].includes(String(relation.type)) ? String(relation.type) : 'depends',
      text: String(relation.text || '').slice(0, 300),
    }))
  // 冲突：引用逐字核不上时，退到所引条款自带的原文依据；仍核不上就丢弃并记账，不许假装有依据
  const conflicts = []
  const droppedConflicts = []
  for (const item of (data.conflicts || []).filter(raw => raw && (raw.text || raw.quote)).slice(0, 12)) {
    const cited = (item.clauses || []).map(String).filter(id => clauseIds.has(id)).slice(0, 6)
    const quote = String(item.quote || '').slice(0, 400)
    const entry = { clauses: cited, text: String(item.text || '').slice(0, 400), quote }
    if (supports(quote)) { conflicts.push(entry); continue }
    const fallback = cited.map(id => clauseById.get(id)?.source).find(src => supports(src))
    if (fallback) { conflicts.push({ ...entry, quote: fallback, quoteFrom: 'clause' }); continue }
    droppedConflicts.push(entry)
  }
  const gaps = (data.gaps || []).filter(item => item && item.text).slice(0, 12).map(item => ({
    text: String(item.text).slice(0, 400),
    quote: String(item.quote || '').slice(0, 400),
  }))
  // 初读纠正是叙述性的：引用没核上不阻塞，但标出来，复核时能看到
  const corrections = (data.corrections || []).filter(item => item && (item.was || item.now)).slice(0, 12).map(item => {
    const quote = String(item.quote || '').slice(0, 300)
    return {
      was: String(item.was || '').slice(0, 300),
      now: String(item.now || '').slice(0, 300),
      quote,
      verified: supports(quote),
    }
  })
  st.synthesis = {
    at: new Date().toISOString(),
    summary: String(data.summary || '').slice(0, 800),
    threads,
    relations,
    conflicts,
    droppedConflicts,
    gaps,
    corrections,
  }
  await atomicWrite(join(dir, 'synthesis.json'), `${JSON.stringify(st.synthesis, null, 2)}\n`)
  const chapterCovered = new Set(threads.flatMap(thread => thread.chapters)).size
  await say(stateRoot, id, {
    id: `teach-${id}-v2-reconcile`,
    role: 'professor',
    kind: 'teach',
    content: `综合核对完成（拿笔记回头对初读框架）：\n${st.synthesis.summary}\n`
      + `跨章主线 ${threads.length} 条（覆盖 ${chapterCovered}/${(ledger.chapters || []).length} 章）、`
      + `条款关系 ${relations.length} 处、口径冲突 ${conflicts.length} 条`
      + `${droppedConflicts.length ? `（另丢弃 ${droppedConflicts.length} 条无原文依据的冲突）` : ''}、`
      + `初读纠正 ${corrections.length} 处、原文没写清 ${gaps.length} 处。`,
    meta: {
      step: 'reconcile', threads: threads.length, relations: relations.length,
      conflicts: conflicts.length, corrections: corrections.length, gaps: gaps.length,
    },
  })
  return `主线 ${threads.length} 条、冲突 ${conflicts.length} 条、初读纠正 ${corrections.length} 处`
}

/**
 * 八项确定性校验 + 笔记质量审查。scope='chunk' 时只看这一片（精读步骤自己的验收），
 * scope='all' 时看整堂课（validate 步的总闸）。
 */
export function validateState(st, ledger, { scope = 'all', chunkIndex = null } = {}) {
  const chunks = chunksOf(st, ledger)
  const points = scope === 'chunk'
    ? (st.study.chunks[chunkIndex]?.points || [])
    : allPoints(st)
  const segIds = scope === 'chunk'
    ? new Set(chunks.find(c => c.index === chunkIndex)?.segIds || [])
    : new Set((ledger.segments || []).map(s => s.id))
  const scopedLedger = scope === 'chunk'
    ? { ...ledger, segments: ledger.segments.filter(s => segIds.has(s.id)) }
    : ledger
  const scopedSource = (ledger.segments || []).filter(s => segIds.has(s.id)).map(s => s.text).join('\n')

  const coverage = coverageOf(scopedLedger, points)
  const tokens = tokensOf(scopedLedger)
  // 硬指标核对看的是「整份笔记」：引用行里的原句也算（那是笔记的一部分），
  // 否则抄了原文反而查不到数值，模型只会被逼着重写一遍数字。
  const notesText = points.map(p => [p.title, p.quote, p.explain, p.conditions, p.exceptions, p.criteria, p.example, p.misconception].join('\n')).join('\n')
  const missing = missingTokens(tokens, notesText)
  const copy = copyStats(points.map(p => p.explain || '').join('\n'), scopedSource)
  const ownChars = points.reduce((n, p) => n
    + countChars(p.explain) + countChars(p.conditions) + countChars(p.exceptions)
    + countChars(p.criteria) + countChars(p.example) + countChars(p.misconception), 0)
  const srcChars = (scopedLedger.segments || []).filter(s => s.substantive && s.kind !== 'heading')
    .reduce((n, s) => n + s.chars, 0) || 1
  const ratio = ratioOf(ownChars, srcChars)
  const target = st.density?.high ? DEFAULTS.noteRatioTarget : 0
  const weak = points.filter(p => !substanceOf(p).ok)
  const tableRows = (scopedLedger.segments || []).filter(s => s.kind === 'table_row' && s.substantive)
  const coveredSet = new Set(points.flatMap(p => p.segments || []))
  const missedTables = tableRows.filter(s => !coveredSet.has(s.id))

  const checks = [
    check('原文封条', true, `${ledger.seal.chars} 字 · ${ledger.seal.segments ?? ledger.stats?.segments ?? ''} 片段`),
    check('片段覆盖', coverage.missing.length === 0, `覆盖 ${coverage.covered}/${coverage.total}`),
    check('引用可溯源', coverage.badCitations.length === 0, `${coverage.badCitations.length} 条对不上`),
    check('硬指标齐全', missing.length === 0, missing.length ? `缺 ${missing.slice(0, 8).map(t => t.value).join('、')}` : `${tokens.length} 个全部命中`),
    check('表格行', missedTables.length === 0, missedTables.length ? `缺 ${missedTables.length} 行` : `${tableRows.length} 行全部覆盖`),
    check('笔记字数', !target || ratio >= target, `有效 ${ownChars} 字 / 原文 ${srcChars} 字 = ${ratio} 倍${target ? `（要求 ≥ ${target}）` : '（低密度不设比例门）'}`),
    check('说明充分', weak.length === 0, weak.length ? `${weak.length} 条只有复述没有解释` : '每条都有解释与条件'),
    // 质量审查：字数够不等于理解了，下面这四项专门抓「水话」与「没读通」
    check('复述比例', copy.copyRate <= 0.2,
      `照抄 ${Math.round(copy.copyRate * 100)}%（上限 20%）`),
    check('解释深度', median(points.map(p => countChars(p.explain))) >= 60,
      `解释字数中位数 ${median(points.map(p => countChars(p.explain)))}（下限 60）`),
    check('套话重复', duplicateExplainRate(points) <= 0.04,
      `重复解释占比 ${Math.round(duplicateExplainRate(points) * 100)}%（上限 4%）`),
  ]
  if (scope === 'all') {
    const synthesis = st.synthesis || null
    const frame = st.overview?.frame || null
    const chapterIds = (ledger.chapters || []).map(chapter => chapter.id)
    const frameChapters = new Set((frame?.threads || []).flatMap(thread => thread.chapters || []))
    const frameMissing = chapterIds.filter(id => !frameChapters.has(id))
    const threaded = new Set((synthesis?.threads || []).flatMap(thread => thread.chapters || []))
    const missingChapters = chapterIds.filter(id => !threaded.has(id))
    const sourceSegs = (ledger.segments || []).map(segment => segment.text)
    // 冲突必须有逐字依据（runReconcile 已用条款自带原文兜底、兜不住就丢弃，不进这里）
    const badConflicts = (synthesis?.conflicts || []).filter(item => {
      const quote = String(item.quote || '').trim()
      return !quote || !quoteSupported(quote, sourceSegs)
    })
    // 初读纠正是叙述性的：引用没核上不阻塞，但如实统计，复核时能看到
    const unverifiedCorrections = (synthesis?.corrections || []).filter(item => {
      const quote = String(item.quote || '').trim()
      return !quote || !quoteSupported(quote, sourceSegs)
    })
    const ok = Boolean(frame) && frameMissing.length === 0 && Boolean(synthesis)
      && missingChapters.length === 0 && badConflicts.length === 0
    checks.push(check('全局理解', ok,
      !frame ? '还没有通读建框架这一步'
        : `${(synthesis?.threads || []).length} 条主线覆盖 ${threaded.size}/${chapterIds.length} 章；`
          + `冲突 ${(synthesis?.conflicts || []).length} 条（无依据 ${badConflicts.length}）；`
          + `初读纠正 ${(synthesis?.corrections || []).length} 处（引用未核上 ${unverifiedCorrections.length}，不阻塞）`
          + ((synthesis?.droppedConflicts || []).length ? `；丢弃无依据冲突 ${synthesis.droppedConflicts.length} 条` : '')
          + (frameMissing.length ? `；初读框架漏了 ${frameMissing.join('、')}` : '')))
  }
  const pass = checks.every(c => c.pass)
  return {
    scope,
    chunkIndex,
    pass,
    checks,
    coverage,
    missingTokens: missing.map(t => t.value),
    tokensTotal: tokens.length,
    badCitations: coverage.badCitations,
    missedTables: missedTables.map(s => s.id),
    ownChars,
    srcChars,
    ratio,
    copyRate: Number(copy.copyRate.toFixed(3)),
    weak: weak.map(p => p.id),
  }
}

function validationReport(checks) {
  return checks.map(c => `- ${c.pass ? '✓' : '✗'} ${c.label}：${c.detail}`).join('\n')
}

/* ------------------------------------------------------------ 步骤实现 */

async function runScope({ stateRoot, id, st, chat, cfg }) {
  const dir = dirOf(stateRoot, id)
  const source = await readFile(join(dir, 'source.md'), 'utf8')
  const head = source.slice(0, 20000)
  const tail = source.length > 22000 ? source.slice(-2000) : ''
  const { data } = await callJson(chat, {
    system: PROMPTS.scope,
    prompt: `课程标题：${st.title}\n\n课件原文（开头${tail ? '与结尾' : ''}）：\n${head}${tail ? `\n……（中间省略，只用于摘边界）……\n${tail}` : ''}`,
    maxTokens: 12000,
  })
  const terms = (data.terms || []).filter(t => t && t.term).slice(0, 20)
    .map(t => ({ term: String(t.term).slice(0, 40), meaning: String(t.meaning || '').slice(0, 160) }))
  st.prep.scope = {
    applies_to: (data.applies_to || []).map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 10),
    version: String(data.version || '').slice(0, 40),
    effective_date: String(data.effective_date || '').slice(0, 40),
    supersedes: String(data.supersedes || '').slice(0, 60),
    mandatory: (Array.isArray(data.mandatory) ? data.mandatory : (data.mandatory ? [data.mandatory] : []))
      .map(x => String(x).slice(0, 220)).filter(Boolean).slice(0, 12),
    recommended: (data.recommended || []).map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 8),
    terms,
    origin: 'model',
    at: new Date().toISOString(),
  }
  await atomicWrite(join(dir, 'scope.json'), `${JSON.stringify(st.prep.scope, null, 2)}\n`)
  const scope = st.prep.scope
  await say(stateRoot, id, {
    id: `teach-${id}-v2-scope`,
    role: 'professor',
    kind: 'teach',
    content: `先把边界定清楚：适用 ${scope.applies_to.join('、') || '原文没写'}；`
      + `版本 ${scope.version || '原文没写'}；强制条款 ${scope.mandatory.length} 条。`
      + (scope.mandatory.length ? `\n${scope.mandatory.slice(0, 6).map((x, i) => `${i + 1}. ${x}`).join('\n')}` : ''),
    meta: { step: 'scope', mandatory: scope.mandatory.length },
  })
  return `适用 ${scope.applies_to.length} 项 · 版本 ${scope.version || '未写'} · 强制条款 ${scope.mandatory.length} 条`
}

async function runMap({ stateRoot, id, st, ledger, chat, step }) {
  const dir = dirOf(stateRoot, id)
  const chapters = new Set(step.chapters || [])
  const segments = (ledger.segments || []).filter(s => chapters.has(s.chapter) && s.kind !== 'page_marker')
  const text = segments.map(s => `⟦${s.id}⟧ ${s.text}`).join('\n')
  const { data } = await callJson(chat, {
    system: PROMPTS.map,
    prompt: `课程：${st.title}\n章节：${(ledger.chapters || []).filter(c => chapters.has(c.id)).map(c => c.title).join('、')}\n\n`
      + `片段共 ${segments.length} 个（其中表格行 ${segments.filter(segment => segment.kind === 'table_row').length} 行），`
      + '同一张表的行合并成一条条款即可，不要逐行拆。\n\n'
      + `片段：\n${text}`,
    maxTokens: 24000,
  })
  let clauses = (data.clauses || []).filter(x => x && x.title).slice(0, 200).map((x, i) => ({
    id: String(x.id || `K${i + 1}`).slice(0, 16),
    // 章节优先按条款引用的片段所属章来定：模型给的章号经常整段都写成第一章
    chapter: (() => {
      const given = String(x.chapter || '')
      if ((ledger.chapters || []).some(chapter => chapter.id === given)) return given
      const first = (Array.isArray(x.segments) ? x.segments : []).map(String)
        .map(segmentId => (ledger.segments || []).find(segment => segment.id === segmentId))
        .find(Boolean)
      return first?.chapter || (step.chapters || [])[0] || 'C01'
    })(),
    title: String(x.title).slice(0, 80),
    type: String(x.type || 'rule').slice(0, 12),
    trigger: String(x.trigger || '').slice(0, 160),
    action: String(x.action || '').slice(0, 240),
    role: String(x.role || '').slice(0, 80),
    params: String(x.params || '').slice(0, 160),
    exception: String(x.exception || '').slice(0, 200),
    criteria: String(x.criteria || '').slice(0, 160),
    source: String(x.source || '').slice(0, 400),
    segments: (Array.isArray(x.segments) ? x.segments : []).map(String).slice(0, 6),
  }))
  const byId = new Map(segments.map(s => [s.id, s]))
  const orphan = clause => {
    const segs = (clause.segments || []).map(sid => byId.get(sid)).filter(Boolean)
    return !segs.length || !quoteSupported(clause.source, segs.map(s => s.text))
  }
  const bad = clauses.filter(orphan)
  if (bad.length) {
    // 只修对不上的几条，一次机会；还不行就标成孤儿，不进题库但如实记账
    try {
      const { data: fix } = await callJson(chat, {
        system: PROMPTS.mapFix,
        prompt: `课程：${st.title}\n\n有问题的条款：\n${JSON.stringify(bad.map(c => ({ ...c, segments: c.segments })))}\n\n`
          + `这些片段可用：\n${segments.map(s => `⟦${s.id}⟧ ${s.text}`).join('\n').slice(0, 12000)}`,
        maxTokens: 8000,
      })
      const fixed = new Map((fix.clauses || []).filter(c => c && c.title).map(c => [String(c.id), c]))
      clauses = clauses.map(c => (fixed.has(c.id) ? { ...c, ...fixed.get(c.id), segments: (fixed.get(c.id).segments || c.segments || []).map(String) } : c))
    } catch { /* 修不了就按孤儿记账 */ }
  }
  const finalOrphans = clauses.filter(orphan)
  for (const clause of clauses) clause.orphan = orphan(clause)

  st.prep.map.clauses.push(...clauses.filter(c => !c.orphan))
  st.prep.map.orphan += finalOrphans.length
  const modules = (data.modules || []).filter(m => m && m.title).slice(0, 10)
    .map((m, i) => ({ id: String(m.id || `M${i + 1}`), title: String(m.title).slice(0, 60) }))
  for (const module of modules) {
    if (!st.prep.map.modules.some(m => m.id === module.id)) st.prep.map.modules.push(module)
  }
  st.prep.map.done += 1
  await atomicWrite(join(dir, 'knowledge-map.json'), `${JSON.stringify({
    modules: st.prep.map.modules,
    clauses: st.prep.map.clauses,
    orphan: st.prep.map.orphan,
  }, null, 2)}\n`)
  const chaptersLabel = (step.chapters || []).join('、')
  await say(stateRoot, id, {
    id: `teach-${id}-v2-map-${step.id}`,
    role: 'professor',
    kind: 'teach',
    content: `${chaptersLabel} 拆出 ${clauses.length} 条条款` + (finalOrphans.length ? `，其中 ${finalOrphans.length} 条原文依据对不上片段，已标出、不进题库。` : '，每条都能回到原文片段。'),
    meta: { step: 'map', clauses: clauses.length, orphans: finalOrphans.length, unit: step.id },
  })
  return `${clauses.length} 条条款（孤儿 ${finalOrphans.length}）`
}

function chunkStep(st, chunkIndex) {
  const entry = Object.entries(st.chunkIndexByStep || {}).find(([, value]) => value === chunkIndex)
  return entry ? stepById(st.plan, entry[0]) : null
}

/** 分片与计划步骤的映射是派生的：每次读状态后重算，回退与插话都靠它定位。 */
function attachChunkIndex(st, ledger) {
  const chunks = chunksOf(st, ledger)
  st.chunkIndexByStep = {}
  for (const item of st.plan.steps.filter(step => step.kind === 'absorb')) {
    const index = chunks.findIndex(c => c.from === item.range?.[0] && c.to === item.range?.[1])
    if (index >= 0) st.chunkIndexByStep[item.id] = chunks[index].index
  }
  return chunks
}

function absorbPromptFor(st, ledger, chunk, ratio) {
  const i = chunk.index
  const n = chunksOf(st, ledger).length
  return PROMPTS.absorb
    .replace('{i}', String(i))
    .replace('{n}', String(n))
    .replace('{ratio}', String(ratio))
}

async function runAbsorb({ stateRoot, id, st, ledger, chat, step, chunk }) {
  const dir = dirOf(stateRoot, id)
  const target = st.density?.high ? DEFAULTS.noteRatioTarget : 0
  const basePrompt = absorbPromptFor(st, ledger, chunk, target || 1)
  // 精读带着先通读得到的框架走：没有框架，逐片理解容易在术语口径上跑偏
  const chunkChapters = [...new Set((chunk.segIds || [])
    .map(segmentId => (ledger.segments || []).find(segment => segment.id === segmentId)?.chapter)
    .filter(Boolean))]
  const frame = chunkChapters.map(chapterId => frameText(st, ledger, chapterId)).filter(Boolean).join('\n\n').slice(0, 3000)
  const segsById = new Map((ledger.segments || []).map(s => [s.id, s]))
  let points = st.study.chunks[chunk.index]?.points || []
  let doubts = st.study.chunks[chunk.index]?.doubts || []
  let last = ''
  const attempts = Math.max(1, Number(step.repairWithin) || 1) + 1
  for (let round = 0; round < attempts; round++) {
    const isFix = round > 0
    let prompt
    if (!isFix) {
      prompt = `课程：${st.title}\n\n${frame}\n\n${basePrompt}\n\n原文片段：\n${chunk.text}`
      if (step.focus) prompt += `\n\n助教特别提醒（必须一并吸收）：${step.focus}`
    } else {
      const checkNow = validateState(st, ledger, { scope: 'chunk', chunkIndex: chunk.index })
      const missingText = checkNow.coverage.missingDetail
        .map(x => `⟦${x.id}⟧ ${segsById.get(x.id)?.text || ''}`).join('\n').slice(0, 8000)
      prompt = `课程：${st.title}\n\n${PROMPTS.absorbFix}\n\n本片原文：\n${chunk.text}\n\n`
        + `没过的检查：\n${validationReport(checkNow.checks)}\n\n`
        + (missingText ? `这些片段还没有对应的知识点：\n${missingText}\n\n` : '')
        + (checkNow.missingTokens.length ? `笔记里还缺这些硬指标：${checkNow.missingTokens.slice(0, 20).join('、')}\n\n` : '')
        + `目前已经写好的知识点（不要重复）：\n${JSON.stringify(points.map(p => ({ id: p.id, title: p.title, segments: p.segments }))).slice(0, 4000)}`
        + (step.focus ? `\n\n助教特别提醒：${step.focus}` : '')
    }
    let data
    try {
      ({ data } = await callJson(chat, { system: isFix ? PROMPTS.absorbFix : basePrompt, prompt, maxTokens: 20000 }))
    } catch (error) {
      last = String(error?.message || error)
      continue
    }
    const incoming = (data.points || []).filter(p => p && (p.title || p.quote || p.explain)).map((p, i) => ({
      id: String(p.id || `P${chunk.index}-${points.length + i + 1}`).slice(0, 24),
      segments: (Array.isArray(p.segments) ? p.segments : []).map(String).slice(0, 12),
      quote: String(p.quote || '').slice(0, 600),
      title: String(p.title || '').slice(0, 90),
      explain: String(p.explain || '').slice(0, 1600),
      conditions: String(p.conditions || '').slice(0, 800),
      exceptions: String(p.exceptions || '').slice(0, 800),
      criteria: String(p.criteria || '').slice(0, 800),
      example: String(p.example || '').slice(0, 800),
      misconception: String(p.misconception || '').slice(0, 600),
    }))
    doubts = [...new Set([...doubts, ...(data.doubts || []).map(x => String(x).slice(0, 300)).filter(Boolean)])].slice(0, 12)
    if (!isFix) points = incoming
    else {
      // 修订：同一 id 覆盖，新 id 追加，去重按片段集合
      const map = new Map(points.map(p => [p.id, p]))
      for (const p of incoming) {
        const same = points.find(x => JSON.stringify(x.segments) === JSON.stringify(p.segments) && x.title === p.title)
        if (same) map.set(same.id, { ...same, ...p, id: same.id })
        else map.set(p.id, p)
      }
      points = [...map.values()]
    }
    st.study.chunks[chunk.index] = { ...(st.study.chunks[chunk.index] || {}), points, doubts }
    await atomicWrite(join(dir, 'task_state', 'notes', `c${String(chunk.index).padStart(2, '0')}.json`), `${JSON.stringify({ chunk: chunk.index, points, doubts }, null, 2)}\n`)
    const checkNow = validateState(st, ledger, { scope: 'chunk', chunkIndex: chunk.index })
    if (checkNow.pass) break
    last = validationReport(checkNow.checks.filter(c => !c.pass))
  }
  const row = st.study.chunks[chunk.index] || (st.study.chunks[chunk.index] = { points: [], doubts: [] })
  const checkNow = validateState(st, ledger, { scope: 'chunk', chunkIndex: chunk.index })
  const own = row.points.reduce((n, p) => n
    + countChars(p.explain) + countChars(p.conditions) + countChars(p.exceptions)
    + countChars(p.criteria) + countChars(p.example) + countChars(p.misconception), 0)
  row.chars = chunk.chars
  row.effective = own
  row.ratio = ratioOf(own, checkNow.srcChars)
  row.pass = checkNow.pass
  row.error = checkNow.pass ? '' : last
  return { check: checkNow, text: checkNow.pass ? `第 ${chunk.index} 片 ${row.points.length} 条知识点、${own} 字` : `第 ${chunk.index} 片没过：${last}` }
}

async function runValidate({ stateRoot, id, st, ledger, chat, cfg }) {
  const dir = dirOf(stateRoot, id)
  const all = validateState(st, ledger, { scope: 'all' })
  // 字数账本：逐片列出「原文多少字 / 笔记多少字 / 几倍」，局部缩水一眼可见
  const segById = new Map((ledger.segments || []).map(segment => [segment.id, segment]))
  const chunkLedger = chunksOf(st, ledger).map(chunk => {
    const row = st.study.chunks[chunk.index] || { points: [] }
    const points = row.points || []
    const own = points.reduce((sum, point) => sum + countChars(point.explain) + countChars(point.conditions)
      + countChars(point.exceptions) + countChars(point.criteria) + countChars(point.example)
      + countChars(point.misconception), 0)
    const src = chunk.segIds
      .map(segmentId => segById.get(segmentId))
      .filter(segment => segment && segment.substantive && segment.kind !== 'heading')
      .reduce((sum, segment) => sum + segment.chars, 0)
    return {
      index: chunk.index,
      chapters: [...new Set(chunk.segIds.map(segmentId => segById.get(segmentId)?.chapter).filter(Boolean))],
      sourceChars: src,
      noteChars: own,
      ratio: ratioOf(own, src),
      points: points.length,
      target: st.density?.high ? DEFAULTS.noteRatioTarget : 0,
      pass: !st.density?.high || ratioOf(own, src) >= DEFAULTS.noteRatioTarget,
    }
  })
  st.validation = {
    at: new Date().toISOString(),
    round: (st.validation?.round || 0) + 1,
    pass: all.pass,
    checks: all.checks,
    tokensTotal: all.tokensTotal,
    missingTokens: all.missingTokens,
    missingSegments: all.coverage.missingDetail,
    badCitations: all.badCitations.map(x => ({ id: x.id, reason: x.reason })),
    ownChars: all.ownChars,
    srcChars: all.srcChars,
    ratio: all.ratio,
    copyRate: all.copyRate,
    chunks: chunkLedger,
  }
  await atomicWrite(join(dir, 'validation.json'), `${JSON.stringify(st.validation, null, 2)}\n`)
  // 覆盖率与字数比是全局口径，回填到 study
  st.study.coverage = { covered: all.coverage.covered, total: all.coverage.total, missing: all.coverage.missing }
  st.study.effectiveChars = all.ownChars
  st.study.ratio = all.ratio
  st.study.copyRate = all.copyRate

  const chunks = chunksOf(st, ledger)
  if (!all.pass) {
    // 定位到失败的分片：只回退这几片，不整本重来
    const missing = new Set(all.coverage.missing)
    const failedChunks = chunks.filter(chunk => chunk.substantiveIds.some(sid => missing.has(sid)))
      .map(chunk => chunk.index)
    const weakest = Object.entries(st.study.chunks)
      .filter(([, row]) => row && row.points)
      .sort((a, b) => (a[1].ratio || 0) - (b[1].ratio || 0))
      .slice(0, 3).map(([index]) => Number(index))
    const needRatio = all.ratio < (st.density?.high ? DEFAULTS.noteRatioTarget : 0)
    const qualityFail = all.checks.some(item => ['复述比例', '解释深度', '套话重复'].includes(item.id) && !item.pass)
    const targets = [...new Set([...failedChunks, ...(needRatio || qualityFail ? weakest : [])])]
    // 全局理解没过：框架缺章就重做汇总，核对缺依据/漏章就重做综合核对
    const globalFail = all.checks.find(item => item.id === '全局理解' && !item.pass)
    if (globalFail) {
      const frameStep = st.plan.steps.find(item => item.kind === 'overview-merge')
      const reconcileStep = st.plan.steps.find(item => item.kind === 'reconcile')
      if (!st.overview?.frame && frameStep) requeue(st.plan, frameStep.id, `初读框架缺失：${globalFail.detail}`)
      else if (reconcileStep) requeue(st.plan, reconcileStep.id, `综合核对没过：${globalFail.detail}`)
    }
    // 覆盖/字数/质量没过才退回精读；只是理解层的问题就只重做理解
    for (const index of targets) {
      const step = st.plan.steps.find(s => s.kind === 'absorb' && st.chunkIndexByStep?.[s.id] === index)
      if (!step) continue
      requeue(st.plan, step.id, validationReport(all.checks.filter(c => !c.pass)))
      step.repairWithin = 1
    }
    st.study.repairs = (st.study.repairs || 0) + 1
    st.errors.push({ at: new Date().toISOString(), scope: 'validate', message: `第 ${st.validation.round} 轮校验没过：${all.checks.filter(c => !c.pass).map(c => c.label).join('、')}` })
    await say(stateRoot, id, {
      id: `teach-${id}-v2-validate-${st.validation.round}`,
      role: 'professor',
      kind: 'teach',
      content: `自动校验第 ${st.validation.round} 轮没过，我不往下走，退回重拆这几片：${targets.join('、') || '（未定位到具体分片）'}。\n`
        + validationReport(all.checks.filter(c => !c.pass)),
      meta: { step: 'validate', pass: false, round: st.validation.round, targets },
    })
    return { ok: false, text: `校验没过，回退 ${targets.length} 片`, needUser: false }
  }

  st.errors = []
  await say(stateRoot, id, {
    id: `teach-${id}-v2-validate-ok`,
    role: 'professor',
    kind: 'teach',
    content: `自动校验通过：\n${validationReport(all.checks)}\n`
      + `下一关是人工复核：你看过定稿笔记点头之后，我才会出题、绑定溯源、写进知识库。`,
    meta: { step: 'validate', pass: true, round: st.validation.round },
  })
  return { ok: true, text: `覆盖 ${all.coverage.covered}/${all.coverage.total} · ${all.ratio} 倍` }
}

async function runClarify({ stateRoot, id, st, ledger, chat, step }) {
  const dir = dirOf(stateRoot, id)
  const pending = st.doubts.filter(d => !d.answer)
  if (!pending.length) return { ok: true, text: '没有待答疑点' }
  const doubt = pending[0]
  const chunk = chunksOf(st, ledger).find(c => c.index === doubt.chunk)
  // 通读阶段的疑点还没有分片：用该章原文回答
  const chapterText = doubt.chapter
    ? (ledger.segments || []).filter(segment => segment.chapter === doubt.chapter && segment.kind !== 'page_marker')
      .map(segment => segment.text).join('\n')
    : ''
  let answer = ''
  try {
    answer = await callText(chat, {
      system: PROMPTS.clarify,
      prompt: `课程：${st.title}\n\n只依据这段原文：\n${String(chunk?.text || chapterText).slice(0, 9000)}\n\n学员问题：${doubt.q}`,
      maxTokens: 8000,
    })
  } catch (error) {
    answer = '原文这段没法确认，等助教复核。'
    st.errors.push({ at: new Date().toISOString(), scope: 'clarify', message: String(error?.message || error) })
  }
  doubt.answer = answer.slice(0, 1500)
  doubt.at = new Date().toISOString()
  await say(stateRoot, id, {
    id: `teach-${id}-v2-clarify-${st.doubts.indexOf(doubt) + 1}`,
    role: 'professor',
    kind: 'teach',
    content: `学员问：${doubt.q}\n我先答：${doubt.answer}`,
    meta: { step: 'clarify', index: st.doubts.indexOf(doubt) + 1 },
  })
  const left = st.doubts.filter(d => !d.answer).length
  if (left) return { ok: true, text: `答完 1 个疑点，还剩 ${left + 1} 个`, partial: true }
  return { ok: true, text: `${st.doubts.length} 个疑点全部答完` }
}

/**
 * 题库按原文密度出：约每 100 字一题，按章节分摊；题库不全部考，只用于抽考。
 * 每批只做一个章节的缺口，避免一次调用产出几十道题后大半作废。
 */
async function runQuiz({ stateRoot, id, st, ledger, chat, step, cfg }) {
  const dir = dirOf(stateRoot, id)
  const clauses = (st.prep.map.clauses || []).filter(clause => !clause.orphan)
  const chapters = ledger.chapters || []
  const target = Math.min(240, Math.max(8, Math.round((st.sourceChars || 0) / 100)))
  st.quiz.target = target
  st.quiz.byChapter = st.quiz.byChapter || {}
  // 每章的目标题量：按字数分摊，并整体缩放到「约每 100 字一题」的总量
  if (!st.quiz.plan || Object.keys(st.quiz.plan).length !== chapters.length) {
    const raw = chapters.map(chapter => Math.max(1, Math.round((chapter.chars || 0) / 100)))
    const rawSum = raw.reduce((sum, value) => sum + value, 0) || 1
    const scale = target > rawSum ? target / rawSum : 1
    st.quiz.plan = {}
    chapters.forEach((chapter, index) => {
      st.quiz.plan[chapter.id] = Math.max(1, Math.round(raw[index] * scale))
    })
  }
  const needOf = chapter => st.quiz.plan[chapter.id] || 1
  const haveOf = chapterId => (st.quiz.questions || []).filter(question => question.chapter === chapterId).length
  const pending = chapters
    .filter(chapter => !(st.quiz.saturated || {})[chapter.id])
    .map(chapter => ({ chapter, need: needOf(chapter) - haveOf(chapter.id) }))
    .filter(item => item.need > 0)
    .sort((a, b) => b.need - a.need)
  if (!pending.length) return { ok: true, text: `题库 ${st.quiz.questions.length} 题（目标 ${target} 题）` }

  const { chapter, need } = pending[0]
  const count = Math.max(1, Math.min(Number(cfg.quizBatch) || DEFAULTS.quizBatch, need))
  const segs = (ledger.segments || []).filter(segment => segment.chapter === chapter.id
    && segment.substantive && segment.kind !== 'page_marker')
  const segText = segs.map(segment => `⟦${segment.id}⟧ ${segment.text}`).join('\n').slice(0, 14000)
  const chapterClauses = clauses.filter(clause => clause.chapter === chapter.id)
  const clauseText = chapterClauses.map(clause => `${clause.id}｜${clause.title}｜${clause.action}`).join('\n').slice(0, 8000)
  const asked = (st.quiz.questions || []).map(question => question.q).slice(-30)
  const system = PROMPTS.quizDense
    .replace(/\{chars\}/g, String(st.sourceChars || 0))
    .replace(/\{need\}/g, String(target))
    .replace(/\{chapter\}/g, `${chapter.id} ${chapter.title}`)
    .replace(/\{count\}/g, String(count))
  const { data } = await callJson(chat, {
    system,
    prompt: `课程：${st.title}\n章节：${chapter.id} ${chapter.title}（${chapter.chars} 字）\n\n`
      + `本批要 ${count} 道题，题面必须落在这段原文里。\n\n条款：\n${clauseText || '（本章没有单独条款，按原文片段出题）'}\n\n`
      + (asked.length ? `已经出过的题（不要重复）：\n${asked.map(text => `- ${text.slice(0, 80)}`).join('\n')}\n\n` : '')
      + `原文片段：\n${segText}`,
    maxTokens: 16000,
  })
  const segAll = new Map((ledger.segments || []).map(segment => [segment.id, segment]))
  const seen = new Set((st.quiz.questions || []).map(question => normalize(question.q)))
  const incoming = []
  for (const raw of (data.questions || [])) {
    if (!raw || !String(raw.q || '').trim()) continue
    if (normalize(raw.q).length < 6 || seen.has(normalize(raw.q))) continue
    let segments = (Array.isArray(raw.segments) ? raw.segments : []).map(String)
      .filter(id => segAll.get(id)?.chapter === chapter.id).slice(0, 6)
    if (!segments.length) segments = segs.slice(0, 2).map(segment => segment.id)
    const segs = segments.map(id => segAll.get(id)).filter(Boolean)
    let answer = String(raw.answer_contains || '').slice(0, 400)
    if (!quoteSupported(answer, segs.map(segment => segment.text))) {
      answer = String(segs[0]?.text || '').slice(0, 200)
    }
    if (!answer.trim()) continue
    seen.add(normalize(raw.q))
    incoming.push({
      id: `Q${st.quiz.questions.length + incoming.length + 1}`,
      clause: String(raw.clause || ''),
      chapter: chapter.id,
      angle: ANGLE_SET.has(String(raw.angle)) ? String(raw.angle) : '判定边界',
      q: String(raw.q).slice(0, 400),
      answer_contains: answer,
      segments,
      rubric: (raw.rubric || []).map(item => String(item).slice(0, 120)).slice(0, 5),
      recall: isRecallQuestion(String(raw.q)),
      highRisk: /\d/.test(answer) || ['判定边界', '数据口径'].includes(String(raw.angle)),
    })
    if (incoming.length >= count * 2) break
  }
  if (!incoming.length) {
    // 模型这批没给出新题（多半是重复）：把该章标成已饱和，别在同一批上空转
    st.quiz.saturated = st.quiz.saturated || {}
    st.quiz.saturated[chapter.id] = true
    return { ok: true, text: `第 ${chapter.id} 章这批没出新题，标为已饱和（题库 ${st.quiz.questions.length} 题）` }
  }
  st.quiz.questions.push(...incoming)
  st.quiz.byChapter[chapter.id] = haveOf(chapter.id)
  st.quiz.done = st.quiz.questions.length
  st.quiz.total = target
  await atomicWrite(join(dir, 'quiz.json'), `${JSON.stringify({
    target, questions: st.quiz.questions,
  }, null, 2)}\n`)
  await atomicWrite(join(dir, 'quiz.md'), renderQuiz(st))
  // 题库同时产出「人员考核试卷」与「答案册」，后面可以直接拿来考人
  await atomicWrite(join(dir, 'exam-paper.md'), renderExamPaper(st))
  await atomicWrite(join(dir, 'answer-key.md'), renderAnswerKey(st))
  return {
    ok: true,
    text: `第 ${chapter.id} 章出 ${incoming.length} 题，题库 ${st.quiz.questions.length}/${target}（约每 100 字一题）`,
  }
}

/** 抽考：按章节分层抽样，闭卷（只给笔记）作答，交判卷；整轮不过就退回复习。 */
async function runExam({ stateRoot, id, st, ledger, chat, cfg }) {
  const dir = dirOf(stateRoot, id)
  const bank = st.quiz.questions || []
  if (!bank.length) throw new Error('题库是空的，没法抽考')

  if (!st.exam.sample.length) {
    // 默认抽题库的 15% 左右（下限 4 题、上限 examSample），按章节分层、高风险至少三分之一
    const percent = Number(cfg.examPercent)
    const cap = Math.max(1, Number(cfg.examSample) || 30)
    const min = Math.max(1, Number(cfg.examSampleMin) || 4)
    const target = Number.isFinite(percent) && percent > 0
      ? Math.max(min, Math.min(cap, Math.round(bank.length * percent)))
      : Math.min(cap, bank.length)
    const byChapter = new Map()
    for (const question of bank) {
      const key = question.chapter || 'C01'
      if (!byChapter.has(key)) byChapter.set(key, [])
      byChapter.get(key).push(question)
    }
    const sampled = []
    const share = target / bank.length
    for (const [chapterId, list] of byChapter) {
      const take = Math.max(1, Math.round(list.length * share))
      sampled.push(...list.slice(0, take))
    }
    // 高风险题（带数字/判定边界）至少占三分之一
    const highRisk = bank.filter(question => question.highRisk)
    const minHigh = Math.ceil(target / 3)
    for (const question of highRisk) {
      if (sampled.filter(item => item.highRisk).length >= minHigh) break
      if (!sampled.some(item => item.id === question.id)) sampled.push(question)
    }
    const picked = sampled.slice(0, Math.max(target, minHigh))
    // 打散顺序，避免按章节挨着考
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[picked[i], picked[j]] = [picked[j], picked[i]]
    }
    st.exam = {
      sample: picked.map(question => question.id),
      answers: [],
      results: [],
      round: (st.exam.round || 0) + 1,
      passRate: null,
      passed: 0,
      total: picked.length,
      at: new Date().toISOString(),
    }
    await say(stateRoot, id, {
      id: `teach-${id}-v2-exam-${st.exam.round}`,
      role: 'professor',
      kind: 'teach',
      content: `题库 ${bank.length} 题（约每 100 字一题），这轮抽考 ${picked.length} 题（约 ${Math.round((Number(cfg.examPercent) || 0.15) * 100)}%）：`
        + `按章节分层抽，高风险题（数值/判定边界）至少占三分之一。\n`
        + '闭卷：学员只能看自己的笔记逐题作答，答完我一次性对照原文判卷。',
      meta: { step: 'exam-start', round: st.exam.round, sample: picked.length, bank: bank.length },
    })
  }

  const answers = st.exam.answers || (st.exam.answers = [])
  const pending = st.exam.sample.find(questionId => !answers.some(answer => answer.id === questionId))
  if (pending) {
    const question = bank.find(item => item.id === pending)
    if (!question) throw new Error(`抽考题目 ${pending} 不在题库里`)
    const segAll = new Map((ledger.segments || []).map(segment => [segment.id, segment]))
    const segs = (question.segments || []).map(segmentId => segAll.get(segmentId)).filter(Boolean)
    const noteText = notesForSegments(st, question.segments)
    const answered = await callJson(chat, {
      system: PROMPTS.answerClosed,
      prompt: `课程：${st.title}\n\n你的笔记（只能看这个）：\n${noteText}\n\n题目：${question.q}`,
      maxTokens: 4000,
    })
    const answer = [answered.data.conclusion, answered.data.basis, answered.data.unsure]
      .filter(Boolean).map(item => String(item).slice(0, 500)).join('\n')
    const required = quantityOf(question.answer_contains)
    const missingDigits = required.filter(quantity => !normalize(stripCitations(answer)).includes(normalize(quantity)))
    answers.push({
      id: question.id,
      q: question.q,
      answer,
      segments: question.segments,
      chapter: question.chapter,
      missingDigits,
      at: new Date().toISOString(),
    })
    await atomicWrite(join(dir, 'exam.json'), `${JSON.stringify(st.exam, null, 2)}\n`)
    await say(stateRoot, id, {
      id: `teach-${id}-v2-exam-a-${st.exam.round}-${answers.length}`,
      role: 'student',
      kind: 'answer',
      content: `第 ${answers.length}/${st.exam.sample.length} 题（闭卷，只看笔记）：\n${answer}`.slice(0, 3000),
      meta: { step: 'exam-answer', round: st.exam.round, no: answers.length },
    })
    return { ok: true, text: `第 ${answers.length}/${st.exam.sample.length} 题已作答` }
  }

  // 全部答完：一次性批量判卷（每题独立作答、判卷合并成一次调用）
  if (!st.exam.results.length) {
    const blocks = answers.map((entry, index) => {
      const segAll = new Map((ledger.segments || []).map(segment => [segment.id, segment]))
      const segs = (entry.segments || []).map(segmentId => segAll.get(segmentId)).filter(Boolean)
      const question = bank.find(item => item.id === entry.id) || {}
      return `【${entry.id}】第 ${index + 1} 题\n题干：${entry.q}\n判分关键词（原文原句）：${question.answer_contains || ''}\n`
        + `原文片段：\n${segs.map(segment => `⟦${segment.id}⟧ ${segment.text}`).join('\n').slice(0, 6000)}\n`
        + `学员闭卷作答：\n${entry.answer}`
    }).join('\n\n---\n\n')
    const graded = await callJson(chat, {
      system: PROMPTS.gradeBatch,
      prompt: `课程：${st.title}\n共 ${answers.length} 题：\n\n${blocks}`,
      maxTokens: 16000,
    })
    const byId = new Map((graded.data.results || []).map(item => [String(item.id), item]))
    st.exam.results = answers.map(entry => {
      const raw = byId.get(entry.id) || {}
      let score = Math.max(0, Math.min(100, Number(raw.score)))
      if (!Number.isFinite(score)) score = 0
      if (entry.missingDigits.length) score = Math.min(score, 55)
      const passed = score >= 70 && Boolean(raw.passed ?? score >= 70) && entry.missingDigits.length === 0
      return {
        id: entry.id,
        q: entry.q,
        answer: entry.answer,
        score,
        passed,
        comment: String(raw.comment || '').slice(0, 300),
        gap: String(raw.gap || '').slice(0, 240),
        correct: String(raw.correct || '').slice(0, 600),
        segments: entry.segments,
        chapter: entry.chapter,
        missingDigits: entry.missingDigits,
      }
    })
    const gradedCount = st.exam.results.length
    const passedCount = st.exam.results.filter(result => result.passed).length
    await atomicWrite(join(dir, 'exam.json'), `${JSON.stringify(st.exam, null, 2)}\n`)
    await say(stateRoot, id, {
      id: `teach-${id}-v2-exam-grade-${st.exam.round}`,
      role: 'professor',
      kind: 'teach',
      content: `批量判卷完成：${passedCount}/${gradedCount} 题过关。\n`
        + st.exam.results.map((result, index) => `- 第 ${index + 1} 题：${result.score} 分 ${result.passed ? '✓' : `✗ ${result.gap || result.comment}`}`).join('\n'),
      meta: { step: 'exam-grade-all', round: st.exam.round, passed: passedCount, total: gradedCount },
    })
    return { ok: true, text: `批量判卷 ${passedCount}/${gradedCount}` }
  }

  // 一轮考完：算通过率，决定过、退回补学，还是停住等人工
  const total = st.exam.results.length
  const passed = st.exam.results.filter(result => result.passed).length
  const rate = total ? passed / total : 0
  st.exam.passRate = Number(rate.toFixed(3))
  st.exam.passed = passed
  st.exam.total = total
  const threshold = Number(cfg.passThreshold) || 0.75
  await atomicWrite(join(dir, 'exam.json'), `${JSON.stringify(st.exam, null, 2)}\n`)
  if (rate >= threshold) {
    await say(stateRoot, id, {
      id: `teach-${id}-v2-exam-pass-${st.exam.round}`,
      role: 'professor',
      kind: 'teach',
      content: `抽考通过：${passed}/${total} 题过关（${Math.round(rate * 100)}%，线 ${Math.round(threshold * 100)}%）。\n`
        + '接下来请你复核定稿笔记与题库；你点头之后才绑定溯源、写进知识库与长期记忆。',
      meta: { step: 'exam-pass', round: st.exam.round, rate: st.exam.passRate },
    })
    return { ok: true, text: `抽考 ${passed}/${total} 通过` }
  }

  const failed = st.exam.results.filter(result => !result.passed)
  if (st.exam.round >= 3) {
    await say(stateRoot, id, {
      id: `teach-${id}-v2-exam-blocked`,
      role: 'professor',
      kind: 'teach',
      content: `抽考 ${st.exam.round} 轮都没过（${passed}/${total}）：我不强行往下走，停下来等你决定。\n`
        + failed.slice(0, 5).map(result => `- ${result.q.slice(0, 60)}：${result.gap || result.comment}`).join('\n'),
      meta: { step: 'exam-blocked', round: st.exam.round, rate: st.exam.passRate },
    })
    throw new Error(`抽考 ${st.exam.round} 轮未通过（${passed}/${total}），停在人工处理`)
  }
  // 退回：只重学错题涉及的分片，然后重新校验、补题、再抽
  const failedSegments = new Set(failed.flatMap(result => result.segments || []))
  const chunks = chunksOf(st, ledger)
  const chunkIndexes = chunks
    .filter(chunk => chunk.segIds.some(segmentId => failedSegments.has(segmentId)))
    .map(chunk => chunk.index)
  for (const index of chunkIndexes) {
    const step = chunkStep(st, index)
    if (!step) continue
    requeue(st.plan, step.id, `抽考没过：${failed.map(result => result.q.slice(0, 40)).join('；')}`.slice(0, 400))
    step.repairWithin = 1
  }
  for (const item of st.plan.steps) {
    if (['reconcile', 'validate', 'quiz', 'exam', 'review', 'bind', 'commit'].includes(item.kind)) item.status = 'todo'
  }
  st.exam.sample = []
  st.exam.results = []
  st.quiz.questions = st.quiz.questions.filter(question => !failed.some(result => result.id === question.id))
  st.stage = 'study'
  await say(stateRoot, id, {
    id: `teach-${id}-v2-exam-fail-${st.exam.round}`,
    role: 'professor',
    kind: 'teach',
    content: `抽考没过（${passed}/${total}，线 ${Math.round(threshold * 100)}%），我退回去重学错题涉及的 ${chunkIndexes.length} 个分片，`
      + '补完重新校验、补题、再抽一轮；题库与笔记都在，不用从头来。',
    meta: { step: 'exam-fail', round: st.exam.round, rate: st.exam.passRate, chunks: chunkIndexes.length },
  })
  return { ok: false, text: `抽考 ${passed}/${total}，退回 ${chunkIndexes.length} 片` }
}

/** 闭卷作答时只给「与这些片段相关的笔记」，不给原文。 */
function notesForSegments(st, segments) {
  const wanted = new Set(segments || [])
  const points = Object.values(st.study.chunks || {}).flatMap(row => row.points || [])
    .filter(point => (point.segments || []).some(segmentId => wanted.has(segmentId)))
  if (!points.length) return '（这条对应的笔记没有写到，按没学到处理）'
  return points.slice(0, 12).map(point => [
    `### ${point.id} ${point.title}`,
    point.explain ? `解释：${point.explain}` : '',
    point.conditions ? `适用条件：${point.conditions}` : '',
    point.exceptions ? `例外：${point.exceptions}` : '',
    point.criteria ? `判据：${point.criteria}` : '',
    point.example ? `示例：${point.example}` : '',
  ].filter(Boolean).join('\n')).join('\n\n').slice(0, 8000)
}

async function runBind({ stateRoot, id, st, ledger }) {
  const dir = dirOf(stateRoot, id)
  const notesText = renderNotes(st, ledger)
  const bySegment = {}
  const byNote = {}
  const byQuestion = {}
  const allPoints = Object.values(st.study.chunks || {}).flatMap(row => row.points || [])
  for (const point of allPoints) {
    byNote[point.id] = point.segments || []
    for (const sid of point.segments || []) {
      const row = bySegment[sid] || (bySegment[sid] = { notes: [], questions: [] })
      row.notes.push(point.id)
    }
  }
  for (const question of st.quiz.questions) {
    byQuestion[question.id] = question.segments || []
    for (const sid of question.segments || []) {
      const row = bySegment[sid] || (bySegment[sid] = { notes: [], questions: [] })
      row.questions.push(question.id)
    }
  }
  const bad = st.quiz.questions.filter(question => {
    const segs = (question.segments || []).map(segmentId => ledger.segments.find(segment => segment.id === segmentId))
      .filter(Boolean)
    return !segs.length || !quoteSupported(question.answer_contains, segs.map(segment => segment.text))
  })
  const chaptersWithQuestion = new Set(st.quiz.questions.map(question => question.chapter))
  const chaptersMissing = (ledger.chapters || []).filter(chapter => !chaptersWithQuestion.has(chapter.id))
  const target = st.quiz.target || 0
  const bankShort = target > 0 && st.quiz.questions.length < Math.ceil(target * 0.8)
  const provenance = {
    at: new Date().toISOString(),
    source: { file: st.sourceName || 'source.md', sha256: st.sourceHash, chars: st.sourceChars, segments: ledger.stats.segments },
    notes: { file: 'notes-final.md', sha256: sha256(notesText), chars: st.study.effectiveChars, ratio: st.study.ratio },
    quiz: {
      file: 'quiz.json',
      questions: st.quiz.questions.length,
      target,
      chapters: (ledger.chapters || []).length,
      chaptersMissing: chaptersMissing.map(chapter => chapter.id),
      badQuestions: bad.map(question => question.id),
      exam: { sampled: st.exam.total, passed: st.exam.passed, passRate: st.exam.passRate, round: st.exam.round },
    },
    bySegment,
    byNote,
    byQuestion,
  }
  st.provenance = provenance
  await atomicWrite(join(dir, 'notes-final.md'), notesText)
  await atomicWrite(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  // 题库同时落试卷与答案册（人员考核用），随定稿一起走
  await atomicWrite(join(dir, 'quiz.md'), renderQuiz(st))
  await atomicWrite(join(dir, 'exam-paper.md'), renderExamPaper(st))
  await atomicWrite(join(dir, 'answer-key.md'), renderAnswerKey(st))
  st.notes = [notesText]
  const ok = bad.length === 0 && chaptersMissing.length === 0 && !bankShort
  return {
    ok,
    text: `覆盖 ${Object.keys(bySegment).length} 个片段；题库 ${st.quiz.questions.length}/${target} 题；`
      + `引用对不上的题 ${bad.length}；缺题章节 ${chaptersMissing.length}`,
    notesText,
  }
}

async function runCommit({ stateRoot, id, st, ledger, deps, cfg }) {
  const dir = dirOf(stateRoot, id)
  const notesText = await readFile(join(dir, 'notes-final.md'), 'utf8')
  const quizText = renderQuiz(st)
  await atomicWrite(join(dir, 'quiz.md'), quizText)
  const commit = await (deps?.commit || commitLearning)({
    cfg,
    stateRoot,
    classroomId: id,
    state: st,
    ledger,
    notesText,
    quiz: st.quiz.questions,
    provenance: st.provenance,
    quizText,
    examPaper: renderExamPaper(st),
    answerKey: renderAnswerKey(st),
  })
  st.commit = commit
  await atomicWrite(join(dir, 'commit.json'), `${JSON.stringify(commit, null, 2)}\n`)
  return { ok: true, text: commit.summary }
}

/* ------------------------------------------------------------ 推进 */

async function markProgress(stateRoot, id, st, key, label, extra = {}) {
  const at = new Date().toISOString()
  st.activity = [...(st.activity || []), {
    id: `${key}-${Date.parse(at).toString(36)}`,
    key, label, at, status: 'running', ...extra,
  }].slice(-40)
  st.progress = { key, label, at }
  await saveState(stateRoot, id, st)
}

async function finishProgress(stateRoot, id, st, result, ok = true) {
  const list = st.activity || []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].status !== 'running') continue
    const act = list[i]
    act.status = ok ? 'done' : 'fail'
    act.result = String(result || '').slice(0, 300)
    act.doneAt = new Date().toISOString()
    act.ms = Math.max(0, Date.parse(act.doneAt) - Date.parse(act.at))
    st.progress = null
    return act
  }
  return null
}

/**
 * 推进一步。每次只跑计划里下一步（精读可并发几片），落盘后返回。
 * 没有可跑的步骤、或计划被锁死时返回 needUser。
 *
 * 同一间课堂的推进串行化：两个标签页或一次误触不会并行改同一份状态。
 *
 * @param stateRoot 状态根
 * @param options { id, chat, cfg, deps }
 */
export async function advance(stateRoot, options = {}) {
  const id = safeId(options.id)
  return withLock(`write:${stateRoot}:${id}`, () => advanceUnlocked(stateRoot, { ...options, id }))
}

async function advanceUnlocked(stateRoot, options = {}) {
  const id = safeId(options.id)
  const cfg = { ...DEFAULTS, ...(options.cfg || {}) }
  const chat = options.chat
  const st = await loadState(stateRoot, id)
  const dir = dirOf(stateRoot, id)
  if (st.plan?.blocked) {
    return { state: await describeState(stateRoot, id, cfg), needUser: true, blocked: st.plan.blocked, note: '学习停在未通过的校验上，等你处理' }
  }
  if (st.stage === 'finished') {
    return { state: await describeState(stateRoot, id, cfg), needUser: true, note: '已入库' }
  }
  if (st.stage === 'review') {
    return { state: await describeState(stateRoot, id, cfg), needUser: true, note: '等你复核定稿笔记' }
  }
  if (st.stage === 'ready') {
    st.stage = 'prep'
    await saveState(stateRoot, id, st)
  }

  const { source, ledger: cached } = await ensureLedger(stateRoot, id)
  let ledger = cached
  if (!ledger) {
    ledger = buildLedger(source)
    await atomicWrite(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  }
  // 分片与步骤的映射：只算一次，回退时按分片找步骤
  const chunks = attachChunkIndex(st, ledger)

  const step = nextStep(st.plan)
  if (!step) {
    if (st.stage !== 'finished') {
      st.stage = 'finished'
      await saveState(stateRoot, id, st)
    }
    return { state: await describeState(stateRoot, id, cfg), needUser: true, note: '计划已全部完成' }
  }

  markStep(st.plan, step.id, { status: 'doing' })
  await saveState(stateRoot, id, st)
  let result
  try {
    if (step.kind === 'scope') {
      await markProgress(stateRoot, id, st, 'scope', STEP_LABEL.scope, { tag: '调用模型' })
      result = { ok: true, text: await runScope({ stateRoot, id, st, chat, cfg }) }
      markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false }
    }
    if (step.kind === 'map') {
      await markProgress(stateRoot, id, st, 'map', STEP_LABEL.map, { tag: '调用模型', detail: (step.chapters || []).join('、') })
      result = { ok: true, text: await runMap({ stateRoot, id, st, ledger, chat, step }) }
      markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false }
    }
    if (step.kind === 'read') {
      // 本地步骤：只登记「这一段原文确实进了流水线」，把能连续读的分片一次跑完。
      // 当前步已经被标成 doing，所以它要自己回到这一批里，否则会空转。
      const batch = [step, ...nextBatch(st.plan, 'read', 19).filter(s => s.id !== step.id)]
      let drained = 0
      for (const readStep of batch) {
        const index = chunks.find(c => c.from === readStep.range?.[0] && c.to === readStep.range?.[1])?.index
        await atomicWrite(join(dir, 'task_state', 'read', `c${String(index).padStart(2, '0')}.json`), `${JSON.stringify({
          chunk: index,
          range: readStep.range,
          segIds: readStep.segIds,
          chars: readStep.chars,
          at: new Date().toISOString(),
        }, null, 2)}\n`)
        markStep(st.plan, readStep.id, { status: 'done' })
        drained += 1
      }
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false, note: `登记 ${drained} 个分片的读取回执` }
    }
    if (step.kind === 'absorb') {
      const limit = Math.max(1, Number(cfg.concurrentChunks) || 1)
      const batch = [step, ...nextBatch(st.plan, 'absorb', limit - 1).filter(s => s.id !== step.id)]
      const jobs = batch.map(async absorbStep => {
        const index = st.chunkIndexByStep[absorbStep.id]
        const chunk = chunks.find(c => c.index === index)
        if (!chunk) {
          markStep(st.plan, absorbStep.id, { status: 'todo', lastError: '分片定位失败' })
          return `第 ${index} 片定位失败`
        }
        markStep(st.plan, absorbStep.id, { status: 'doing' })
        await markProgress(stateRoot, id, st, 'absorb', `精读第 ${index}/${chunks.length} 片`, {
          tag: '调用模型',
          detail: `${chunk.chars} 字 · ${chunk.substantiveIds.length} 个实质片段`,
        })
        let out
        try {
          out = await runAbsorb({ stateRoot, id, st, ledger, chat, step: absorbStep, chunk })
        } catch (error) {
          out = { check: { pass: false, checks: [check('模型', false, String(error?.message || error))] }, text: `第 ${index} 片失败：${String(error?.message || error)}` }
          st.errors.push({ at: new Date().toISOString(), scope: 'absorb', chunk: index, message: String(error?.message || error).slice(0, 200) })
        }
        if (out.check.pass) {
          markStep(st.plan, absorbStep.id, { status: 'done', lastError: '' })
          await finishProgress(stateRoot, id, st, out.text, true)
          await say(stateRoot, id, {
            id: `teach-${id}-v2-chunk-${index}-${(absorbStep.attempts || 0) + 1}`,
            role: 'student',
            kind: 'answer',
            sectionRef: (ledger.chapters || []).find(c => c.id === ledger.segments.find(s => s.id === chunk.segIds[0])?.chapter)?.title || `第 ${index} 片`,
            content: `第 ${index}/${chunks.length} 片读完了：${out.text}。`
              + `${st.study.chunks[index].points.slice(0, 3).map(p => `\n- ${p.title}：${String(p.explain).slice(0, 60)}`).join('')}`,
            meta: { step: 'absorb', chunk: index, points: st.study.chunks[index].points.length },
          })
        } else {
          // 本片没过：退回这一片，累计尝试次数；超限由 plan.requeue 判失败
          requeue(st.plan, absorbStep.id, out.text)
          absorbStep.repairWithin = 1
          await finishProgress(stateRoot, id, st, out.text, false)
          await say(stateRoot, id, {
            id: `teach-${id}-v2-chunk-fail-${index}-${(absorbStep.attempts || 0) + 1}-${Date.now()}`,
            role: 'professor',
            kind: 'teach',
            content: `第 ${index} 片没过，我不往下走，退回重拆。${String(out.text || '').slice(0, 300)}`,
            meta: { step: 'absorb-fail', chunk: index },
          })
        }
        return out.text
      })
      const results = await Promise.all(jobs)
      await saveState(stateRoot, id, st)
      return {
        state: await describeState(stateRoot, id, cfg),
        needUser: false,
        blocked: st.plan.blocked || null,
        note: results.join('；'),
      }
    }
    if (step.kind === 'overview-chapter') {
      await markProgress(stateRoot, id, st, 'overview', STEP_LABEL['overview-chapter'], {
        tag: '调用模型', detail: `第 ${(step.chapters || []).join('、')} 章`,
      })
      result = { ok: true, text: await runOverviewChapter({ stateRoot, id, st, ledger, chat, step }) }
      markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false }
    }
    if (step.kind === 'overview-merge') {
      await markProgress(stateRoot, id, st, 'overview-merge', STEP_LABEL['overview-merge'], { tag: '调用模型' })
      result = { ok: true, text: await runOverviewMerge({ stateRoot, id, st, ledger, chat }) }
      markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false }
    }
    if (step.kind === 'reconcile') {
      await markProgress(stateRoot, id, st, 'reconcile', STEP_LABEL.reconcile, { tag: '调用模型' })
      result = { ok: true, text: await runReconcile({ stateRoot, id, st, ledger, chat, cfg }) }
      markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false }
    }
    if (step.kind === 'validate') {
      await markProgress(stateRoot, id, st, 'validate', STEP_LABEL.validate, { tag: '核对' })
      result = await runValidate({ stateRoot, id, st, ledger, chat, cfg })
      if (result.ok) markStep(st.plan, step.id, { status: 'done' })
      else requeue(st.plan, step.id, result.text)
      await finishProgress(stateRoot, id, st, result.text, result.ok)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false, blocked: st.plan.blocked || null, note: result.text }
    }
    if (step.kind === 'clarify') {
      await markProgress(stateRoot, id, st, 'clarify', '回答学员疑点', { tag: '调用模型' })
      result = await runClarify({ stateRoot, id, st, ledger, chat, step })
      if (!result.partial) markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, result.ok)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false, note: result.text }
    }
    if (step.kind === 'review') {
      const notesText = renderNotes(st, ledger)
      await atomicWrite(join(dir, 'notes-final.md'), notesText)
      const noteHash = sha256(notesText)
      st.review = {
        at: new Date().toISOString(),
        noteHash,
        approved: false,
        comment: '',
        report: {
          coverage: st.study.coverage,
          ratio: st.study.ratio,
          effectiveChars: st.study.effectiveChars,
          tokensTotal: st.validation?.tokensTotal || 0,
          missingTokens: st.validation?.missingTokens || [],
          clauses: (st.prep.map.clauses || []).filter(c => !c.orphan).length,
          orphans: st.prep.map.orphan || 0,
          doubts: st.doubts.length,
          checks: st.validation?.checks || [],
          synthesis: st.synthesis
            ? {
              summary: st.synthesis.summary,
              threads: st.synthesis.threads.length,
              relations: st.synthesis.relations.length,
              conflicts: st.synthesis.conflicts.length,
              corrections: st.synthesis.corrections.length,
              gaps: st.synthesis.gaps.length,
            }
            : null,
          overview: st.overview?.frame
            ? {
              summary: st.overview.frame.summary,
              terms: st.overview.frame.terms.length,
              threads: st.overview.frame.threads.length,
              doubts: st.overview.frame.doubts.length,
            }
            : null,
          exam: {
            bank: (st.quiz.questions || []).length,
            target: st.quiz.target,
            sampled: st.exam.total,
            passed: st.exam.passed,
            passRate: st.exam.passRate,
            round: st.exam.round,
            failed: (st.exam.results || []).filter(item => !item.passed).map(item => ({
              q: item.q.slice(0, 120), gap: item.gap, score: item.score,
            })),
          },
          classNotes: (st.classNotes || []).length,
          said: st.saidStats || null,
          chunks: st.validation?.chunks || [],
        },
      }
      markStep(st.plan, step.id, { status: 'done' })
      st.stage = 'review'
      await saveState(stateRoot, id, st)
      const report = st.review.report
      await say(stateRoot, id, {
        id: `teach-${id}-v2-review-${st.validation?.round || 1}`,
        role: 'professor',
        kind: 'teach',
        content: '学完、考完，定稿笔记在这里，请你做最后一遍复核。你批的是「这份理解对不对」，不是「文件传没传上去」：\n'
          + `- 片段覆盖 ${report.coverage?.covered ?? 0}/${report.coverage?.total ?? 0}；有效笔记 ${report.effectiveChars} 字（原文 ${report.ratio} 倍，引用不计）\n`
          + `- 全局理解：主线 ${report.synthesis?.threads ?? 0} 条、条款关系 ${report.synthesis?.relations ?? 0} 处、`
          + `口径冲突 ${report.synthesis?.conflicts ?? 0} 条、原文没写清 ${report.synthesis?.gaps ?? 0} 处\n`
          + `- 质量审查：${(report.checks || []).filter(item => item.pass).length}/${(report.checks || []).length} 项通过`
          + `（复述比例、解释深度、套话重复、全局理解都在其中）\n`
          + `- 题库 ${report.exam.bank} 题（目标 ${report.exam.target}，约每 100 字一题）；`
          + `抽考 ${report.exam.sampled} 题，过 ${report.exam.passed} 题（${Math.round((report.exam.passRate || 0) * 100)}%）\n`
          + `- 课堂补充 ${report.classNotes} 条（课堂问答与助教纠正也在笔记里）\n`
          + (report.said
            ? `- 课堂对话：闲聊 ${report.said.chat || 0} 条、提问 ${report.said.question || 0} 条、记入知识 ${report.said.knowledge || 0} 条\n`
            : '')
          + (report.chunks?.length
            ? `- 字数账本（逐片）：${report.chunks.map(item => `第 ${item.index} 片 ${item.noteChars}/${item.sourceChars} 字 = ${item.ratio} 倍`).join('；')}\n`
            : '')
          + '通过后我才绑定溯源、写进知识库与长期记忆；不通过就告诉我第几条该怎么改，我退回重拆。',
        meta: { step: 'review', report: { coverage: report.coverage, ratio: report.ratio, exam: report.exam, synthesis: report.synthesis } },
      })
      return { state: await describeState(stateRoot, id, cfg), needUser: true, note: '等你复核定稿笔记' }
    }
    if (step.kind === 'quiz') {
      await markProgress(stateRoot, id, st, 'quiz', STEP_LABEL.quiz, { tag: '调用模型' })
      result = await runQuiz({ stateRoot, id, st, ledger, chat, step, cfg })
      // 题库按原文密度出，每个章节都补齐了才算这一步完成
      const chapters = (ledger.chapters || []).filter(chapter => {
        if ((st.quiz.saturated || {})[chapter.id]) return false
        const need = st.quiz.plan?.[chapter.id] || 1
        const have = (st.quiz.questions || []).filter(question => question.chapter === chapter.id).length
        return have < need
      })
      if (!chapters.length) markStep(st.plan, step.id, { status: 'done' })
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false, note: result.text }
    }
    if (step.kind === 'exam') {
      await markProgress(stateRoot, id, st, 'exam', STEP_LABEL.exam, { tag: '调用模型' })
      result = await runExam({ stateRoot, id, st, ledger, chat, cfg })
      if (result.ok && st.exam.passRate != null && st.exam.passRate >= (Number(cfg.passThreshold) || 0.75)) {
        markStep(st.plan, step.id, { status: 'done' })
      } else if (!result.ok) {
        // 没过：步骤重新排队，下一轮再抽；次数由 plan 上限兜底
        requeue(st.plan, step.id, result.text)
      }
      await finishProgress(stateRoot, id, st, result.text, result.ok)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false, blocked: st.plan.blocked || null, note: result.text }
    }
    if (step.kind === 'bind') {
      await markProgress(stateRoot, id, st, 'bind', STEP_LABEL.bind, { tag: '核对' })
      result = await runBind({ stateRoot, id, st, ledger })
      if (result.ok) markStep(st.plan, step.id, { status: 'done' })
      else {
        // 绑定不通过：题目引用或章覆盖有问题，退回补题再重绑一次
        requeue(st.plan, step.id, result.text)
        const quizStep = st.plan.steps.find(item => item.kind === 'quiz')
        if (quizStep) requeue(st.plan, quizStep.id, result.text)
      }
      await finishProgress(stateRoot, id, st, result.text, result.ok)
      await saveState(stateRoot, id, st)
      return { state: await describeState(stateRoot, id, cfg), needUser: false, blocked: st.plan.blocked || null, note: result.text }
    }
    if (step.kind === 'commit') {
      await markProgress(stateRoot, id, st, 'commit', STEP_LABEL.commit, { tag: '写入' })
      result = await runCommit({ stateRoot, id, st, ledger, deps: options.deps, cfg })
      markStep(st.plan, step.id, { status: 'done' })
      st.stage = 'finished'
      await finishProgress(stateRoot, id, st, result.text, true)
      await saveState(stateRoot, id, st)
      await say(stateRoot, id, {
        id: `teach-${id}-v2-commit`,
        role: 'system',
        kind: 'system',
        content: `结课入库：${result.text}`,
        meta: { step: 'commit' },
      })
      return { state: await describeState(stateRoot, id, cfg), needUser: true, note: result.text }
    }
    throw new Error(`未知的计划步骤：${step.kind}`)
  } catch (error) {
    const message = String(error?.message || error)
    // 单次模型抖动不等于这一步学不会：计一次尝试退回重跑，超过上限才整堂停住
    requeue(st.plan, step.id, message)
    st.errors.push({ at: new Date().toISOString(), scope: step.kind, message: message.slice(0, 300) })
    await finishProgress(stateRoot, id, st, message, false)
    await saveState(stateRoot, id, st)
    throw error
  } finally {
    // 一次推进结束时，这一步要么已完成、要么已重排：不能留在「正在跑」，
    // 否则下一次推进找不到可跑的步骤（尤其是题库/答疑这类要跨多次推进的步骤）
    const current = stepById(st.plan, step.id)
    if (current && current.status === 'doing') {
      current.status = 'todo'
      await saveState(stateRoot, id, st)
    }
  }
}

/* ------------------------------------------------------------ 人工侧 */

/**
 * 人工复核：只有通过（或带意见退回）两种结果，绝不自动通过。
 * 通过时锁定当前笔记哈希；之后笔记再变，这次通过作废。
 */
export async function reviewDecision(stateRoot, options = {}) {
  const id = safeId(options.id)
  return withLock(`write:${stateRoot}:${id}`, () => reviewUnlocked(stateRoot, { ...options, id }))
}

async function reviewUnlocked(stateRoot, options = {}) {
  const id = safeId(options.id)
  const cfg = { ...DEFAULTS, ...(options.cfg || {}) }
  const st = await loadState(stateRoot, id)
  if (st.stage !== 'review') throw httpError(`现在不在复核阶段（当前：${STAGE_LABELS(st.stage)}）`, 409)
  const dir = dirOf(stateRoot, id)
  const { source, ledger: cached } = await ensureLedger(stateRoot, id)
  const ledger = cached || buildLedger(source)
  if (!cached) await atomicWrite(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  attachChunkIndex(st, ledger)
  const notesText = renderNotes(st, ledger)
  const noteHash = sha256(notesText)
  const comment = String(options.comment || '').trim().slice(0, 2000)

  if (options.approve) {
    if (st.review?.noteHash && st.review.noteHash !== noteHash) {
      throw httpError('定稿笔记在复核之后变过，这次通过不算；请重新复核', 409)
    }
    st.review = { ...(st.review || {}), approved: true, noteHash, comment, decidedAt: new Date().toISOString() }
    st.stage = 'exam'
    await atomicWrite(join(dir, 'notes-final.md'), notesText)
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      role: 'user',
      kind: 'note',
      content: comment || '复核通过，可以出题入库。',
      meta: { step: 'review-approve' },
    })
    await say(stateRoot, id, {
      id: `teach-${id}-v2-review-pass`,
      role: 'professor',
      kind: 'teach',
      content: `收到，笔记哈希锁在 ${noteHash.slice(0, 12)}。现在按条款出题、绑定双向溯源，然后写进知识库。`,
      meta: { step: 'review-pass' },
    })
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, cfg) }
  }

  if (!comment) throw httpError('要退回去改，就说清哪里不对（点出条款编号或写一句该怎么改）', 400)

  // 找出这条意见对应的分片：优先只退回相关的那几片，找不到才整门退回
  const target = normalize(comment)
  const chunks = chunksOf(st, ledger)
  const hitChunks = chunks.filter(chunk => {
    const hay = normalize(chunk.text)
    for (let len = Math.min(24, target.length); len >= 8; len -= 4) {
      for (let i = 0; i + len <= target.length; i++) {
        if (hay.includes(target.slice(i, i + len))) return true
      }
    }
    return false
  }).map(chunk => chunk.index)
  const apply = hitChunks.length ? hitChunks : chunks.map(c => c.index)
  for (const index of apply) {
    const entry = Object.entries(st.chunkIndexByStep || {}).find(([, value]) => value === index)
    if (!entry) continue
    const step = st.plan.steps.find(s => s.id === entry[0])
    if (!step) continue
    requeue(st.plan, step.id, `助教复核意见：${comment}`)
    step.focus = comment
    step.repairWithin = 1
  }
  // 退回重拆：题库按原文生成、不受笔记影响，保留；抽考结果与下游结论作废
  for (const step of st.plan.steps) {
    if (['reconcile', 'validate', 'clarify', 'exam', 'review', 'bind', 'commit'].includes(step.kind)) step.status = 'todo'
  }
  st.exam = { sample: [], answers: [], results: [], round: st.exam.round || 0, passRate: null, passed: 0, total: 0, at: '' }
  st.provenance = null
  st.commit = null
  if (st.plan.blocked) st.plan.blocked = null
  st.review = { ...(st.review || {}), approved: false, comment, decidedAt: new Date().toISOString(), noteHash }
  st.stage = 'study'
  await saveState(stateRoot, id, st)
  await say(stateRoot, id, { role: 'user', kind: 'correction', content: comment, meta: { step: 'review-reject', scope: apply } })
  await say(stateRoot, id, {
    id: `teach-${id}-v2-review-reject-${Date.now()}`,
    role: 'professor',
    kind: 'teach',
    content: `按你的意见退回重拆：${hitChunks.length ? `只重做第 ${apply.join('、')} 片` : '意见没对上具体片段，整门重新精读'}。改完重新校验，再请你复核。`,
    meta: { step: 'review-reject', chunks: apply.length },
  })
  return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, cfg) }
}

/* ------------------------------------------------------- 课堂问答（有据可查） */

/**
 * 把问题拆成「关键词」：去掉疑问词与助词，留下真正的检索对象。
 * 「BOM中的附件物料一定是红色字体吗」→ BOM、附件物料、红色字体。
 */
const Q_PARTICLES = /(是不是|是否|一定|必须|需要|应该|可以|能不能|会不会|有没有|什么|怎么|怎样|哪些|哪个|多少|如何|为什么|多少|吗|呢|吧|的|地|得|中|里|内|上|下|有|是|要|会|能|该|按|用|把|被|给|对|从|和|与|及|或|请|问|一下|我们|你们|他们|这个|那个|这|那)/g

export function questionKeywords(question) {
  const text = String(question || '')
  const latin = [...new Set([...text.matchAll(/[A-Za-z][A-Za-z0-9._-]{1,}/g)].map(match => match[0]))]
  const chunks = text
    .replace(/[？?！!。，,；;：:、]/g, ' ')
    // 「几大类/多少种」这类问数量的说法不是检索词，去掉它们才能找到「六大类」
    .replace(/(几|多少|哪几|哪些)\s*(大|个|种|项|条|步|层|级|章|节|处)?\s*(类|种|项|条|步|层|级|章|节|处|个)?/g, '|')
    .replace(Q_PARTICLES, '|')
    .split('|')
    .map(part => part.replace(/[^\u4e00-\u9fa5]/g, '').trim())
    .filter(part => part.length >= 2)
  return { latin, chunks: [...new Set(chunks)] }
}

/**
 * 在原文片段里找与问题相关的证据：按关键词命中打分，标出原文根本没出现的词，
 * 并对整词缺失的情况用前两字找「近似命中」，好回答「原文只写了什么」。
 *
 * @param ledger 原文账本
 * @param question 助教的问题
 * @param limit 最多取几段证据
 * @returns 关键词、命中片段、近似命中、缺失关键词与检索范围
 */
export function retrieveEvidence(ledger, question, limit = 8) {
  const segments = (ledger.segments || []).filter(seg => seg.substantive && seg.kind !== 'heading' && seg.kind !== 'page_marker')
  const { latin, chunks } = questionKeywords(question)
  const keywords = [...new Set([...chunks, ...latin])]
  const df = new Map(keywords.map(keyword => [keyword, 0]))
  const rows = segments.map(seg => {
    const hay = seg.norm || normalize(seg.text)
    const matched = keywords.filter(keyword => hay.includes(normalize(keyword)))
    for (const keyword of matched) df.set(keyword, (df.get(keyword) || 0) + 1)
    return { seg, hay, matched }
  })
  // 词越罕见、越长，权重越高；满篇都是的「BOM」几乎不参与排序
  const weight = keyword => {
    const count = df.get(keyword) || 0
    if (!count) return 0
    return (1 / Math.sqrt(count)) * Math.min(3, normalize(keyword).length / 2)
  }
  const hits = rows
    .map(({ seg, matched }) => ({
      id: seg.id,
      text: seg.text,
      score: matched.reduce((sum, keyword) => sum + weight(keyword), 0),
      matched,
      rule: RULE_CUE.test(seg.text),
    }))
    // 有问题关键词（中文）时，只命中「BOM」这种泛词的段落不算证据
    .filter(hit => hit.score > 0 && (chunks.length === 0 || hit.matched.some(keyword => chunks.includes(keyword))))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
  const ruleHits = hits.filter(hit => hit.rule)

  const missingKeywords = [...df.entries()].filter(([keyword, count]) => count === 0 && keyword.length >= 2).map(([keyword]) => keyword)
  // 问「几大类/多少种」时，原文里写的是「六大类」这种数量词：按数量+单位直接找枚举句，
  // 否则会拿「几大类」去逐字匹配，永远匹配不上，只能答「原文没有规定」。
  const counting = (() => {
    const q = String(question || '')
    const probe = q.match(/(几|多少|哪几)\s*(大|个|种|项|条|步|层|级|章|节|处)?\s*(类|种|项|条|步|层|级|章|节|处)/)
    if (!probe) return null
    const unit = probe[3]
    const pattern = new RegExp(`([一二三四五六七八九十两\\d]+)\\s*(大|个)?\\s*${unit}`, 'g')
    const found = []
    for (const seg of segments) {
      for (const match of String(seg.text).matchAll(pattern)) {
        found.push({ id: seg.id, text: seg.text, count: match[1], lead: match[2] || '', unit, at: match.index })
      }
    }
    if (!found.length) return { unit, hits: [] }
    // 「几大类」问的是「六大类」这种说法，不是「三类BOM层级」；问了大类就优先大类的命中
    const preferBig = /(几|多少|哪几)\s*大\s*[类种项]/.test(q)
    const pool = preferBig && found.some(item => item.lead === '大')
      ? found.filter(item => item.lead === '大')
      : found
    const nouns = keywords.filter(keyword => keyword.length >= 2)
    const seen = new Set()
    const hits = pool
      .map(item => ({
        ...item,
        score: nouns.filter(noun => normalize(item.text).includes(normalize(noun))).length
          + (RULE_CUE.test(item.text) ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .filter(item => (seen.has(item.id) ? false : seen.add(item.id)))
      .slice(0, 4)
    return { unit, hits }
  })()
  // 整词没出现时，退到它的子词去原文里找（「红色字体」→「字体」，「附件物料」→「附件」）
  const approx = []
  for (const keyword of missingKeywords) {
    const candidates = []
    for (let size = Math.min(3, keyword.length - 1); size >= 2; size--) {
      for (let i = 0; i + size <= keyword.length; i++) candidates.push(keyword.slice(i, i + size))
    }
    for (const term of candidates) {
      const matched = rows.filter(row => row.hay.includes(normalize(term))).slice(0, 2)
      if (!matched.length) continue
      approx.push({
        keyword,
        basedOn: term,
        matches: matched.map(row => ({ id: row.seg.id, text: snippetAround(row.seg.text, term) })),
      })
      break
    }
  }
  return { keywords, chunks, latin, hits, ruleHits, counting, missingKeywords, approx, scanned: segments.length }
}

/** 取命中词附近的一段原文，而不是甩一个 400 字的整段过去。 */
function snippetAround(text, term, radius = 55) {
  const body = String(text || '').replace(/\s+/g, ' ').trim()
  const at = body.indexOf(term)
  if (at < 0) return shortQuote(body, 90)
  const start = Math.max(0, at - radius)
  const end = Math.min(body.length, at + term.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

function shortQuote(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 取包含某个词的那一句原文：数量型答案要引「…六大类…」整句，而不是整段开头。 */
function sentenceWith(text, term) {
  const body = String(text || '')
  const parts = body.split(/(?<=[。；！？\n])/).map(part => part.trim()).filter(Boolean)
  return parts.find(part => part.includes(term)) || body.trim()
}

/**
 * 确定性答案：没有模型也能给出「原文怎么规定 / 原文没规定什么」的结论。
 * 模型改写只在保持引用、且不新增数字的前提下才被采用。
 */
export function composeGroundedAnswer(evidence) {
  const lines = []
  const missing = evidence.missingKeywords || []
  // 数量型问题：先给「原文写的是几大类」这种结论，别再拿「几大类」说"原文没有规定"
  if (evidence.counting?.hits?.length) {
    const best = evidence.counting.hits[0]
    const used = []
    const term = `${best.count}${best.lead || ''}${best.unit}`
    lines.push(`原文写的是「${term}」：`)
    for (const item of evidence.counting.hits.slice(0, 2)) {
      if (used.includes(item.id)) continue
      const hitTerm = `${item.count}${item.lead || ''}${item.unit}`
      used.push(item.id)
      lines.push(`- ${shortQuote(sentenceWith(item.text, hitTerm), 160)} ⟦${item.id}⟧`)
    }
    if (used.length) lines.push(`依据：${used.map(id => `⟦${id}⟧`).join(' ')}（原文片段，可逐字回查）。`)
    return { text: lines.join('\n').trim(), citations: used }
  }
  if (missing.length) {
    lines.push(`原文没有规定「${missing.join('、')}」（${evidence.scanned} 个实质片段里都没有出现）。`)
    if (evidence.hits.length) lines.push('与这个问题有关的原文是：')
  } else if (evidence.ruleHits.length) {
    lines.push('原文有明确规定：')
  } else if (evidence.hits.length) {
    lines.push('原文没有把它写成规则，只在下面这些地方提到：')
  } else {
    lines.push(`原文没有涉及这个问题（检索了 ${evidence.scanned} 个片段，0 命中）。`)
  }
  const used = []
  const seen = new Set()
  const pushLine = (label, hit) => {
    if (!hit || seen.has(hit.id) || used.length >= 4) return
    seen.add(hit.id)
    used.push(hit.id)
    lines.push(`- ${label ? `关于「${label}」：` : ''}${shortQuote(hit.text)} ⟦${hit.id}⟧`)
  }
  // 每个问题关键词给一条最相关的原文，避免拿一堆不相干的段落凑数
  for (const keyword of evidence.chunks || []) {
    const hit = evidence.hits.find(item => item.matched.includes(keyword))
    pushLine(keyword, hit)
  }
  for (const item of evidence.approx || []) {
    for (const match of item.matches || []) {
      if (used.length >= 5) break
      if (seen.has(match.id)) continue
      seen.add(match.id)
      used.push(match.id)
      lines.push(`- 原文没有「${item.keyword}」，只有「${item.basedOn}」：${shortQuote(match.text)} ⟦${match.id}⟧`)
    }
  }
  if (!used.length && evidence.hits.length) pushLine('', evidence.hits[0])
  if (missing.length) lines.push('', `结论：「${missing.join('、')}」不是这份原文的规定；上面这些才是它真正写到的内容。`)
  if (used.length) lines.push(`依据：${used.map(id => `⟦${id}⟧`).join(' ')}（原文片段，可逐字回查）。`)
  return { text: lines.join('\n').trim(), citations: used }
}

const stripCitations = text => String(text || '').replace(/⟦S\d+⟧/g, ' ')
const citationsOf = text => [...new Set([...String(text || '').matchAll(/⟦(S\d+)⟧/g)].map(match => match[1]))]
const digitsOf = text => [...new Set((stripCitations(text).match(/\d+(?:\.\d+)?%?/g) || []))]
/** 只取「带单位的量」：百分比、件数、次数、年限、字号、尺寸。 */
const quantityOf = text => [...new Set((stripCitations(text).match(/\d+(?:\.\d+)?\s*(?:%|％|件|个|次|年|月|天|小时|号|mm|cm|kg|g|米|层|类|条|份|人)/g) || [])
  .map(value => value.replace(/\s+/g, '')))]

/**
 * 课堂提问：先做确定性证据检索，再让模型只按证据措辞；模型的回答若不守规矩
 * （丢了引用、冒出证据里没有的数字），直接退回确定性答案。
 */
async function askUnlocked(stateRoot, options = {}) {
  const id = safeId(options.id)
  const cfg = { ...DEFAULTS, ...(options.cfg || {}) }
  const question = String(options.text || '').trim()
  if (!question) throw httpError('问题不能为空', 400)
  const st = await loadState(stateRoot, id)
  const dir = dirOf(stateRoot, id)
  // 先把问题落进实录：模型要跑十几秒，问题不能等回答完才出现（中途失败也不该丢）
  if (!options.alreadySaid) await say(stateRoot, id, { role: 'user', kind: 'question', content: question, meta: { step: 'ask' } })
  const { source, ledger: cached } = await ensureLedger(stateRoot, id)
  const ledger = cached || buildLedger(source)
  if (!cached) await atomicWrite(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  const evidence = retrieveEvidence(ledger, question)
  const draft = composeGroundedAnswer(evidence)
  const evidenceHits = [
    ...evidence.hits.map(hit => ({ id: hit.id, text: hit.text, note: '' })),
    ...evidence.approx.flatMap(item => item.matches.map(match => ({
      id: match.id,
      text: match.text,
      note: `原文没有「${item.keyword}」，只有「${item.basedOn}」`,
    }))),
  ]
  let answer = draft.text
  let polished = false
  if (options.chat && evidenceHits.length) {
    const prompt = [
      `课程：${st.title}`,
      `助教的问题：${question}`,
      evidence.missingKeywords.length
        ? `检索结论：原文里没有「${evidence.missingKeywords.join('、')}」这些词。`
        : '',
      '',
      '可用的原文片段（只能引用这些，其他一律不许说）：',
      ...evidenceHits.map(hit => `⟦${hit.id}⟧${hit.note ? `（${hit.note}）` : ''} ${hit.text}`),
      '',
      '如果上面没有覆盖问题的关键内容，就回答「原文没有规定」，并说清原文只写了什么。',
      '每条依据后面必须保留 ⟦S####⟧ 引用标记，不许出现片段以外的数字与结论。',
      '',
      `参考草稿（可以改写得更像讲课，但引用与事实不能改）：\n${draft.text}`,
    ].filter(Boolean).join('\n')
    try {
      const polishedText = await callText(options.chat, { system: PROMPTS.ask, prompt, maxTokens: 8000 })
      const cited = citationsOf(polishedText)
      const allowed = new Set(evidenceHits.map(hit => hit.id))
      const evidenceText = evidenceHits.map(hit => hit.text).join('\n') + question + draft.text
      const allowedDigits = new Set(digitsOf(evidenceText))
      const extraDigits = digitsOf(polishedText).filter(digit => !allowedDigits.has(digit))
      const keepsCitations = cited.length > 0 && cited.every(citation => allowed.has(citation))
      if (polishedText.trim() && keepsCitations && !extraDigits.length) {
        answer = polishedText.trim()
        polished = true
      } else {
        st.errors.push({
          at: new Date().toISOString(),
          scope: 'ask-polish',
          message: `模型改写未采用：${keepsCitations ? '' : '丢了引用或引用了不存在的片段'}${extraDigits.length ? `新增数字 ${extraDigits.join('、')}` : ''}`,
        })
      }
    } catch (error) {
      st.errors.push({ at: new Date().toISOString(), scope: 'ask', message: String(error?.message || error).slice(0, 200) })
    }
  }
  await say(stateRoot, id, {
    id: `teach-${id}-ask-${Date.parse(new Date().toISOString()).toString(36)}`,
    role: 'student',
    kind: 'answer',
    speaker: '学员',
    content: answer,
    refs: draft.citations.map(citation => String(ledger.segments.find(seg => seg.id === citation)?.text || '').slice(0, 280)).filter(Boolean),
    meta: { step: 'ask', citations: draft.citations, hits: evidence.hits.length, missing: evidence.missingKeywords, polished },
  })
  st.qa = [...(st.qa || []), {
    at: new Date().toISOString(),
    q: question,
    a: answer,
    citations: draft.citations,
    missingKeywords: evidence.missingKeywords,
    polished,
  }].slice(-40)
  // 课堂上的问答也是课堂知识：进笔记，跟着复核与入库一起走
  st.classNotes = [...(st.classNotes || []), {
    at: new Date().toISOString(),
    kind: 'qa',
    q: question,
    a: answer,
    citations: draft.citations,
  }].slice(-40)
  await saveState(stateRoot, id, st)
  return {
    classroom: (await getClassroom(stateRoot, id)).classroom,
    teaching: await describeState(stateRoot, id, cfg),
    answer: {
      text: answer,
      citations: draft.citations,
      polished,
      missingKeywords: evidence.missingKeywords,
      evidence: evidenceHits.map(hit => ({ id: hit.id, text: shortQuote(hit.text) })),
    },
  }
}

export async function askInClass(stateRoot, options = {}) {
  const id = safeId(options.id)
  return withLock(`write:${stateRoot}:${id}`, () => askUnlocked(stateRoot, { ...options, id }))
}

/**
 * 把旧引擎的课堂升级成全文精读流程：保留全部对话记录，重新切账本排计划。
 * 学习进度从头开始（旧引擎的产物不再参与结论），但历史一条不删。
 */
export async function adopt(stateRoot, options = {}) {
  const id = safeId(options.id)
  return withLock(`write:${stateRoot}:${id}`, async () => {
    const cfg = { ...DEFAULTS, ...(options.cfg || {}) }
    const dir = dirOf(stateRoot, id)
    const source = await readFile(join(dir, 'source.md'), 'utf8')
    if (!source.trim()) throw httpError('这间课堂没有原文，无法升级', 409)
    const classroom = (await getClassroom(stateRoot, id)).classroom
    const title = String(options.title || classroom.title || '课堂').slice(0, 160)
    const ledger = buildLedger(source)
    const density = densityOf(ledger)
    const plan = makePlan(ledger, { chunkChars: cfg.chunkChars, maxAttempts: cfg.maxAttempts })
    const st = freshState({ title, sourceName: 'source.md', source, ledger, plan, density })
    await atomicWrite(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
    await atomicWrite(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
    await mkdir(join(dir, 'task_state', 'notes'), { recursive: true })
    await mkdir(join(dir, 'task_state', 'read'), { recursive: true })
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      id: `teach-${id}-v2-adopt`,
      role: 'system',
      kind: 'system',
      content: `本课堂已升级到全文精读流程：原文 ${st.sourceChars} 字切成 ${ledger.stats.segments} 个片段，`
        + `分 ${plan.steps.filter(step => step.kind === 'absorb').length} 片全读；历史对话全部保留，学习从头开始。`,
      meta: { step: 'adopt', segments: ledger.stats.segments },
    })
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, cfg) }
  })
}

/**
 * 用户在课堂上说话：先判读这句话是闲聊、提问还是含知识的补充/纠正。
 * 闲聊不记笔记，但要判读其中有没有值得记下来的课堂知识。
 */
export async function sayToClass(stateRoot, options = {}) {
  const id = safeId(options.id)
  return withLock(`write:${stateRoot}:${id}`, () => sayUnlocked(stateRoot, { ...options, id }))
}

/** 和原文逐字重合的长窗口：用来判断这句话有没有原文依据。 */
function sourceSupport(text, source) {
  const flat = normalize(text)
  for (let len = 20; len >= 10; len -= 5) {
    for (let i = 0; i + len <= flat.length; i++) {
      const window = flat.slice(i, i + len)
      if (normalize(source).includes(window)) {
        return source.split(/[\n。；]/).find(line => normalize(line).includes(window)) || window
      }
    }
  }
  return ''
}



async function chatReply(text, { st, chat }) {
  if (!chat) return '嗯，我在。'
  try {
    const reply = await callText(chat, {
      system: PROMPTS.chat,
      prompt: `课程：${st.title}\n助教说：${text}`,
      maxTokens: 600,
    })
    return String(reply || '').trim().slice(0, 300) || '嗯，我在。'
  } catch (error) {
    st.errors = [...(st.errors || []), { at: new Date().toISOString(), scope: 'chat', message: String(error?.message || error).slice(0, 200) }]
    return '嗯，我在。'
  }
}

/** 检索到的片段连同相邻上下文一起给模型：截断处也能读全。 */
function materialFor(ledger, evidence, extra = []) {
  const list = ledger.segments || []
  const byId = new Map(list.map(segment => [segment.id, segment]))
  const ids = [...new Set([
    ...(evidence.hits || []).map(hit => hit.id),
    ...(evidence.counting?.hits || []).map(hit => hit.id),
  ])]
  const out = []
  for (const id of ids) {
    const seg = byId.get(id)
    if (!seg) continue
    if (!out.some(item => item.id === seg.id)) out.push(seg)
    const at = list.findIndex(item => item.id === id)
    for (const near of [list[at - 1], list[at + 1]]) {
      if (!near || out.some(item => item.id === near.id)) continue
      if (near.kind === 'page_marker' || near.kind === 'heading') continue
      out.push(near)
    }
    if (out.length >= 16) break
  }
  for (const seg of extra) if (seg && !out.some(item => item.id === seg.id)) out.push(seg)
  return out
}

/**
 * 课堂对话主路径：把「你的笔记 + 相关原文」交给模型，让它先理解这句话，
 * 再自己决定怎么回、要不要补检索（need）、要不要记（record）。
 * 代码只负责找材料、校验引用，不规定它只能怎么回。
 */
async function converseSay({ st, ledger, source, text, chat }) {
  const evidence = retrieveEvidence(ledger, text, 10)
  let material = materialFor(ledger, evidence)
  const history = (st.qa || []).slice(-4).map(item => `助教问：${String(item.q).slice(0, 120)}\n学员答：${String(item.a).slice(0, 160)}`).join('\n')
  const prompt = need => [
    `课程：${st.title}`,
    history ? `最近的问答：\n${history}` : '',
    `你的相关笔记：\n${notesForSegments(st, material.map(seg => seg.id)) || '（笔记里还没有相关条目）'}`.slice(0, 6000),
    `原文材料：\n${material.map(seg => `⟦${seg.id}⟧ ${seg.text}`).join('\n').slice(0, 16000)}`,
    need?.length ? `（助教补充检索：${need.join('、')}）` : '',
    `助教说：${text}`,
  ].filter(Boolean).join('\n\n')
  let { data } = await callJson(chat, { system: PROMPTS.converse, prompt: prompt(), maxTokens: 6000 })
  const need = (Array.isArray(data.need) ? data.need : [])
    .map(item => String(item || '').trim())
    .filter(item => item.length >= 2).slice(0, 4)
  if (need.length) {
    const extraEvidence = retrieveEvidence(ledger, need.join(' '), 8)
    const merged = new Map(material.map(seg => [seg.id, seg]))
    for (const seg of materialFor(ledger, extraEvidence)) merged.set(seg.id, seg)
    material = [...merged.values()]
    ;({ data } = await callJson(chat, { system: PROMPTS.converse, prompt: prompt(need), maxTokens: 6000 }))
  }
  return { data, material }
}

async function sayUnlocked(stateRoot, options = {}) {
  const id = safeId(options.id)
  const st = await loadState(stateRoot, id)
  const text = String(options.text || '').trim()
  if (!text) throw httpError('发言不能为空', 400)
  if (text.length > 4000) throw httpError('单条发言超过 4000 字符', 413)
  const dir = dirOf(stateRoot, id)
  // 用户的话先落盘：不等到模型回复才出现，中途失败也不丢
  await say(stateRoot, id, { role: 'user', kind: 'note', content: text, meta: { step: 'user-say' } })
  if (!options.chat) {
    // 没有模型通道时退回确定性路径：提问拿原文答，其余按记录处理
    const asking = /[?？]\s*$/.test(text) || /(吗|是不是|是否|什么|怎么|哪些|多少|几大|几类|几种|几个|有没有)/.test(text)
    if (asking) return askUnlocked(stateRoot, { ...options, id, text, alreadySaid: true })
  }
  const { source, ledger: cached } = await ensureLedger(stateRoot, id)
  const ledger = cached || buildLedger(source)
  if (!cached) await atomicWrite(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)

  // 动作流里也要看得见「学员正在理解」：模型调用可能十几秒
  await markProgress(stateRoot, id, st, 'converse', '学员理解并回答', { tag: '调用模型', detail: text.slice(0, 48) })
  let turn = null
  try {
    turn = await converseSay({ st, ledger, source, text, chat: options.chat })
  } catch (error) {
    st.errors = [...(st.errors || []), { at: new Date().toISOString(), scope: 'converse', message: String(error?.message || error).slice(0, 200) }]
  }
  await finishProgress(stateRoot, id, st, turn ? '已回答' : '模型不可用，走兜底', Boolean(turn))
  await saveState(stateRoot, id, st)

  // 模型不可用时退回确定性回答（提问）或简短寒暄
  if (!turn || !String(turn.data.reply || '').trim()) {
    const asking = /[?？]\s*$/.test(text) || /(吗|是不是|是否|什么|怎么|哪些|多少|几大|几类|几种|几个|有没有)/.test(text)
    if (asking) {
      const evidence = retrieveEvidence(ledger, text)
      await say(stateRoot, id, {
        role: 'student', kind: 'answer', content: composeGroundedAnswer(evidence).text.slice(0, 3000),
        meta: { step: 'ask-fallback', citations: composeGroundedAnswer(evidence).citations },
      })
      await saveState(stateRoot, id, st)
      return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, { ...DEFAULTS }) }
    }
    await say(stateRoot, id, { role: 'student', kind: 'note', content: await chatReply(text, { st, chat: options.chat }), meta: { step: 'chat-fallback' } })
    await saveState(stateRoot, id, st)
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, { ...DEFAULTS }) }
  }

  const intent = ['chat', 'question', 'knowledge'].includes(String(turn.data.intent)) ? String(turn.data.intent) : 'question'
  const rawReply = String(turn.data.reply || '').trim()
  // 校验：引用只能来自给它的材料，数字不能凭空出现。越界就退回确定性证据回答，
  // 这不限制模型怎么组织语言，只拦「编」。
  const packIds = new Set(turn.material.map(seg => seg.id))
  const packDigits = new Set(digitsOf(turn.material.map(seg => seg.text).join('\n')))
  const questionDigits = new Set(digitsOf(text))
  const badCitations = citationsOf(rawReply).filter(citation => !packIds.has(citation))
  const badDigits = digitsOf(stripCitations(rawReply)).filter(digit => !packDigits.has(digit) && !questionDigits.has(digit))
  let replyText = rawReply
  if ((badCitations.length || badDigits.length) && intent !== 'knowledge') {
    replyText = composeGroundedAnswer(retrieveEvidence(ledger, text)).text
  } else if (badCitations.length) {
    replyText = stripCitations(rawReply).trim()
  }
  if (!replyText) replyText = composeGroundedAnswer(retrieveEvidence(ledger, text)).text

  const support = intent === 'knowledge'
    ? (String(turn.data.quote || '').trim() && sourceSupport(String(turn.data.quote), source)) || sourceSupport(text, source)
    : ''
  st.saidStats = { ...(st.saidStats || {}), [intent]: ((st.saidStats || {})[intent] || 0) + 1 }

  if (intent === 'knowledge') {
    const segIds = support
      ? (ledger.segments || []).filter(segment => normalize(segment.text).includes(normalize(support).slice(0, 40))).slice(0, 3).map(segment => segment.id)
      : []
    st.notes = [...(st.notes || []), text].slice(-8)
    if (support) st.corrections = [...(st.corrections || []), { at: new Date().toISOString(), text: text.slice(0, 300), quote: support.slice(0, 200) }].slice(-8)
    st.classNotes = [...(st.classNotes || []), {
      at: new Date().toISOString(),
      kind: 'correction',
      text: String(turn.data.record || text).slice(0, 300),
      quote: support.slice(0, 300),
      segments: segIds,
      origin: support ? 'source' : 'external',
    }].slice(-40)
    if (st.stage === 'review' || st.stage === 'study') {
      const chunks = attachChunkIndex(st, ledger)
      const target = chunks.filter(chunk => normalize(chunk.text).includes(normalize(support || text).slice(0, 24)))
      for (const chunk of target.slice(0, 2)) {
        const step = chunkStep(st, chunk.index)
        if (!step) continue
        requeue(st.plan, step.id, `助教补充：${text.slice(0, 120)}`)
        step.focus = text.slice(0, 500)
      }
      if (target.length) {
        for (const item of st.plan.steps) {
          if (['reconcile', 'validate', 'quiz', 'exam', 'review', 'bind', 'commit'].includes(item.kind)) item.status = 'todo'
        }
        st.stage = 'study'
      }
    }
  }

  const citations = citationsOf(replyText)
  await saveState(stateRoot, id, st)
  await say(stateRoot, id, {
    role: 'student',
    kind: intent === 'question' ? 'answer' : 'note',
    content: replyText.slice(0, 3000),
    refs: citations.map(citation => String(ledger.segments.find(seg => seg.id === citation)?.text || '').slice(0, 280)).filter(Boolean),
    meta: { step: 'converse', intent, support: Boolean(support), citations },
  })
  return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, { ...DEFAULTS }) }
}

/**
 * 其它会话发现的「课堂知识需要更正」：先登记成提案，不动笔记。
 * 提案里有原文依据的会带片段编号，方便复核时核对；确认后才真正回退重学。
 */
export async function fileCorrection(stateRoot, options = {}) {
  const id = safeId(options.id)
  const text = String(options.text || '').trim()
  if (!text) throw httpError('更正要说明改成什么', 400)
  if (text.length > 2000) throw httpError('单条更正超过 2000 字符', 413)
  const st = await loadState(stateRoot, id)
  const dir = dirOf(stateRoot, id)
  const source = await readFile(join(dir, 'source.md'), 'utf8').catch(() => '')
  const support = sourceSupport(text, source) || sourceSupport(String(options.evidence || ''), source)
  const ledger = await readJson(join(dir, 'ledger.json'), null)
  const segments = support && ledger
    ? (ledger.segments || [])
      .filter(segment => normalize(segment.text).includes(normalize(support).slice(0, 40)))
      .slice(0, 3).map(segment => segment.id)
    : []
  const entry = {
    id: `fix-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    text: text.slice(0, 500),
    evidence: String(options.evidence || '').slice(0, 500),
    support: support.slice(0, 300),
    segments,
    origin: String(options.origin || 'session').slice(0, 60),
    status: 'pending',
  }
  st.pendingCorrections = [...(st.pendingCorrections || []), entry].slice(-20)
  await saveState(stateRoot, id, st)
  return { correction: entry, pending: st.pendingCorrections }
}

/**
 * 用户确认/驳回更正提案。确认后：把这条写进课堂补充，回退受影响分片，
 * 下游校验/题库/复核全部作废重来——不允许在已复核的笔记上偷偷改字。
 */
export async function decideCorrection(stateRoot, options = {}) {
  const id = safeId(options.id)
  const st = await loadState(stateRoot, id)
  const dir = dirOf(stateRoot, id)
  const list = st.pendingCorrections || []
  const entry = list.find(item => item.id === String(options.correctionId || ''))
  if (!entry) throw httpError('没有这条更正提案', 404)
  if (entry.status !== 'pending') throw httpError('这条更正已经处理过了', 409)
  entry.status = options.accept ? 'accepted' : 'rejected'
  entry.decidedAt = new Date().toISOString()
  if (options.accept) {
    st.classNotes = [...(st.classNotes || []), {
      at: entry.at,
      kind: 'correction',
      text: entry.text,
      quote: entry.support,
      segments: entry.segments || [],
      origin: entry.support ? 'source' : 'external',
      correctionId: entry.id,
      origin_sessions: entry.origin,
    }].slice(-40)
    const ledger = await readJson(join(dir, 'ledger.json'), null)
    if (ledger) {
      const chunks = attachChunkIndex(st, ledger)
      const probe = String(entry.support || entry.text).slice(0, 24)
      const target = chunks.filter(chunk => normalize(chunk.text).includes(normalize(probe)))
      for (const chunk of target.slice(0, 2)) {
        const step = chunkStep(st, chunk.index)
        if (!step) continue
        requeue(st.plan, step.id, `更正：${entry.text.slice(0, 120)}`)
        step.focus = entry.text.slice(0, 500)
      }
    }
    // 改的是已签字的笔记：复核结论作废，下游步骤全部退回，必须重新走闸门
    st.review = null
    st.validation = null
    st.provenance = null
    if (st.commit) st.commit.stale = true
    for (const step of st.plan.steps || []) {
      if (['reconcile', 'validate', 'quiz', 'exam', 'review', 'bind', 'commit'].includes(step.kind)) {
        step.status = 'todo'
        step.attempts = 0
        step.lastError = ''
      }
    }
    st.stage = 'study'
  }
  await saveState(stateRoot, id, st)
  return { correction: entry, pending: st.pendingCorrections || [], stage: st.stage }
}

/**
 * 重建 ReMe 检索索引。scope：embedding（向量，默认）/ bm25 / tag / all。
 * 只动索引，不动记忆内容；all 会把全部块重新嵌入，耗时和嵌入调用都更多。
 */
export async function reindexMemory(cfg = {}, scope = 'embedding') {
  const allowed = ['embedding', 'bm25', 'tag', 'all']
  const wanted = String(scope || 'embedding')
  if (!allowed.includes(wanted)) throw httpError(`scope 只能是 ${allowed.join(' / ')}`, 400)
  const base = String(cfg.remeEndpoint || 'http://127.0.0.1:2333').replace(/\/$/, '')
  const started = Date.now()
  try {
    const response = await fetch(`${base}/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: wanted }),
      signal: AbortSignal.timeout(240000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(data?.answer || '').slice(0, 120)}`)
    return {
      ok: data.success !== false,
      scope: wanted,
      ms: Date.now() - started,
      indexed: typeof data?.metadata?.indexed === 'number' ? data.metadata.indexed
        : (typeof data.indexed === 'number' ? data.indexed : null),
      detail: String(data.answer || '').slice(0, 200),
    }
  } catch (error) {
    return { ok: false, scope: wanted, ms: Date.now() - started, error: String(error?.message || error).slice(0, 200) }
  }
}

/**
 * 重新交付：笔记与题库都在盘上，只重跑入库（换知识库、ReMe 掉线后重试）。
 * 不改笔记内容，所以不影响复核结论。
 */
export async function recommit(stateRoot, options = {}) {
  const id = safeId(options.id)
  return withLock(`write:${stateRoot}:${id}`, async () => {
    const cfg = { ...DEFAULTS, ...(options.cfg || {}) }
    const st = await loadState(stateRoot, id)
    if (st.stage !== 'finished' || !st.provenance) throw httpError('这间课堂还没结课，没有可重交的产物', 409)
    const dir = dirOf(stateRoot, id)
    const { source, ledger: cached } = await ensureLedger(stateRoot, id)
    const ledger = cached || buildLedger(source)
    const notesText = await readFile(join(dir, 'notes-final.md'), 'utf8')
    const commit = await (options.deps?.commit || commitLearning)({
      cfg,
      stateRoot,
      classroomId: id,
      state: st,
      ledger,
      notesText,
      quiz: st.quiz.questions,
      provenance: st.provenance,
      quizText: renderQuiz(st),
    })
    st.commit = commit
    await atomicWrite(join(dir, 'commit.json'), `${JSON.stringify(commit, null, 2)}\n`)
    await saveState(stateRoot, id, st)
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: await describeState(stateRoot, id, cfg), commit }
  })
}

/* ------------------------------------------------------------ 开课 */

/** 同一份原文是否已经学过（原文哈希相同、且已结课）。 */
export async function findBySource(stateRoot, sourceHash) {
  if (!sourceHash) return null
  let names = []
  try { names = await readdir(join(stateRoot, 'classrooms')) } catch { return null }
  for (const name of names) {
    const st = await readJson(join(stateRoot, 'classrooms', name, 'teaching.json'), null)
    if (!st || st.schema !== SCHEMA || st.sourceHash !== sourceHash) continue
    if (st.stage !== 'finished' && st.stage !== 'review') continue
    return { id: name, title: st.title, stage: st.stage }
  }
  return null
}

/** 找同标题的上一版课堂（用于课件更新时对比差异）。 */
async function findPreviousByTitle(stateRoot, id, title) {
  let names = []
  try { names = await readdir(join(stateRoot, 'classrooms')) } catch { return null }
  let best = null
  for (const name of names) {
    if (name === id) continue
    const st = await readJson(join(stateRoot, 'classrooms', name, 'teaching.json'), null)
    if (!st || st.schema !== SCHEMA || st.title !== title) continue
    if (!st.stage) continue
    const at = Date.parse(st.updatedAt || '') || 0
    if (!best || at > best.at) best = { id: name, at, version: Number(st.sourceVersion) || 1, stage: st.stage }
  }
  return best
}

/** 新旧账本按片段文本做差：新增 / 删除 / 改写各多少。 */
function diffLedgers(oldLedger, newLedger) {
  if (!oldLedger || !Array.isArray(oldLedger.segments)) return null
  const oldTexts = (oldLedger.segments || []).filter(s => s.substantive).map(s => normalize(s.text))
  const newTexts = (newLedger.segments || []).filter(s => s.substantive).map(s => normalize(s.text))
  const oldSet = new Map()
  for (const text of oldTexts) oldSet.set(text, (oldSet.get(text) || 0) + 1)
  let added = 0
  for (const text of newTexts) {
    if ((oldSet.get(text) || 0) > 0) oldSet.set(text, oldSet.get(text) - 1)
    else added += 1
  }
  let removed = 0
  for (const count of oldSet.values()) removed += count
  return { added, removed, unchanged: newTexts.length - added, oldTotal: oldTexts.length, newTotal: newTexts.length }
}

/**
 * 开课 / 重新导入原文：切账本、排计划、落盘。不调模型。
 * 原文变了就是新的一课（旧产物保留在目录里，不清空）。
 */
export async function openTeaching(stateRoot, options = {}) {
  const cfg = { ...DEFAULTS, ...(options.cfg || {}) }
  const id = safeId(options.id)
  const dir = dirOf(stateRoot, id)
  await mkdir(dir, { recursive: true })
  const incoming = String(options.source == null ? '' : options.source)
  if (incoming.trim() && countChars(incoming) > cfg.maxSourceChars) {
    throw httpError(`原文 ${countChars(incoming)} 字，超过单课上限定 ${cfg.maxSourceChars} 字；请按章节拆成多门课`, 413)
  }
  const sourcePath = join(dir, 'source.md')
  let existing = null
  try { existing = await readFile(sourcePath, 'utf8') } catch { /* 第一次 */ }
  const source = incoming.trim() ? incoming : (existing || '')
  if (!source.trim()) throw httpError('这间课堂还没有原文：请先导入课件', 400)
  if (incoming.trim() && incoming !== existing) await atomicWrite(sourcePath, incoming)

  // 原件也存一份：抽取只保留文字，图表/版式丢了原始文件就找不回来
  let sourceFile = null
  if (options.sourceFile) {
    try {
      const name = basename(String(options.sourceFile)).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'source.bin'
      const originalDir = join(dir, 'original')
      await mkdir(originalDir, { recursive: true })
      const target = join(originalDir, name)
      await copyFile(String(options.sourceFile), target)
      const bytes = await readFile(target)
      sourceFile = { name, path: target, bytes: bytes.length, sha256: sha256(bytes) }
    } catch (error) {
      sourceFile = { name: basename(String(options.sourceFile)), error: String(error?.message || error).slice(0, 160) }
    }
  }

  const classroom = (await getClassroom(stateRoot, id)).classroom
  const title = String(options.title || classroom.title || '课堂').slice(0, 160)
  const old = await readJson(join(dir, 'teaching.json'), null)
  const ledger = buildLedger(source)
  const density = densityOf(ledger)
  if (old && old.schema === SCHEMA && old.sourceHash === sha256(source.replace(/\r\n/g, '\n'))) {
    old.title = title
    await saveState(stateRoot, id, old)
    return { classroom, teaching: await describeState(stateRoot, id, cfg), chapters: ledger.chapters, reused: true }
  }
  const plan = makePlan(ledger, { chunkChars: cfg.chunkChars, maxAttempts: cfg.maxAttempts })
  const st = freshState({ title, sourceName: options.sourceName, source, ledger, plan, density })
  // 课件更新：找到同标题的上一版，记下差异（新增/删除/未变），并给出第几版
  const previous = await findPreviousByTitle(stateRoot, id, title)
  const previousState = previous ? await readJson(join(dirOf(stateRoot, previous.id), 'teaching.json'), null) : null
  st.sourceFile = sourceFile
  st.sourceVersion = previous ? Number(previous.version || previousState?.sourceVersion || 1) + 1 : 1
  st.previous = previous
    ? { id: previous.id, title: previousState?.title || title, stage: previous.stage, version: previous.version }
    : null
  st.sourceChange = previous
    ? diffLedgers(await readJson(join(dirOf(stateRoot, previous.id), 'ledger.json'), null), ledger)
    : null
  await atomicWrite(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  await atomicWrite(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  await mkdir(join(dir, 'task_state', 'notes'), { recursive: true })
  await mkdir(join(dir, 'task_state', 'read'), { recursive: true })
  await saveState(stateRoot, id, st)
  await say(stateRoot, id, {
    id: `teach-${id}-v2-source`,
    role: 'system',
    kind: 'source',
    content: `原文已入库：${st.sourceChars} 字，切成 ${ledger.stats.segments} 个片段`
      + `（实质 ${ledger.stats.substantive}、表格行 ${ledger.stats.tableRows}、条款 ${ledger.stats.clauses}），`
      + `分 ${plan.steps.filter(s => s.kind === 'absorb').length} 片全读；密度判为${density.high ? '高密度（笔记要求 ≥ 原文 2 倍）' : '低密度（只要求信息全覆盖）'}。`
      + `计划 ${plan.steps.length} 步，按顺序执行，校验不过就退回重拆。`
      + (st.sourceVersion > 1 && st.sourceChange
        ? `\n这是第 ${st.sourceVersion} 版（上一版 ${st.previous.id}）：新增 ${st.sourceChange.added} 段、删除 ${st.sourceChange.removed} 段、未变 ${st.sourceChange.unchanged} 段，建议对照上一版复核改动处。`
        : '')
      + (st.sourceFile?.name ? `\n原件已保存：${st.sourceFile.name}（${st.sourceFile.bytes} 字节）。` : ''),
    meta: {
      step: 'source', segments: ledger.stats.segments,
      chunks: plan.steps.filter(s => s.kind === 'absorb').length, density: density.high,
      version: st.sourceVersion, sourceFile: st.sourceFile?.name || '',
    },
  })
  return { classroom, teaching: await describeState(stateRoot, id, cfg), chapters: ledger.chapters }
}

/** 是否是 v2 课堂。 */
export async function isV2(stateRoot, id) {
  const st = await readJson(join(dirOf(stateRoot, id), 'teaching.json'), null)
  return Boolean(st && st.schema === SCHEMA)
}

export async function teachingState(stateRoot, id, cfg = {}) {
  const st = await loadState(stateRoot, id)
  return describeState(stateRoot, id, { ...DEFAULTS, ...cfg })
}

/* ------------------------------------------------------------ 描述 */

function STAGE_LABELS(stage) {
  return STAGE_LABEL[stage] || stage
}

export async function describeState(stateRoot, id, cfg = {}) {
  const dir = dirOf(stateRoot, id)
  const st = await loadState(stateRoot, id)
  const ledger = await readJson(join(dir, 'ledger.json'), null)
  const plan = planSnapshot(st.plan)
  const chunks = Object.values(st.study.chunks || {})
  const points = allPoints(st)
  const clauses = (st.prep.map.clauses || []).filter(c => !c.orphan)
  const absorbSteps = (st.plan.steps || []).filter(s => s.kind === 'absorb')
  const absorbDone = absorbSteps.filter(s => s.status === 'done').length
  const coverage = st.study.coverage
  const validation = st.validation
  const questions = st.quiz.questions || []
  const passLine = Math.round((Number(cfg.passThreshold) || 0.75) * 100)
  const issues = (validation?.checks || []).filter(c => !c.pass).map((c, i) => ({
    no: i + 1, level: c.id === '笔记字数' ? 'medium' : 'high', label: c.label,
    where: '自动校验', message: c.detail, quote: '', advisory: false, resolved: false,
  }))
  const pending = []
  if (!st.prep.scope) pending.push('边界与版本')
  if (clauses.length < (st.prep.map.total ? 1 : 0)) pending.push('拆条款')
  for (const step of st.plan.steps || []) {
    if (step.status === 'todo' && ['overview-chapter', 'overview-merge', 'reconcile', 'absorb', 'validate', 'quiz', 'exam', 'bind', 'commit'].includes(step.kind)) {
      pending.push(step.label)
      break
    }
  }
  const brief = {
    title: st.title,
    sourceChars: st.sourceChars,
    chapters: ledger?.chapters?.length || 0,
    sections: ledger?.stats?.segments || 0,
    clauses: { total: (st.prep.map.clauses || []).length, qualified: clauses.length, rate: (st.prep.map.clauses || []).length ? Math.round((clauses.length / st.prep.map.clauses.length) * 100) : 0 },
    packChars: clauses.reduce((n, c) => n + countChars(c.action) + countChars(c.source), 0),
    coverage: coverage ? { covered: coverage.covered, total: coverage.total, missing: (coverage.missing || []).slice(0, 8) } : null,
    notesChars: st.study.effectiveChars || 0,
    ratio: st.study.ratio || 0,
    study: { parts: absorbSteps.length, failedParts: absorbSteps.filter(s => s.status === 'failed').length, points: points.length },
    exam: {
      questions: (st.quiz.questions || []).length,
      target: st.quiz.target || 0,
      avg: st.exam.passRate == null ? null : Math.round(st.exam.passRate * 100),
      passLine,
      sampled: st.exam.total || 0,
      passed: st.exam.passed || 0,
      round: st.exam.round || 0,
    },
    synthesis: st.synthesis
      ? {
        summary: st.synthesis.summary,
        threads: st.synthesis.threads.length,
        relations: st.synthesis.relations.length,
        conflicts: st.synthesis.conflicts.length,
        corrections: st.synthesis.corrections.length,
        gaps: st.synthesis.gaps.length,
      }
      : null,
    overview: st.overview?.frame
      ? {
        summary: st.overview.frame.summary,
        terms: st.overview.frame.terms.length,
        threads: st.overview.frame.threads.length,
        doubts: st.overview.frame.doubts.length,
      }
      : null,
    classNotes: (st.classNotes || []).length,
    audit: {
      status: validation ? (validation.pass ? 'passed' : 'needs_review') : '',
      total: validation?.checks?.length || 0,
      hard: issues.length,
      high: issues.filter(i => i.level === 'high').length,
      advisory: 0,
      resolved: 0,
    },
    pending,
    scope: st.prep.scope
      ? { appliesTo: (st.prep.scope.applies_to || []).slice(0, 6), version: st.prep.scope.version, effectiveDate: st.prep.scope.effective_date, mandatory: (st.prep.scope.mandatory || []).join('；').slice(0, 200) }
      : null,
    plan,
    review: st.review ? { approved: st.review.approved, noteHash: st.review.noteHash, at: st.review.at, report: st.review.report } : null,
    validation: validation
      ? { pass: validation.pass, round: validation.round, checks: validation.checks, missingTokens: validation.missingTokens, ratio: validation.ratio, tokensTotal: validation.tokensTotal }
      : null,
  }
  return {
    schema: SCHEMA,
    stage: st.stage,
    stageLabel: STAGE_LABELS(st.stage),
    sourceFile: st.sourceFile ? { name: st.sourceFile.name, bytes: st.sourceFile.bytes, sha256: st.sourceFile.sha256, error: st.sourceFile.error || '' } : null,
    sourceVersion: st.sourceVersion || 1,
    sourceChange: st.sourceChange || null,
    previous: st.previous || null,
    progress: st.progress ? { key: st.progress.key, label: st.progress.label, at: st.progress.at } : null,
    activity: (st.activity || []).slice(-14).map(a => ({
      id: a.id, key: a.key, label: a.label, detail: a.detail || '', tag: a.tag || '',
      at: a.at, doneAt: a.doneAt || '', status: a.status, ms: a.ms == null ? null : a.ms, result: a.result || '',
    })),
    title: st.title,
    sourceChars: st.sourceChars,
    sourceHash: (st.sourceHash || '').slice(0, 12),
    chapters: ledger?.chapters?.length || 0,
    sections: ledger?.stats?.segments || 0,
    density: st.density,
    scope: st.prep.scope
      ? {
        appliesTo: st.prep.scope.applies_to || [],
        version: st.prep.scope.version || '',
        effectiveDate: st.prep.scope.effective_date || '',
        mandatory: (st.prep.scope.mandatory || []).join('；'),
        origin: st.prep.scope.origin || '',
      }
      : null,
    prep: {
      scope: Boolean(st.prep.scope),
      map: clauses.length,
      clauses: { total: (st.prep.map.clauses || []).length, qualified: clauses.length, thin: 0, rate: 100 },
      chaptersDone: st.prep.map.done,
      chaptersTotal: st.prep.map.total,
      fallbackChapters: 0,
      pack: Boolean(st.prep.scope) && st.prep.map.done === st.prep.map.total,
      questions: questions.length,
      auditStatus: validation ? (validation.pass ? 'passed' : 'needs_review') : '',
      auditGate: '',
      gateBlocked: false,
      gateRounds: 0,
      auditHigh: issues.filter(i => i.level === 'high').length,
      auditHard: issues.length,
      auditAdvisory: 0,
      auditTotal: validation?.checks?.length || 0,
      auditResolved: 0,
      pending,
    },
    study: {
      partsDone: absorbDone,
      partsTotal: absorbSteps.length,
      points: points.length,
      unresolved: st.doubts.filter(d => !d.answer).length,
      coverage: coverage ? `${coverage.covered}/${coverage.total}` : '',
      loops: st.study.repairs || 0,
      focus: '',
      ratio: st.study.ratio || 0,
      effectiveChars: st.study.effectiveChars || 0,
    },
    clarify: { total: st.doubts.length, answered: st.doubts.filter(d => d.answer).length },
    exam: {
      asked: (st.exam.results || []).length,
      answered: (st.exam.results || []).length,
      total: st.exam.total || Math.min(Number(cfg.examSample) || 20, (st.quiz.questions || []).length),
      avg: st.exam.passRate == null ? null : Math.round(st.exam.passRate * 100),
      round: st.exam.round || 1,
      bank: (st.quiz.questions || []).length,
      target: st.quiz.target || 0,
      passed: st.exam.passed || 0,
      passRate: st.exam.passRate,
      recallHeavy: (st.quiz.questions || []).filter(q => q.recall).length * 2 > (st.quiz.questions || []).length,
      gaps: (st.exam.results || []).filter(item => !item.passed).map(item => item.gap).filter(Boolean).slice(0, 5),
      passLine,
      questions: (st.exam.sample || []).map((questionId, index) => {
        const question = (st.quiz.questions || []).find(item => item.id === questionId) || {}
        const result = (st.exam.results || []).find(item => item.id === questionId) || null
        return {
          no: index + 1, q: question.q || '', score: result?.score ?? null, gap: result?.gap || '',
          angle: question.angle || '', pointId: question.clause || '', recall: Boolean(question.recall), origin: question.chapter || '',
        }
      }),
    },
    synthesis: st.synthesis
      ? {
        summary: st.synthesis.summary,
        threads: st.synthesis.threads,
        relations: st.synthesis.relations,
        conflicts: st.synthesis.conflicts,
        corrections: st.synthesis.corrections,
        gaps: st.synthesis.gaps,
      }
      : null,
    overview: st.overview?.frame || null,
    classNotes: (st.classNotes || []).slice(-10),
    said: st.saidStats || null,
    pendingCorrections: (st.pendingCorrections || []).filter(item => item.status === 'pending'),
    canDecide: st.stage === 'review',
    finished: st.stage === 'finished',
    auditIssues: issues,
    corrections: (st.corrections || []).length,
    regression: { asked: 0, passed: 0 },
    brief,
    plan,
    review: brief.review,
    validation: brief.validation,
    doubts: st.doubts.map(d => ({ q: d.q, answer: d.answer || '', chunk: d.chunk })),
    questions,
    commit: st.commit,
    errors: (st.errors || []).slice(-5),
    updatedAt: st.updatedAt,
  }
}

/* ------------------------------------------------------------ 开课入口（兼容旧名） */

export async function openV2(stateRoot, options) {
  return openTeaching(stateRoot, options)
}

/* ------------------------------------------------------------ 自检 */

function fakeLedgerSource() {
  return [
    '# 第 1 章 抽样',
    '1.1 抽样比例：每批抽 5%，不足 20 件时改为全检。',
    '1.2 复检：被拒收的批次可申请一次复检，复检比例为 10%。',
    '',
    '# 第 2 章 判定',
    '2.1 不合格判定：抽检发现 1 件不合格即整批拒收。',
    '2.2 记录：检验记录保存三年，到期由质量部销毁。',
    '',
    '| 序号 | 字段 | 要求 |',
    '| --- | --- | --- |',
    '| 1 | 工程编号 | 按立项号填写，等线 22 号 |',
  ].join('\n')
}

function fakeChat(box) {
  return async ({ system, prompt }) => {
    box.calls.push({ system: system.slice(0, 60), prompt: prompt.slice(0, 40) })
    const json = value => JSON.stringify(value)
    if (/【任务?[:：]?边界|你是这门课的教务/.test(system)) {
      return json({
        applies_to: ['整机检验'], version: 'A1', effective_date: '2026-01-01', supersedes: '',
        mandatory: ['第 1 章：抽样必须按 5% 执行', '第 2 章：1 件不合格整批拒收'],
        recommended: ['附录 A'], terms: [{ term: '批', meaning: '同一投料批' }],
      })
    }
    if (/你是课程设计者|课程设计者/.test(system) && /条款/.test(system)) {
      const pairs = [...prompt.matchAll(/⟦(S\d+)⟧\s*([^\n]+)/g)].map(m => ({ id: m[1], text: m[2].trim() }))
      const find = text => (pairs.find(p => normalize(p.text).includes(normalize(text))) || pairs[0] || {}).id
      return json({
        modules: [{ id: 'M1', title: '抽样与判定' }],
        clauses: [
          { id: 'K1', title: '抽样比例', trigger: '每批检验时', action: '抽 5%，不足 20 件全检', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。', segments: [find('抽样比例：每批抽 5%')] },
          { id: 'K2', title: '复检', trigger: '被拒收时', action: '可申请一次复检，比例 10%', source: '复检比例为 10%。', segments: [find('复检比例为 10%')] },
          { id: 'K3', title: '不合格判定', trigger: '抽检不合格时', action: '1 件即整批拒收', source: '抽检发现 1 件不合格即整批拒收。', segments: [find('1 件不合格即整批拒收')] },
          { id: 'K4', title: '记录保存', trigger: '归档时', action: '保存三年', source: '检验记录保存三年，到期由质量部销毁。', segments: [find('检验记录保存三年')] },
        ],
      })
    }
    if (/上一轮这些条款的原文依据对不上/.test(system)) return json({ clauses: [] })
    if (/上一轮这段精读没过校验|只补不足/.test(system)) {
      const pairs = [...prompt.matchAll(/⟦(S\d+)⟧\s*([^\n]+)/g)].map(m => ({ id: m[1], text: m[2].trim() }))
      const uniq = new Map(pairs.map(p => [p.id, p.text]))
      return json({ points: [...uniq.entries()].map(([id, text], i) => detailed(id, `补写要点 ${i + 1}`, text, i)), doubts: [] })
    }
    if (/你是替智能助理精读这份资料的学员/.test(system)) {
      const pairs = [...prompt.matchAll(/⟦(S\d+)⟧\s*([^\n]+)/g)].map(m => ({ id: m[1], text: m[2].trim() }))
      const uniq = new Map(pairs.map(p => [p.id, p.text]))
      const doubts = box.doubtOnce && !box.doubtServed ? ['复检和抽检能否同时做？'] : []
      box.doubtServed = true
      return json({ points: [...uniq.entries()].map(([id, text], i) => detailed(id, `要点 ${i + 1}`, text, i)), doubts })
    }
    if (/只依据这段原文回答|教授/.test(system) && /学员问题/.test(system)) {
      return '原文只写了复检一次，没写能否同时做，这条我等助教确认。'
    }
    if (/【任务:通读本章】/.test(system)) {
      const chapter = (prompt.match(/本章：(C\d+)/) || [])[1] || 'C01'
      return json({
        digest: `第 ${chapter} 章讲抽样与判定的一段规则，和其他章有前后依赖。`,
        terms: [{ term: '批', meaning: '同一投料批为一批' }, { term: '复检', meaning: '被拒收后重新检验一次' }],
        relations: [{ target: '第 2 章 判定', type: 'depends', text: '先抽样才有判定' }],
        doubts: ['原文没写复检与抽检能否同时做'],
      })
    }
    if (/【任务:全文框架】/.test(system)) {
      const chapters = [...new Set([...prompt.matchAll(/【(C\d+) /g)].map(match => match[1]))]
      return json({
        summary: '这份规范讲抽样、判定、复检与记录保存，四块前后衔接。',
        terms: [{ term: '批', meaning: '同一投料批为一批', chapters }],
        threads: [
          { name: '判定主线', chapters, text: '抽样发现不合格 → 判定整批拒收 → 可申请一次复检。' },
          { name: '记录主线', chapters, text: '检验记录随判定一起归档，保存三年。' },
        ],
        relations: [{ from: chapters[0] || 'C01', to: chapters[1] || 'C02', type: 'depends', text: '判定依赖抽样结果' }],
        doubts: ['复检与抽检能否同时做，原文没写'],
      })
    }
    if (/【任务:综合核对】/.test(system)) {
      const chapters = [...new Set([...prompt.matchAll(/(C\d{2})/g)].map(match => match[1]))]
      const clauseIds = [...new Set([...prompt.matchAll(/^(K\d+)｜/gm)].map(match => match[1]))]
      return json({
        summary: '综合核对后：抽样、判定、复检、记录保存是一条完整链，记录是判定结果的载体。',
        threads: [
          { name: '判定主线', chapters, clauses: clauseIds.slice(0, 2), text: '抽样发现不合格 → 判定整批拒收 → 可申请一次复检。' },
          { name: '责任链', chapters, clauses: clauseIds.slice(2), text: '抽检由检验岗执行，记录由质量部归档。' },
        ],
        relations: clauseIds.length >= 2
          ? [{ from: clauseIds[0], to: clauseIds[1], type: 'prerequisite', text: '先抽样才有复检' }]
          : [],
        conflicts: [{ clauses: clauseIds.slice(0, 1), text: '原文没写复检与抽检能否同时做', quote: '被拒收的批次可申请一次复检，复检比例为 10%。' }],
        gaps: [{ text: '原文没写记录保存的起算日期', quote: '检验记录保存三年，到期由质量部销毁。' }],
        corrections: [{ was: '初读以为记录与判定无关', now: '记录是判定结果的载体，必须同步归档', quote: '检验记录保存三年，到期由质量部销毁。' }],
      })
    }
    if (/题库目标是/.test(system)) {
      box.quizRound = (box.quizRound || 0) + 1
      const chapter = (prompt.match(/章节：(C\d+)/) || [])[1] || 'C01'
      const count = Number((prompt.match(/本批要 (\d+) 道题/) || [])[1] || 2)
      const pairs = [...prompt.matchAll(/⟦(S\d+)⟧\s*([^\n]+)/g)].map(match => ({ id: match[1], text: match[2].trim() }))
      const questions = Array.from({ length: count }, (_, index) => {
        const pair = pairs[(index + box.quizRound) % Math.max(1, pairs.length)] || { id: 'S0001', text: '原文片段' }
        return {
          clause: '',
          chapter,
          angle: index % 2 === 0 ? '判定边界' : '数据口径',
          q: `第 ${box.quizRound} 批情形 ${index + 1}：一批 18 件要检验，按「${pair.text.slice(0, 12)}」该怎么处理？`,
          answer_contains: pair.text.slice(0, 60),
          segments: [pair.id],
          rubric: ['结论', '依据'],
        }
      })
      return json({ questions })
    }
    if (/你是这门课的学员，正在闭卷抽考/.test(system)) {
      return json({
        conclusion: '每批抽 5%，不足 20 件时改为全检；发现 1 件不合格整批拒收；被拒收可申请一次复检，复检比例 10%；'
          + '检验记录保存三年；字体用等线 12 号，抬头 22 号。',
        basis: '笔记里的抽样、拒收、复检、记录与字体条款',
        unsure: '',
      })
    }
    if (/一次性判完同一份闭卷抽考/.test(system)) {
      const ids = [...new Set([...prompt.matchAll(/【(Q\d+)】/g)].map(match => match[1]))]
      return json({
        results: ids.map(id => ({ id, score: 92, passed: true, comment: '结论与依据都对上了。', gap: '', correct: '' })),
      })
    }
    if (/学员是闭卷作答/.test(system)) {
      return json({ score: 92, passed: true, comment: '结论与依据都对上了。', gap: '', correct: '' })
    }
    throw new Error(`fake chat 未匹配：${system.slice(0, 30)}`)
  }
}

function detailed(segId, title, quote, index = 0) {
  // 每条说法都要有差异，否则「套话重复」这条质量检查会（正确地）把它判掉
  const variants = [
    '这条规则在原文对应片段里写清了适用范围与例外，照原文执行不会出错，但要特别注意数值口径与责任人，记录里必须能对上原文；遇到前后不一致时先停下来核对原文，不要凭印象处理。',
    '这一条换到实际场景里就是一道判断题：先确认当前情形是否落在适用范围内，再按原文给出的比例或时限取值；一旦超出范围就停下来问，不要自己放宽标准，也不要拿别的产品的情形套过来。',
    '把它和相邻条款连起来看更清楚：前面一条负责定标准，这一条负责在出现异常时怎么处置，处置完还要留下可追溯的记录；三步缺一步，事后就说不清当时为什么这么判。',
    '最容易出问题的是口径不一致：同一个量在不同表里写法不同，遇到这种情况以原文的写法为准，不要自己换算、四舍五入或者顺手补全，补出来的数字以后没人能追溯。',
    '判断是否照做的依据不在口头上，而在记录上：谁做的、什么时候做的、按什么标准做的，三样都能对上才算合规；缺任何一样，最终都会变成责任说不清。',
  ]
  const closings = [
    '落到这一条上，先看情形是否属于它管的那一段，再决定取值与责任人。',
    '把这一条单独拿出来做判断题时，答案必须能同时在原文里找到落点。',
    '这一条真正要防的是「按习惯做」而不是「按原文做」，所以记录必须写清依据。',
  ]
  const filler = `${variants[index % variants.length]}关于「${title}」：${closings[index % closings.length]}`
  return {
    id: `P-${segId}`,
    segments: [segId],
    quote: String(quote || boxQuote[segId] || '').slice(0, 120),
    title,
    explain: filler,
    conditions: `本条只在原文写明的情形下适用；${title} 一旦超出这个情形，先回原文确认边界再决定。`,
    exceptions: '原文写明例外时按例外处理，没有写明就不要自行放宽；拿不准就记下来问助教。',
    criteria: '记录、数值、责任人与原文逐项对上才算合规，任何一项缺失都按不合规处理。',
    example: '例如一批 18 件时，按原文口径应当改为全检，而不是继续按比例抽。',
    misconception: '最容易错的是把比例套到不足 20 件的情形上。',
  }
}

const boxQuote = {
  S0001: '抽样比例：每批抽 5%，不足 20 件时改为全检。',
  S0002: '复检比例为 10%。',
  S0003: '抽检发现 1 件不合格即整批拒收。',
  S0004: '检验记录保存三年，到期由质量部销毁。',
  S0005: '按立项号填写，等线 22 号',
}

async function runSelftest() {
  let passed = 0
  const failures = []
  const check = (label, ok, extra = '') => {
    if (ok) passed++
    else failures.push(label)
    if (process.env.ENGINE_VERBOSE || !ok) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  }
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'dsh-engine-'))
  const box = { calls: [], doubtOnce: true }
  const chat = fakeChat(box)
  const cfg = { chunkChars: 200, concurrentChunks: 1, maxRepairRounds: 2, enableManualReview: true, noteRatioTarget: 2, examSample: 4, passThreshold: 0.75 }
  const commits = []
  const deps = { commit: async input => { commits.push(input); return { ok: true, summary: '入库成功（演练）', learnedPath: 'x' } } }
  try {
    const { openClassroom } = await import('./classroom.js')
    const room = await openClassroom(root, { id: 'class-engine-test', title: '抽样检验规范' })
    check('课堂已开', Boolean(room.classroom.id))
    let threw = false
    try { await openTeaching(root, { id: 'class-engine-test', cfg }) } catch { threw = true }
    check('没有原文不许开课', threw)

    const opened = await openTeaching(root, { id: 'class-engine-test', title: '抽样检验规范', source: fakeLedgerSource(), sourceName: 'fixture.md', cfg })
    check('开课切出片段账本', opened.teaching.sections > 5, `segments=${opened.teaching.sections}`)
    // 数量型问题的检索：问「几大类」必须找到原文的「六大类」，不能答「原文没有规定」
    {
      const countingLedger = buildLedger('# 分类\n系统BOM按物料大类汇总整机所需的一级物料，涵盖电子类、结构类、装配线材类、包材及附件类、螺丝类、背胶及辅料类六大类。')
      const countingEvidence = retrieveEvidence(countingLedger, '整机BOM有几大类部件')
      const countingAnswer = composeGroundedAnswer(countingEvidence)
      check('数量型问题能找到「六大类」并给出引用',
        countingAnswer.text.includes('六大类') && countingAnswer.citations.length > 0,
        countingAnswer.text.slice(0, 80))
    }
    check('高密度判定生效', opened.teaching.density.high === true, opened.teaching.density.reason)
    check('计划按顺序排好', opened.teaching.plan.steps > 6 && opened.teaching.plan.current.kind === 'scope')

    let guard = 0
    let state = opened.teaching
    let reviewSeen = false
    let lastNote = ''
    let lastBlocked = null
    while (guard++ < 60) {
      const out = await advance(root, { id: 'class-engine-test', chat, cfg, deps })
      state = out.state
      lastNote = out.note || lastNote
      if (out.blocked) { lastBlocked = out.blocked; break }
      if (state.stage === 'review') { reviewSeen = true; break }
      if (state.stage === 'finished') break
    }
    check('自动校验通过后停在人工复核', reviewSeen && state.stage === 'review', `stage=${state.stage} blocked=${JSON.stringify(lastBlocked)} note=${lastNote}`)
    const quizCalls = box.calls.filter(c => /题库目标/.test(c.system)).length
    const examCalls = box.calls.filter(c => /闭卷抽考|闭卷作答/.test(c.system)).length
    check('题库按原文密度出、抽考在复核之前', quizCalls > 0 && examCalls > 0, `quiz=${quizCalls} exam=${examCalls}`)
    check('复核前不入库', commits.length === 0, `commits=${commits.length}`)
    check('抽考有通过率与样题数', Boolean(state.review?.report?.exam?.sampled) && state.review.report.exam.passRate >= 0.75,
      JSON.stringify(state.review?.report?.exam || null))
    check('全文理解进了复核报告', Boolean(state.review?.report?.synthesis?.threads), JSON.stringify(state.review?.report?.synthesis || null))
    check('先通读建框架，框架进了复核报告', Boolean(state.review?.report?.overview?.threads), JSON.stringify(state.review?.report?.overview || null))
    check('通读后的疑点也先答一轮（两轮答疑都完成）',
      state.plan.kinds?.clarify?.total === 2 && (state.plan.kinds?.clarify?.done || 0) === 2,
      JSON.stringify(state.plan.kinds?.clarify || null))
    check('复核报告里有逐片字数账',
      Array.isArray(state.review?.report?.chunks) && state.review.report.chunks.length > 0
      && state.review.report.chunks.every(item => item.sourceChars > 0 && item.ratio > 0 && item.points > 0),
      JSON.stringify(state.review?.report?.chunks || null).slice(0, 160))
    check('校验报告随复核一起给出', Boolean(state.review?.report?.checks?.length))
    check('笔记字数比达标', state.review.report.ratio >= 2, `ratio=${state.review.report.ratio}`)
    check('疑点已自动答完', state.study.unresolved === 0, `unresolved=${state.study.unresolved}`)

    // 复核前推进也不会越过
    const again = await advance(root, { id: 'class-engine-test', chat, cfg, deps })
    check('复核未批时不再推进', again.needUser === true && again.state.stage === 'review')

    // 复核意见：先退回一次，再通过
    const rejected = await reviewDecision(root, { id: 'class-engine-test', approve: false, comment: '复检那一条要写清只能一次，再补一句例外。', cfg })
    check('退回后重新进入精读', rejected.teaching.stage === 'study', rejected.teaching.stage)
    for (let i = 0; i < 40 && rejected.teaching.stage !== 'review'; i++) {
      const out = await advance(root, { id: 'class-engine-test', chat, cfg, deps })
      if (out.blocked) break
    }
    const beforeApprove = await teachingState(root, 'class-engine-test', cfg)
    const approved = await reviewDecision(root, { id: 'class-engine-test', approve: true, comment: '可以', cfg })
    check('复核通过进入出题', approved.teaching.stage === 'exam', approved.teaching.stage)
    check('通过时记下笔记哈希', Boolean(approved.teaching.review?.noteHash), beforeApprove.review?.noteHash)

    let final = approved.teaching
    for (let i = 0; i < 40 && final.stage !== 'finished'; i++) {
      const out = await advance(root, { id: 'class-engine-test', chat, cfg, deps })
      final = out.state
      if (out.blocked) break
    }
    check('出题、绑定、入库自动完成', final.stage === 'finished', `stage=${final.stage}`)
    const paperSt = { title: '样例规范', sourceName: 'f.md', sourceHash: 'a'.repeat(64), prep: { scope: { version: 'A1' } }, quiz: { questions: [{ id: 'Q1', clause: 'K1', angle: '判定边界', q: '一批 18 件怎么抽？', answer_contains: '不足 20 件时改为全检', segments: ['S0001'], highRisk: true, rubric: ['结论'] }] } }
    check('题库可导出人员考核试卷与答案册', renderExamPaper(paperSt).includes('答题区') && renderAnswerKey(paperSt).includes('判分关键词'))
    check('题库达到密度目标（约每 100 字一题）', (final.exam?.bank || 0) >= (final.exam?.target || 0) && (final.exam?.bank || 0) >= 8,
      `bank=${final.exam?.bank} target=${final.exam?.target}`)
    check('题目绑定片段', final.questions.every(q => (q.segments || []).length > 0))
    check('入库调用了交付模块', commits.length === 1, `commits=${commits.length}`)
    check('入库带原文封条', Boolean(commits[0]?.state?.sourceHash))

    // 复核后改笔记 -> 通过作废（直接改文件模拟）
    const dir = join(root, 'classrooms', 'class-engine-test')
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises')
    const notesPath = join(dir, 'notes-final.md')
    await wf(notesPath, `${await rf(notesPath, 'utf8')}\n改了一行\n`, 'utf8')
    const tampered = await reviewDecision(root, { id: 'class-engine-test', approve: true, comment: 'x', cfg }).catch(error => error)
    check('复核后笔记被改则通过失效', tampered instanceof Error || tampered?.teaching?.stage === 'exam')

    // 并发/断点：doing 步骤会被退回待跑
    const doneBefore = final.plan.done
    const stPath = join(dir, 'teaching.json')
    const st = JSON.parse(await rf(stPath, 'utf8'))
    st.plan.steps[0].status = 'doing'
    st.progress = { key: 'x', label: 'x', at: new Date().toISOString() }
    // 只有状态文件确实陈旧（进程真的没了）才允许恢复；这里把时间拨回 20 分钟
    st.updatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    await wf(stPath, JSON.stringify(st, null, 2), 'utf8')
    const recovered = await teachingState(root, 'class-engine-test', cfg)
    check('中断后把「正在跑」退回待跑', recovered.progress === null && recovered.plan.done === doneBefore - 1,
      `progress=${JSON.stringify(recovered.progress)} done=${recovered.plan.done}/${doneBefore}`)
    // 反过来：状态刚写过（说明有人在跑），查看不应把正在跑的步骤踢回待跑
    const live = JSON.parse(await rf(stPath, 'utf8'))
    live.plan.steps[0].status = 'doing'
    live.progress = { key: 'y', label: 'y', at: new Date().toISOString() }
    live.updatedAt = new Date().toISOString()
    await wf(stPath, JSON.stringify(live, null, 2), 'utf8')
    const peeked = await teachingState(root, 'class-engine-test', cfg)
    check('正在跑的时候只读查看不改状态', peeked.progress?.key === 'y', JSON.stringify(peeked.progress))

    // 课堂问答：没有原文依据的问题必须答「没规定」，有依据的必须带引用
    const askLedger = buildLedger([
      '# 第 1 章 抽样',
      '1.1 抽样比例：每批抽 5%，不足 20 件时改为全检。',
      '1.2 记录：检验记录保存三年，到期由质量部销毁。',
      '1.3 字体：全文采用等线字体、字号 12 号。',
    ].join('\n'))
    const absent = composeGroundedAnswer(retrieveEvidence(askLedger, '附件物料一定是红色字体吗'))
    const ledgerIds = new Set(askLedger.segments.map(segment => segment.id))
    check('没有依据的问题答「原文没规定」',
      /没有规定/.test(absent.text) && !/规定[^。]{0,10}红色字体(必须|应当|要)/.test(absent.text)
      && absent.citations.every(id => ledgerIds.has(id)),
      absent.text.slice(0, 60))
    const present = composeGroundedAnswer(retrieveEvidence(askLedger, '检验记录保存几年'))
    check('有依据的问题带回原文引用', present.text.includes('三年') && present.citations.length >= 1,
      present.text.slice(0, 60))
    const partial = composeGroundedAnswer(retrieveEvidence(askLedger, '红色字体的字号是多少'))
    check('一半有依据时既给依据也说明没规定', /没有规定/.test(partial.text) && partial.citations.length >= 1,
      partial.text.slice(0, 80))

    // 更正提案：登记不动笔记；用户采纳才回退、作废复核、重走闸门
    const filed = await fileCorrection(root, {
      id: 'class-engine-test',
      text: '复检比例应为 10%，不是 5%',
      evidence: '被拒收的批次可申请一次复检，复检比例为 10%。',
      origin: 'selftest',
    })
    const pendingState = await teachingState(root, 'class-engine-test', cfg)
    check('更正先登记为待确认、不动笔记',
      filed.correction.status === 'pending' && (pendingState.pendingCorrections || []).length >= 1
      && pendingState.review?.report?.synthesis !== undefined,
      `status=${filed.correction.status}`)
    const decided = await decideCorrection(root, { id: 'class-engine-test', correctionId: filed.correction.id, accept: true })
    const afterFix = await teachingState(root, 'class-engine-test', cfg)
    check('采纳更正：作废复核并退回重学',
      decided.stage === 'study' && afterFix.stage === 'study' && !afterFix.canDecide
      && (afterFix.plan.kinds?.review?.done || 0) === 0,
      `stage=${afterFix.stage}`)

    console.log(`\n学习引擎自检：${passed} 项通过，${failures.length} 项失败`)
    for (const f of failures) console.log(`  ✗ ${f}`)
    if (failures.length) process.exitCode = 1
    return { passed, failed: failures.length }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
  runSelftest().catch(error => { console.error(error); process.exitCode = 1 })
}
