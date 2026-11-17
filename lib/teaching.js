/**
 * 智能助理学院 — 课堂授课引擎。
 *
 * 课堂就是一个对话框。教授、学员、用户说的每一句都通过 classroom.js 追加进
 * `dialogue.jsonl`，课堂笔记随之全量重建。本模块负责的是「谁在什么阶段说什么」：
 *
 *   ready → prep（定边界与版本 → 拆可执行条款 → 出课程包与题库 → 独立审核；
 *                硬问题不过就停在 prep，等用户点头或指出怎么改）
 *         → study（学员按原文分段自学，逐段落盘、覆盖账本、断点续学）
 *         → clarify（学员提出没弄懂的问题，教授先答）
 *         → exam（逐题问答，判分、讲评、纠错回流笔记）
 *         → confirm（用户确认结课；不结课就带着意见再学一轮）
 *         → finished
 *
 * 三条硬规矩，都是从真实跑过的参考实现里学来的反向教训：
 * 1) 不再逐章写「全文备课笔记」：学员读的是原文与课程包，那份笔记没有消费者，
 *    真正要保真的东西（原文依据、判分关键词、章节覆盖、表格）由审核逐字比对；
 * 2) 只有确定性检查（原文依据能不能逐字找到、章节覆盖、判分关键词）能阻断，
 *    模型审读的意见一律标 advisory，不写「通过」；
 * 3) 每一步都落盘，中断后从断点续，不从头再来。
 *
 * 零依赖，模型调用可注入：
 *   node lib/teaching.js --selftest
 */

import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { appendMessage, classroomsRoot, getClassroom } from './classroom.js'

export const STAGES = Object.freeze(['ready', 'prep', 'study', 'clarify', 'exam', 'confirm', 'finished'])

const STAGE_LABEL = Object.freeze({
  ready: '等待开课', prep: '准备课程', study: '学员自学', clarify: '课堂答疑',
  exam: '当堂考核', confirm: '等您确认结课', finished: '已结课',
})

export const ANGLES = Object.freeze([
  '概念与定义', '流程与顺序', '判定边界', '数据口径', '责任划分', '反例与常见错法',
])

const LIMITS = Object.freeze({
  maxChapters: 12,
  chapterChars: 9000,
  partChars: 1800,
  maxQuestions: 8,
  maxExamQuestions: 24,
  maxStudyLoops: 3,
  maxSourceChars: 60000,
})

export const PROMPTS = {
  map: '【任务:知识地图】你是课程设计者。把下面这份课件拆成一条条可执行的条款，不是按字数切块。\n'
    + '只输出 JSON，不要解释：\n'
    + '{"modules":[{"id":"M1","title":"模块名"}],'
    + '"points":[{"id":"K1","module":"M1","title":"条款名",'
    + '"type":"definition|rule|process|boundary|mistake|example",'
    + '"trigger":"什么情况下适用，30 字内",'
    + '"role":"谁来做、谁审核，原文没写就留空",'
    + '"action":"必须做什么、禁止做什么",'
    + '"object":"对哪个物料、字段、工序或文件",'
    + '"params":"颜色、层级、数值、时限、格式，原文没写就留空",'
    + '"exception":"什么情况可以不这样做，没有就留空",'
    + '"criteria":"怎么算合规、怎么算不合规，没有就留空",'
    + '"summary":"这条例讲什么，50 字内","source":"课件里的一整句原话",'
    + '"prerequisites":["前置知识点 id"],"related":["相关知识点 id"],'
    + '"misconceptions":["最容易理解错的一点"]}]}\n'
    + '要求：一条知识点只讲一条独立规则，要能单独回答「遇到这个场景该怎么做」；'
    + '不要把一整段塞进一条，也不要拆成半句话（只有「某某是指……」这种不成条的）。'
    + 'trigger、action、source 三条必须有，其余字段原文没写就留空，不许拿常识补；'
    + '按学习顺序排列；每条的 source 必须能在课件原文里逐字找到；'
    + '知识点密度：原文每 150 字左右要出一条，每一节至少一条；'
    + '同一节里出现几个「必须/不得/比例/时限/责任人/例外」，就拆成几条，不许合并成一条；'
    + '一个条款只能落在它自己的那一节，不许把两节的规则混在一条里。'
    + '只输出本课件的条款，不许凑数、不许重复。',

  mapGap: '【任务:知识地图补漏】你是课程设计者。上一轮已经把这份课件拆成条款，但漏了东西。'
    + '现在只补漏，不重写：\n'
    + '1）下面列出的「已收录」条目一律不许再出现，哪怕换个说法也不行；\n'
    + '2）请把原文里还没被拆成条款的内容补出来，目标是本次再补 {need} 条以上；\n'
    + '3）优先补「已收录」里没提到的章节与条目，尤其是数值、比例、时限、责任人、例外、判定边界。\n'
    + '只输出 JSON，字段与上一轮完全一致：{"modules":[{"id","title"}],'
    + '"points":[{"id","module","title","type","trigger","role","action","object","params",'
    + '"exception","criteria","summary","source","misconceptions"}]}\n'
    + 'trigger、action、source 三条必须有，source 必须是原文原话；module 只能用下面已存在的模块 id。',

  scope: '【任务:边界与版本】你是这门课的教务。先把这份规范管什么、不管什么、是哪一版摘清楚，只摘原文写到的。\n'
    + '只输出 JSON，不要解释：\n'
    + '{"applies_to":["适用的产品/岗位/工序/场景"],"version":"版本号或版次",'
    + '"effective_date":"生效日期","supersedes":"替代了哪一版",'
    + '"mandatory":"哪些是强制条款（章节特征或原文措辞）",'
    + '"recommended":["哪些是推荐、示例或附录"],'
    + '"terms":[{"term":"术语或缩写","meaning":"原文给的解释"}]}\n'
    + '原文没写的字段写空字符串或空数组，绝对不要推断、不要拿常识补。'
    + '这一步是为了防止把「只适用某类产品」的条款套到所有产品上。',

  pack: '【任务:课程包】你是这门课的教授，已经通读全文并拆出可执行条款，现在产出上课用的提炼包。\n'
    + '只输出 JSON，不要解释：\n'
    + '{"overview":"这门课到底在讲什么，120 字内",'
    + '"teaching_order":["按学习顺序排列的章节标题"],'
    + '"focus_points":[{"point_id":"知识地图里的 id","title":"","why":"为什么是重点或难点","source":"原文原话"}],'
    + '"question_bank":[{"point_id":"","q":"考题","answer_contains":"判分时必须出现的原文关键词，用引号列出若干片段","angle":"考什么"}],'
    + '"common_misconceptions":["最容易学错的地方，必须能从原文找到纠正依据"]}\n'
    + '要求：只用原文内容，不编数字与规则；answer_contains 里的每个片段都必须是原文里逐字连续出现的一整段，'
    + '照抄原句，不许改词、不许把几个词用顿号拼起来冒充原句——审核是逐字比对的，拼出来的片段一律算判分词对不上原文。\n'
    + '题目情形必须落在本课的适用范围里（给你的边界与版本），不要拿别的产品、别的工序举例；'
    + '适用范围没写清的，题目就别自己假设一个。\n'
    + '出题标准（这一条最重要）：angle 只能取「概念与定义」「流程与顺序」「判定边界」「数据口径」「责任划分」「反例与常见错法」之一；'
    + '至少一半的题必须是用法题：题面给一个具体情形（具体型号、数量、工序或角色），让学员判断该怎么判、取什么值、该由谁做，'
    + '例如「某批跨两个工单共 18 件，按规范该怎么抽」，而不是「抽样的定义是什么」；'
    + '禁止「XX 的定义是什么」「XX 的作用是什么」「XX 包含哪些」这类背原文就能答的复述题，最多在概念类里留一条。\n'
    + '题量：本课条款不少，题库至少出 {need} 道题，尽量摊到不同模块与不同角度，同一知识点最多两题，不许反复问同一段原文；上限 28 道。',

  audit: '【任务:独立审读】你是独立教务审核员，不是教授本人。拿原文核对课程包，只找错、找漏、找超纲。\n'
    + '只输出 JSON：{"issues":[{"level":"high|medium|low","scope":"focus|question|coverage|claim",'
    + '"where":"错在第几条重点/第几题/哪一章","message":"具体问题，一句话说清错在哪",'
    + '"quote":"原文里的原句（能引就引，引不到就写缺哪段）"}]}\n'
    + '重点查：有没有原文找不到依据的断言；有没有把别的课或常识塞进来；章节有没有漏；'
    + '表格有没有被概括成一句话；同一规则前后是否矛盾；数值、单位、例外有没有抄错；'
    + '题目的判分关键词是否真在原文。\n'
    + '每条问题都要能让人指着说「第几条错了」，所以 where 和 quote 不能空着。'
    + '不要复述课程内容，不要写建议性套话。',

  fix: '【任务:按意见改课程包】你是这门课的教授。审核没过，教务指了问题，你只改被点到的地方，其余原样保留。\n'
    + '输出与原来完全相同的 JSON 结构：{"overview":"","teaching_order":[],'
    + '"focus_points":[{"point_id":"","title":"","why":"","source":""}],'
    + '"question_bank":[{"point_id":"","q":"","answer_contains":"","angle":""}],'
    + '"common_misconceptions":[]}\n'
    + '要求：\n'
    + '1. 被指出没有原文依据的条款或题目，要么补上原文原句，要么删掉，不许改写成一句仍然没依据的话；\n'
    + '2. answer_contains 必须是原文里逐字连续出现的一整段，不许用顿号把几个词拼起来；\n'
    + '3. 不许新增原文没有的规则、数字与型号；删题导致题量不足的，从还没考过的条款里补，仍然只依据原文。\n'
    + '只输出一个 JSON 对象，不要解释。',

  regress: '【任务:回归出题】助教在课上纠正过一条口径。你是教授，要出一道题考「是不是真的改过来了」，'
    + '下一轮必须考这道题。\n'
    + '只输出 JSON：{"q":"题目，写成具体情形，不许把正确答案写进题面",'
    + '"answer_contains":"判分时必须出现的原文关键词，用引号列出若干片段",'
    + '"angle":"判定边界|数据口径|流程与顺序|责任划分|反例与常见错法 之一"}\n'
    + '题面要像工作里真会遇到的判断，不要写「定义是什么」。答案必须落在原文依据里。',

  study: '【任务:学员自学】你是这门课的学员，岗位对口。现在给你的是这门课完整原文的第 {i}/{n} 部分，'
    + '不是摘要，必须逐条学完这一部分，不许跳步：\n'
    + '1）先列你实际读到的章节，标题按原文原样抄；\n'
    + '2）逐条拆知识点，每条写清「规则/口径」「适用条件」「例外或边界」「数值或责任」「原文依据」「易错点」；\n'
    + '3）原文依据必须是原文原话，找不到就放进 unresolved，不许拿常识补，也不许把别的课串进来；\n'
    + '4）标出没弄懂、或原文没写清的地方。\n'
    + '只输出 JSON：{"covered_sections":["..."],"points":[{"title":"","rule":"","conditions":"",'
    + '"exceptions":"","numbers":"","source":"","misconceptions":""}],"unresolved":["..."]}\n'
    + '宁可标 unresolved，也不许编。',

  answer: '【任务:学员作答】你是这门课的学员，正在课堂上被教授抽查。'
    + '只回答教授当前这一题，不出题、不点评教授、不反问，答完就停。\n'
    + '只依据给你的课件原文段落和你自己的笔记作答；课件里没有的就直说「课件里没写，我不敢编」。\n'
    + '先在内部把数字和条款对一遍。只输出 JSON：'
    + '{"conclusion":"一句话结论","basis":"课件里的依据，引用原文原话","unsure":"拿不准的地方，没有就空"}\n'
    + '不要输出思考过程，不要自我纠正，不要旁白。',

  teach: '【任务:教授提问】你是这门课的教授，只能问课件里有的东西，不许超纲。'
    + '一次只问一道题，这一题考「{angle}」。'
    + '问「你学会了吗」这类空话不算题。只输出问题本身，不编号，不解释。',

  grade: '【任务:教授判分】你是教授。先按课件规则自己把这道题算一遍，得出正确结论，'
    + '再拿学员的结论去比：结论错了就是错，不因为他说得自信就给分；'
    + '数字算错、条款张冠李戴、自己改口，都要扣分并指出。\n'
    + '压分规则（必须执行）：\n'
    + '1. 题目问的是具体情形，学员只把原文定义或规则复述一遍、没有就这个情形给出判断，最多 70 分；\n'
    + '2. 学员答案里出现原文没有的数值、条款号或结论，直接不及格，并在 correct 里给出原文口径；\n'
    + '3. 学员回避了题目里的关键数量、工序或角色，按缺项扣分，不要因为“大体对”给满分。\n'
    + '只输出 JSON：{"score":0 到 100 的整数,"passed":true 或 false,'
    + '"comment":"两句以内，点明对在哪、漏了哪","gap":"一句最关键的缺口，没有就空",'
    + '"correct":"答错时给出正确口径，直接说应该怎么判、怎么做，带课件条款原话；答对写空"}',

  restate: '【任务:学员复述】你是这门课的学员。用户（助教）刚在课堂上补充或纠正了一条。\n'
    + '先说这条落在本课哪个知识点、你原来哪里理解偏了、以后会怎么用，像跟助教接话一样自然，一到三句，'
    + '不要每次套三点，不要只说「收到」「记下」。\n'
    + '判断这条算不算本课内容，按下面的顺序：\n'
    + '1）如果给了「原文里有这一句」，说明原文能对上，这条就是本课口径，必须收下，并把你原来哪里记错说出来；\n'
    + '2）如果原文找不到对应，但说的是同类业务口径，也可以按本课补充处理，但要说明原文没这条；\n'
    + '3）只有当这条明确和原文冲突、或明显在讲别的课程别的事时，才说「这条不属于本课，我只当课外参考」。\n'
    + '不要重新自学，不要出题，也不要复述整段课件。',
}

/* ------------------------------------------------------------ utilities */

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

/** Strip punctuation/space so a quoted sentence can be matched to the source. */
export function norm(text) {
  return String(text || '').toLowerCase().replace(/[\s，。；：、！？,.;:!?"'“”‘’()（）[\]【】\-—_/\\|]+/g, '')
}

/**
 * Is this quote actually in the source? Whole-string match first, then any
 * long fragment, so "章节标题 + 正文" anchors are not judged as fabrication.
 */
export function supported(quote, sourceNorm) {
  const q = norm(quote)
  if (!q) return false
  if (q.includes(sourceNorm) || sourceNorm.includes(q)) return true
  const parts = String(quote || '').split(/[。；;\n]/).map(norm).filter(x => x.length >= 8)
  return parts.some(p => sourceNorm.includes(p))
}

/** Parse model JSON: whole body first, then fenced block. Never prefer a mermaid fence. */
export function jsonOf(raw) {
  const text = String(raw || '').trim()
  const attempt = body => {
    try {
      const v = JSON.parse(body)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch { return null }
  }
  const whole = attempt(text)
  if (whole) return whole
  for (const fence of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    const parsed = attempt(fence[1].trim())
    if (parsed) return parsed
  }
  // 模型常把思考写在 JSON 前后（有时还是英文的），所以按括号配平扫出所有顶层对象，
  // 从后往前找第一个能解析的：正文通常在思考之后。
  const candidates = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth += 1 }
    else if (c === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) { candidates.push(text.slice(start, i + 1)); start = -1 }
      if (depth < 0) depth = 0
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    const parsed = attempt(candidates[k])
    if (parsed && Object.keys(parsed).length) return parsed
  }
  return null
}

/* --------------------------------------------------------------- split */

/** All headings, used for the coverage ledger. Long sentences are not titles. */
export function sectionTitles(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  // 文档自己的大标题不是「章节」：只有唯一一个 H1 时把它当标题跳过，
  // 否则覆盖账本会永远缺一章「没读到标题」，学员读得再全也补不上。
  const h1Count = lines.filter(line => /^#\s+\S/.test(line.trim())).length
  let titleSkipped = false
  for (const line of lines) {
    const trimmed = line.trim()
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed)
    if (m && m[1].length === 1 && h1Count === 1 && !titleSkipped) { titleSkipped = true; continue }
    let title = m ? m[2] : ''
    if (!title && /^\d+(?:\.\d+)*\s+\S/.test(trimmed) && trimmed.length <= 40 && !/[。：:]/.test(trimmed)) {
      title = trimmed
    }
    if (title && !out.includes(title)) out.push(title.slice(0, 90))
  }
  return out
}

/** When the model gives no usable map, cut the source into labelled anchors. */
export function densityPoints(source, desired = 24) {
  const units = String(source || '').split(/(?<=[。；！？\n])/).map(x => x.trim()).filter(Boolean)
  const blocks = []
  let buf = ''
  for (const u of units) {
    if (buf && buf.length + u.length > 120) { blocks.push(buf.trim()); buf = '' }
    buf += u
  }
  if (buf.trim()) blocks.push(buf.trim())
  return blocks.slice(0, Math.max(1, desired)).map((block, i) => ({
    id: `K${i + 1}`,
    module: 'M1',
    title: block.replace(/[#*`]/g, '').split('\n')[0].slice(0, 40) || `原文要点 ${i + 1}`,
    type: 'rule',
    summary: block.slice(0, 120),
    source: block.slice(0, 200),
    misconceptions: [],
  }))
}

/**
 * Split the source into teaching chapters: top-level headings, tiny ones merged,
 * oversized ones cut at paragraph boundaries. Falls back to ~3000-char blocks.
 */
/** 表格各行的首列词：课程包提到其中任意一个，就算没有把整张表忽略。 */
export function tableKeysOf(text) {
  return [...String(text || '').matchAll(/\|\s*([^|\n]{1,24}?)\s*\|/g)]
    .map(m => m[1].trim())
    .filter(x => x && !/^[-:]+$/.test(x))
    .slice(0, 10)
}

export function splitChapters(text, maxChapters = LIMITS.maxChapters) {
  const src = String(text || '')
  const lines = src.split(/\r?\n/)
  const heads = []
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim())
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i })
  })
  let chapters = []
  if (heads.length) {
    const top = Math.min(...heads.map(h => h.level))
    const tops = heads.filter(h => h.level === top)
    tops.forEach((h, i) => {
      const end = i + 1 < tops.length ? tops[i + 1].line : lines.length
      const body = lines.slice(h.line, end).join('\n').trim()
      if (body) chapters.push({ title: h.title.slice(0, 90), text: body })
    })
  }
  if (!chapters.length) {
    let buf = ''
    for (const para of src.split(/\n{2,}/)) {
      if (buf && buf.length + para.length > 3000) { chapters.push({ title: `第 ${chapters.length + 1} 部分`, text: buf }); buf = '' }
      buf += para + '\n\n'
    }
    if (buf.trim()) chapters.push({ title: `第 ${chapters.length + 1} 部分`, text: buf.trim() })
  }
  // cut oversized chapters at paragraph boundaries (hard-split a single huge paragraph)
  const out = []
  for (const ch of chapters) {
    if (ch.text.length <= LIMITS.chapterChars) { out.push(ch); continue }
    let buf = ''
    let part = 1
    const push = text => {
      out.push({ title: part > 1 ? `${ch.title}（${part}）` : ch.title, text: text.trim() })
      part++
    }
    for (const para of ch.text.split(/\n{2,}/)) {
      if (para.length > LIMITS.chapterChars) {
        if (buf.trim()) { push(buf); buf = '' }
        for (let i = 0; i < para.length; i += LIMITS.chapterChars) {
          push(para.slice(i, i + LIMITS.chapterChars))
        }
        continue
      }
      if (buf && buf.length + para.length > LIMITS.chapterChars) { push(buf); buf = '' }
      buf += `${para}\n\n`
    }
    if (buf.trim()) push(buf)
  }
  // too many chapters for one class: group adjacent ones evenly
  if (out.length > maxChapters) {
    const size = Math.ceil(out.length / maxChapters)
    const grouped = []
    for (let i = 0; i < out.length; i += size) {
      const group = out.slice(i, i + size)
      grouped.push({
        title: `${group[0].title}（等 ${group.length} 章）`.slice(0, 90),
        text: group.map(g => g.text).join('\n\n'),
      })
    }
    return grouped.map((c, i) => ({ index: i + 1, ...c }))
  }
  return out.map((c, i) => ({ index: i + 1, title: c.title, text: c.text }))
}

/** Group chapters into ~1800-char study parts. */
export function studyParts(chapters) {
  const parts = []
  let cur = null
  for (const ch of chapters) {
    const body = String(ch.text == null ? '' : ch.text)
    if (!cur) cur = { titles: [ch.title], texts: [body], chars: body.length }
    else if (cur.chars + body.length <= LIMITS.partChars) {
      cur.titles.push(ch.title); cur.texts.push(body); cur.chars += body.length
    } else {
      parts.push(cur); cur = { titles: [ch.title], texts: [body], chars: body.length }
    }
    if (cur.chars >= LIMITS.partChars) { parts.push(cur); cur = null }
  }
  if (cur) parts.push(cur)
  return parts.map((p, i) => ({
    index: i + 1,
    titles: p.titles,
    text: p.texts.join('\n\n'),
    chars: p.chars,
  }))
}

/** Which source sections never appeared in the student's coverage list. */
export function coverageReport(titles, covered) {
  const seen = norm((covered || []).join(''))
  const missing = []
  const ok = []
  for (const t of titles || []) {
    if (!t) continue
    const key = norm(t)
    if (key && seen.includes(key)) ok.push(t)
    else missing.push(t)
  }
  return { total: (titles || []).length, covered: ok, missing }
}

/* ---------------------------------------------------------- model call */

/** 当前课堂目录：命中时把每次模型原始输出追加到 `_model-raw.jsonl`，出错可回溯。 */
let traceDir = ''

async function callModel(chat, { system, prompt, maxTokens = 2400, tries = 3, grow = false }) {
  if (typeof chat !== 'function') throw httpError('这个课堂没有可用的模型通道', 503)
  let last = null
  // 这个模型会先把预算花在推理上，预算给小了正文一个字都出不来。
  let budget = Math.max(maxTokens, 2000)
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const raw = await chat({ system, prompt, maxTokens: budget })
      const text = String((raw && typeof raw === 'object' ? raw.text : raw) || '').trim()
      const finish = raw && typeof raw === 'object' ? String(raw.finish || '') : ''
      // 原始输出留一份，解析不出来时能查是截断、是空、还是格式跑偏
      if (traceDir) {
        const tag = (String(system).match(/【任务:([^】]+)】/) || [])[1] || 'chat'
        const row = { at: new Date().toISOString(), tag, attempt, budget, finish, textChars: text.length, text }
        await appendFile(join(traceDir, '_model-raw.jsonl'), `${JSON.stringify(row)}\n`).catch(() => {})
      }
      if (!text) {
        if (attempt < tries) { budget = Math.min(24000, Math.round(budget * 1.6)); continue }
        throw new Error('模型只出了推理、没有正文，预算被推理吃掉了')
      }
      // A cut-off answer is not an answer: spend another try with a bigger budget
      // instead of accepting half a chapter or a half-written JSON.
      // `max-tokens` 是 dsh 的 FinishReason.kind，`length` 是旧适配器的叫法，两个都认。
      const cut = finish === 'length' || finish === 'max-tokens' || finish === 'reasoning-only'
      if (cut && attempt < tries) {
        budget = Math.min(24000, Math.round(budget * 1.8))
        continue
      }
      return { text, finish, truncated: cut }
    } catch (error) {
      last = error
      if (attempt < tries) await new Promise(r => setTimeout(r, 800 * attempt))
    }
  }
  throw new Error(`模型调用失败：${String(last?.message || last).slice(0, 160)}`)
}

/* --------------------------------------------------------------- state */

function freshState({ title, source, sourceName }) {
  return {
    version: 1,
    stage: 'ready',
    title,
    sourceName: sourceName || '',
    sourceChars: source.length,
    sourceHash: sha256(source),
    chapters: [],
    sections: [],
    prep: { scope: null, map: null, chapters: [], pack: null, audit: null, notesFile: '', packFile: '' },
    study: { parts: [], summary: null, history: [], loops: 0, focus: '', scoped: null },
    clarify: { questions: [], origins: [], answers: [], asked: 0 },
    exam: { questions: [], round: 1, avg: null, gaps: [], history: [], regression: { asked: 0, passed: 0 } },
    corrections: [],
    confirm: { at: '', decidedAt: '', agreed: null, comment: '' },
    notes: [],
    errors: [],
    updatedAt: new Date().toISOString(),
  }
}

async function loadState(stateRoot, id) {
  const st = await readJson(join(dirOf(stateRoot, id), 'teaching.json'), null)
  if (!st || typeof st !== 'object') throw httpError('这间课堂还没开课：先上传原文再进课堂', 409)
  // 老课堂的状态文件没有新字段，读出来补默认值，别让升级把它读崩
  st.sections = Array.isArray(st.sections) ? st.sections : []
  st.corrections = Array.isArray(st.corrections) ? st.corrections : []
  st.activity = Array.isArray(st.activity) ? st.activity : []
  st.prep = st.prep && typeof st.prep === 'object' ? st.prep : {}
  if (st.prep.scope === undefined) st.prep.scope = null
  st.study = st.study && typeof st.study === 'object' ? st.study : {}
  if (st.study.scoped === undefined) st.study.scoped = null
  st.exam = st.exam && typeof st.exam === 'object' ? st.exam : {}
  if (!st.exam.regression) st.exam.regression = { asked: 0, passed: 0 }
  return st
}

async function saveState(stateRoot, id, st) {
  st.updatedAt = new Date().toISOString()
  await atomicWrite(join(dirOf(stateRoot, id), 'teaching.json'), `${JSON.stringify(st, null, 2)}\n`)
}

async function say(stateRoot, id, payload) {
  return appendMessage(stateRoot, id, payload)
}

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0
}

/* ------------------------------------------------------------- render */

function renderStudentNotes(st) {
  const s = st.study
  const lines = [`# 学员研读笔记：${st.title}`, '',
    `> 学员读的是原文全文，分 ${s.parts.length} 段消化；每条都带原文依据，找不到依据的进「没弄懂」。`, '']
  const cov = s.summary?.coverage
  if (cov) {
    lines.push('## 覆盖账本', '',
      `原文标题目 ${cov.total} 个，读到 ${cov.covered.length} 个。`, '')
    if (cov.missing.length) lines.push(`未读到：${cov.missing.slice(0, 20).join('、')}`, '')
  }
  s.parts.forEach(part => {
    lines.push(`## 第 ${part.index} 段${part.titles?.length ? `：${part.titles.join('、')}` : ''}`, '')
    if (part.status !== 'done') { lines.push(`> 本段没学成：${part.error || '模型未产出有效知识点'}`, ''); return }
    ;(part.points || []).forEach((p, i) => {
      lines.push(`### ${part.index}.${i + 1} ${p.title || '未命名知识点'}`, '')
      for (const [label, key] of [['规则', 'rule'], ['条件', 'conditions'], ['边界/例外', 'exceptions'],
        ['数值/责任', 'numbers'], ['原文依据', 'source'], ['易错', 'misconceptions']]) {
        const v = String(p[key] || '').trim()
        if (v) lines.push(`- ${label}：${v}`)
      }
      lines.push('')
    })
    if ((part.unresolved || []).length) {
      lines.push('**本段没弄懂**', '')
      part.unresolved.forEach(q => lines.push(`- ${q}`))
      lines.push('')
    }
  })
  const fixes = (st.exam.questions || []).filter(q => q.score != null && q.score < 70 && (q.correct || q.gap))
  if (fixes.length) {
    lines.push('## 考核暴露的纠正', '')
    fixes.forEach(q => lines.push(`- 第 ${q.no} 题（${q.score} 分）：${q.correct || q.gap}`))
    lines.push('')
  }
  if ((s.history || []).length) {
    lines.push('## 历次重学', '')
    s.history.forEach(h => lines.push(`- 第 ${h.round} 轮：${h.summary}`))
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

function renderPack(st) {
  const pack = st.prep.pack || {}
  const lines = [`# 课程包：${st.title}`, '',
    String(pack.overview || ''), '',
    '## 教学顺序', '', ...(pack.teaching_order || []).map((t, i) => `${i + 1}. ${t}`), '',
    '## 重点', '']
  ;(pack.focus_points || []).forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.title || ''}`, '')
    if (f.why) lines.push(`- 为什么是重点：${f.why}`)
    if (f.source) lines.push(`- 原文依据：${f.source}`)
    lines.push('')
  })
  lines.push('## 题库', '')
  ;(pack.question_bank || []).forEach((q, i) => {
    lines.push(`${i + 1}. ${q.q || ''}`)
    if (q.angle) lines.push(`   - 角度：${q.angle}`)
    if (q.answer_contains) lines.push(`   - 判分关键词：${q.answer_contains}`)
  })
  lines.push('')
  if ((pack.common_misconceptions || []).length) {
    lines.push('## 常见误区', '', ...(pack.common_misconceptions || []).map(x => `- ${x}`), '')
  }
  return `${lines.join('\n').trim()}\n`
}

/* -------------------------------------------------------------- checks */

const LEVEL_LABEL = Object.freeze({ high: '高风险', medium: '中风险', low: '参考' })

/** 一条知识点算不算「可执行条款」：有原文句，且说清什么情况下做什么。 */
export function isClausePoint(p) {
  if (!p || !String(p.title || '').trim()) return false
  if (!String(p.source || '').trim()) return false
  return Boolean(String(p.trigger || '').trim() || String(p.action || '').trim())
}

export function clauseStats(points) {
  const list = Array.isArray(points) ? points : []
  const qualified = list.filter(isClausePoint).length
  return { total: list.length, qualified, thin: list.length - qualified, rate: list.length ? Math.round((qualified / list.length) * 100) : 0 }
}

/** 模型给的知识点原始 JSON，统一取值、裁长、补 id；首轮与补漏轮共用一份口径。 */
export function normalizeMapPoints(list) {
  return (Array.isArray(list) ? list : []).filter(p => p && p.title).slice(0, 240).map((p, i) => ({
    id: String(p.id || `K${i + 1}`).slice(0, 12),
    module: String(p.module || 'M1'),
    title: String(p.title).slice(0, 60),
    type: String(p.type || 'rule').slice(0, 12),
    trigger: String(p.trigger || '').slice(0, 120),
    role: String(p.role || '').slice(0, 60),
    action: String(p.action || '').slice(0, 200),
    object: String(p.object || '').slice(0, 60),
    params: String(p.params || '').slice(0, 120),
    exception: String(p.exception || '').slice(0, 160),
    criteria: String(p.criteria || '').slice(0, 120),
    summary: String(p.summary || '').slice(0, 160),
    source: String(p.source || '').slice(0, 240),
    misconceptions: (Array.isArray(p.misconceptions)
      ? p.misconceptions
      : (p.misconceptions ? [p.misconceptions] : [])).map(x => String(x).slice(0, 120)).slice(0, 4),
  }))
}

/** 补漏轮并回主表：按原文依据去重，落在不存在的模块就归第一个模块，有新增才统一重排 id。 */
export function mergeGapPoints(points, incoming, moduleIds = []) {
  const list = Array.isArray(points) ? points.slice() : []
  const ids = new Set(moduleIds.length ? moduleIds : list.map(p => p.module).filter(Boolean))
  const seen = new Set(list.map(p => norm(p.source).slice(0, 80)).filter(Boolean))
  let added = 0
  for (const p of normalizeMapPoints(incoming)) {
    const key = norm(p.source).slice(0, 80)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (!ids.has(p.module)) p.module = ids.size ? [...ids][0] : 'M1'
    list.push(p)
    added++
  }
  if (added) list.forEach((p, i) => { p.id = `K${i + 1}` })
  return { points: list, added }
}

/** 这些题对应的原文依据落在哪几章：重学只学这几章，不整门重来。 */
export async function locateChapters(stateRoot, id, st, questions) {
  const { chunks } = await chaptersOf(stateRoot, id)
  const keys = []
  for (const q of questions || []) {
    const p = (st.prep.map?.points || []).find(x => x && x.id && x.id === q.pointId)
    if (p?.source) keys.push(String(p.source))
    const raw = String(q.answerContains || '')
    for (const m of raw.matchAll(/["“]([^"”]{4,})["”]/g)) keys.push(m[1])
  }
  const flat = keys.map(norm).filter(k => k.length >= 6)
  if (!flat.length) return []
  const titles = []
  for (const ch of chunks) {
    const hay = norm(ch.text)
    if (flat.some(k => hay.includes(k) || (k.length > 24 && hay.includes(k.slice(0, 20))))) titles.push(ch.title)
  }
  return titles
}

/** 还没做完的活：断点续跑时让人一眼看见还剩几件事。 */
export function pendingUnits(st) {
  const out = []
  const prep = st.prep || {}
  if (!prep.scope) out.push('边界与版本')
  if (!prep.map) out.push('知识地图')
  if (!prep.pack) out.push('课程包')
  if (!prep.audit) out.push('独立审核')
  ;(st.study?.parts || []).forEach(p => { if (p.status === 'todo') out.push(`自学第 ${p.index} 段`) })
  ;(st.exam?.questions || []).forEach(q => { if (q.askedAt && !q.answeredAt) out.push(`第 ${q.no} 题作答`) })
  ;(st.exam?.questions || []).forEach(q => { if (!q.askedAt) out.push(`第 ${q.no} 题未问`) })
  return out
}

/** 上架前要给主人看的账本：字、章、节、条、笔记、覆盖率、审核问题、没做好的地方。 */
export function buildBrief(st, cfg = {}) {
  const chapters = st.chapters || []
  const prepChapters = st.prep?.chapters || []
  const points = st.prep?.map?.points || []
  const issues = st.prep?.audit?.issues || []
  const hard = issues.filter(i => !i.advisory)
  const scored = (st.exam?.questions || []).filter(q => q.score != null)
  const avg = scored.length ? Math.round(scored.reduce((n, q) => n + q.score, 0) / scored.length) : null
  const cov = st.study?.summary?.coverage || null
  return {
    title: st.title,
    sourceChars: st.sourceChars || 0,
    chapters: chapters.length,
    sections: (st.sections || []).length,
    scope: st.prep?.scope
      ? {
        appliesTo: (st.prep.scope.applies_to || []).slice(0, 6),
        version: st.prep.scope.version || '',
        effectiveDate: st.prep.scope.effective_date || '',
        mandatory: st.prep.scope.mandatory || '',
        origin: st.prep.scope.origin || '',
      }
      : null,
    clauses: {
      ...clauseStats(points),
      unanchored: st.prep?.map ? (st.prep.map.unanchored ?? null) : null,
      origin: st.prep?.map?.origin || '',
    },
    notesChars: prepChapters.reduce((n, c) => n + (c.noteChars || 0), 0),
    packChars: st.prep?.packChars || 0,
    fallbackChapters: prepChapters.filter(c => c.fallback).length,
    truncatedChapters: prepChapters.filter(c => c.truncated).length,
    coverage: cov ? { covered: cov.covered.length, total: cov.total, missing: (cov.missing || []).slice(0, 8) } : null,
    audit: {
      status: st.prep?.audit?.status || '',
      total: issues.length,
      hard: hard.length,
      high: issues.filter(i => i.level === 'high').length,
      medium: issues.filter(i => i.level === 'medium').length,
      advisory: issues.filter(i => i.advisory).length,
      resolved: issues.filter(i => i.resolved).length,
      issues: issues.slice(0, 12).map(i => ({
        no: i.no, level: i.level, label: LEVEL_LABEL[i.level] || i.level,
        where: i.where || '', message: i.message || '',
        quote: String(i.quote || i.evidence || '').slice(0, 160),
        advisory: Boolean(i.advisory), resolved: Boolean(i.resolved),
      })),
    },
    study: {
      parts: (st.study?.parts || []).length,
      failedParts: (st.study?.parts || []).filter(p => p.status !== 'done').length,
      points: (st.study?.parts || []).flatMap(p => p.points || []).length,
      unresolved: (st.study?.summary?.unresolved || []).length,
      loops: st.study?.loops || 0,
      scoped: st.study?.scoped ? (st.study.scoped.titles || []).slice(0, 8) : [],
    },
    exam: {
      questions: scored.length,
      avg,
      passLine: Math.round((Number(cfg.passThreshold) || 0.75) * 100),
      recallHeavy: Boolean(st.exam?.recallHeavy),
      anchorOnly: scored.length > 0 && scored.every(q => q.origin === 'anchor-fallback'),
      regression: { asked: st.exam?.regression?.asked || 0, passed: st.exam?.regression?.passed || 0 },
    },
    corrections: (st.corrections || []).length,
    pending: pendingUnits(st),
  }
}

/** 一段给主人看的概要文字：确认的是「按原文理解对了没有」，不是「文件上传成功」。 */
export function briefText(b, st = {}) {
  const lines = [
    `原文 ${b.sourceChars} 字，${b.chapters} 章、${b.sections} 节；知识点 ${b.clauses.total} 条，其中能单独执行的条款 ${b.clauses.qualified} 条（${b.clauses.rate}%）`
      + `${b.sourceChars ? `，密度约每千字 ${Math.round((b.clauses.total / b.sourceChars) * 1000)} 条` : ''}。`,
    `课程包 ${b.packChars} 字，覆盖 ${b.clauses.qualified}/${b.clauses.total} 条可执行条款；逐章备课笔记已停写，备课结论都收在课程包里。`,
    b.coverage
      ? `章节覆盖 ${b.coverage.covered}/${b.coverage.total}${b.coverage.missing.length ? `，没读到：${b.coverage.missing.join('、')}` : '，全部读到'}。`
      : '章节覆盖还没算出来。',
    b.audit.status
      ? (b.audit.total
        ? `审核问题 ${b.audit.total} 条：高风险 ${b.audit.high} 条、中风险 ${b.audit.medium} 条、参考 ${b.audit.advisory} 条，已按你的意见处理 ${b.audit.resolved} 条。`
        : '审核跑过了，硬问题和参考意见都是 0 条。')
      : '审核还没跑。',
    b.clauses.unanchored
      ? `有 ${b.clauses.unanchored} 条知识点的原文依据逐字对不上原文，这几条别当准。`
      : '每条知识点都能回到原文原句。',
    (b.exam.anchorOnly
      ? '这一轮没有真考题，用的是原文标题抽查，本质是复述，只能说明笔记抄得全，不能说明会用。'
      : '') + `考核 ${b.exam.questions} 题，平均 ${b.exam.avg ?? '—'} 分，结课线 ${b.exam.passLine} 分`
      + `${b.exam.regression.asked ? `；回归题 ${b.exam.regression.asked} 道过 ${b.exam.regression.passed} 道` : ''}`
      + `${b.corrections ? `；你课上纠正过 ${b.corrections} 条` : ''}。`,
    b.pending.length ? `还剩 ${b.pending.length} 件没做完：${b.pending.slice(0, 6).join('、')}。` : '该做的都做完了，没有半成品。',
  ]
  // 开课前被放行的硬问题必须留在账上：用户说过「先这样开，问题记着」，这里就得真记
  const openHard = (b.audit.issues || []).filter(i => !i.advisory && !i.resolved)
  if (openHard.length) {
    lines.push(`开课前放行的硬问题 ${openHard.length} 条，你当时选了照这样开课，账记在这里：`
      + openHard.slice(0, 4).map(i => `第 ${i.no} 条${i.where ? `（${i.where}）` : ''}${i.message}`).join('；'))
  }
  if (b.scope) {
    const sc = []
    if (b.scope.appliesTo.length) sc.push(`适用：${b.scope.appliesTo.join('、')}`)
    if (b.scope.version) sc.push(`版本：${b.scope.version}`)
    if (b.scope.effectiveDate) sc.push(`生效：${b.scope.effectiveDate}`)
    if (b.scope.mandatory) sc.push(`强制条款：${String(b.scope.mandatory).slice(0, 60)}`)
    if (sc.length) lines.splice(1, 0, `${sc.join('；')}。`)
    else lines.splice(1, 0, '适用范围原文没写清，后面出题只能按原文条款本身，不假设产品范围。')
  } else {
    lines.splice(1, 0, '边界与版本没摘出来，这一课不知道管到哪，出题可能越界。')
  }
  return lines.join('\n')
}

/** Deterministic audit. Only these may block; model findings stay advisory. */
export function deterministicAudit(st, sourceNorm) {
  const issues = []
  const pack = st.prep.pack || {}
  const push = (level, scope, where, message, evidence) => {
    issues.push({ level, scope, where: String(where || '').slice(0, 60), message, quote: String(evidence || '').slice(0, 180), evidence: String(evidence || '').slice(0, 180) })
  }
  if (sourceNorm.length < 40) push('high', 'coverage', '原文', '原文太短或解析为空，无法开课', '')
  // 缺料不能当通过：题库空、课程包降级，这一课就没有真考题了
  if (!pack || !Object.keys(pack).length) {
    push('high', 'pack', '课程包', '课程包是空的，后面没有真考题可出', '')
  } else if (pack.degraded) {
    push('high', 'pack', '课程包', '课程包缺料，重点和题目没产出来', String(pack.degradedReason || '模型两次都没给出 JSON'))
  }
  if (!(pack.question_bank || []).length) {
    push('high', 'question', '题库', '题库是空的，只能按原文标题抽查（那是复述题，不是真考题）', '')
  }
  if (!(st.prep.map?.points || []).length) {
    push('high', 'coverage', '知识地图', '知识地图是空的，条款层不存在', '')
  }
  // 条款太稀等于没拆：原文一两千字才出三五条，后面的题和笔记都只能浮在面上
  const mapPoints = st.prep.map?.points || []
  if (mapPoints.length && sourceNorm.length > 800) {
    const need = Math.max(6, Math.round(sourceNorm.length / 400))
    if (mapPoints.length < need) {
      push('medium', 'coverage', '知识地图',
        `条款拆得太稀：原文 ${sourceNorm.length} 字只有 ${mapPoints.length} 条，按密度应有 ${need} 条以上，覆盖面偏窄`,
        `原文 ${sourceNorm.length} 字 / 条款 ${mapPoints.length} 条`)
    }
  }
  const mapIds = new Set((st.prep.map?.points || []).map(p => p.id))
  ;(pack.focus_points || []).forEach((f, i) => {
    const src = String(f.source || '')
    if (f.point_id && mapIds.size && !mapIds.has(String(f.point_id))) {
      push('medium', 'focus', `重点 ${i + 1}`, `引用了知识地图里没有的 id：${f.point_id}`, String(f.title || ''))
    }
    if (!src.trim()) {
      push('high', 'focus', `重点 ${i + 1}`, '没给原文依据', String(f.title || ''))
    } else if (!supported(src, sourceNorm)) {
      push('high', 'focus', `重点 ${i + 1}`, '原文依据在课件里找不到', src)
    }
  })
  ;(pack.question_bank || []).forEach((q, i) => {
    const raw = String(q.answer_contains || '')
    const keys = (raw.match(/["“”‘'‘’]([^"“”‘'‘’]{2,})["“”‘’]/g) || [])
      .map(x => x.replace(/["“”‘'‘’]/g, ''))
    const list = keys.length ? keys : [raw]
    // 模型常把两句原文用逗号拼成一个判分关键词（「不得使用转换插座,插头须插到底」）。
    // 这不是编造，只是不连续：拆开逐段核，每段都能在原文找到就算过，
    // 否则会把好好的题库判成硬问题，白白拦住开课。
    const segs = []
    for (const key of list) {
      const split = String(key).split(/[,，;；|、]\s*/).map(x => x.trim()).filter(Boolean)
      if (split.length > 1) segs.push(...split)
      else segs.push(key)
    }
    const missing = segs.filter(k => norm(k).length >= 2 && !sourceNorm.includes(norm(k)))
    if (missing.length) {
      push('medium', 'question', `第 ${i + 1} 题`, '判分关键词在原文找不到', missing.join('、'))
    }
  })
  const order = (pack.teaching_order || []).join(' ')
  // 单章文档不查「漏章」：那一章的标题是整篇文档的标题，课程包不会复述它
  if ((st.chapters || []).length > 1) {
    for (const ch of st.chapters) {
      if (norm(ch.title) && !norm(order).includes(norm(ch.title).slice(0, 8))) {
        push('medium', 'coverage', ch.title, '教学顺序没覆盖这一章', ch.title)
        if (issues.filter(x => x.scope === 'coverage' && /教学顺序没覆盖/.test(x.message)).length >= 3) break
      }
    }
  }
  // 表格章节不能被整体略过：本引擎不再写备课笔记，判据换成课程包有没有提到这一章
  const packNorm = norm([
    String(pack.overview || ''),
    ...(pack.teaching_order || []),
    ...(pack.focus_points || []).map(f => `${f.title} ${f.why} ${f.source}`),
    ...(pack.question_bank || []).map(q => `${q.q} ${q.answer_contains} ${q.point_id}`),
  ].join(' '))
  if (packNorm.length >= 20) {
    ;(st.prep.chapters || []).forEach(c => {
      if (!c.hasTable) return
      const keys = (c.tableKeys || []).map(norm).filter(k => k.length >= 2)
      if (!keys.length) return
      if (!keys.some(k => packNorm.includes(k))) {
        push('medium', 'coverage', c.title, '原文有表格，课程包里一项都没提到', '原文表格')
      }
    })
  }
  const high = issues.filter(x => x.level === 'high')
  return {
    status: high.length ? 'needs_review' : 'passed',
    issues,
    highCount: high.length,
    checkedAt: new Date().toISOString(),
    origin: 'deterministic',
  }
}

/* ------------------------------------------------------------- advance */

/**
 * Run exactly one unit of teaching work and persist. One HTTP call per unit keeps
 * every request bounded and makes the whole class resumable after a restart.
 */
export async function advance(stateRoot, options) {
  const { chat, cfg = {} } = options || {}
  const id = safeId(options.id)
  const st = await loadState(stateRoot, id)
  traceDir = dirOf(stateRoot, id)

  if (st.stage === 'confirm' || st.stage === 'finished') {
    // 结课确认这条话要能补写：状态已经进 confirm，但消息可能因为写入失败没落盘，
    // 聊天记录里就会出现「考完了」后面直接没有「等您确认」这一句。
    if (st.stage === 'confirm') {
      const brief = st.confirm?.brief || buildBrief(st, cfg)
      const passLine = Math.round((Number(cfg.passThreshold) || 0.75) * 100)
      await sayConfirmAsk(stateRoot, id, st, brief, Number(st.exam?.avg) || 0, passLine)
    }
    return { state: describe(st), needUser: true, note: st.stage === 'finished' ? '已结课' : '等您确认结课' }
  }
  // 审核卡在硬问题上：不再自动往下走，等 openClass() 拿到许可
  if (st.stage === 'prep' && st.prep?.audit?.gate === 'blocked') {
    return { state: describe(st), needUser: true, note: '审核有硬问题，等您决定开不开课', gate: 'blocked' }
  }
  if (st.stage === 'ready') {
    st.stage = 'prep'
    await saveState(stateRoot, id, st)
  }
  let out
  try {
    if (st.stage === 'prep') out = await prepStep({ stateRoot, id, st, chat, cfg })
    else if (st.stage === 'study') out = await studyStep({ stateRoot, id, st, chat, cfg })
    else if (st.stage === 'clarify') out = await clarifyStep({ stateRoot, id, st, chat, cfg })
    else if (st.stage === 'exam') out = await examStep({ stateRoot, id, st, chat, cfg })
    else out = { state: describe(st), needUser: true }
  } catch (error) {
    // 一步跑炸了也得在活动流里留一笔，不能让界面一直停在「正在…」上
    await finishProgress(stateRoot, id, st, String(error?.message || error), false)
    throw error
  }
  // 带上课堂元信息（消息条数、笔记字数），前端不必为每步再拉一次全量实录
  try {
    const room = await getClassroom(stateRoot, id)
    return { ...out, classroom: room.classroom }
  } catch {
    return out
  }
}

async function chaptersOf(stateRoot, id) {
  const source = await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')
  return { source, chunks: splitChapters(source) }
}

/**
 * 对话流里的活动行。每次读盘、每次调模型之前先落一条「正在做什么」，
 * 做完再补结果和耗时——前端把它渲染成聊天记录下面的动作流，
 * 「正在通读全文 → 读完 2461 字切了 11 章 · 38 秒」，跟和模型聊天时看到的一样。
 * 只写 teaching.json，不进对话：这是机器的动作，不是教授说的话。
 */
const ACT_KEEP = 40

async function markProgress(stateRoot, id, st, key, label, extra = {}) {
  const at = new Date().toISOString()
  st.activity = [...(st.activity || []), {
    id: `${key}-${Date.parse(at).toString(36)}`,
    key, label, at, status: 'running', ...extra,
  }].slice(-ACT_KEEP)
  st.progress = { key, label, at }
  await saveState(stateRoot, id, st)
}

/**
 * 收掉当前这条活动，写上结果和用了多久。ok=false 就是失败，界面上是红的。
 * 只收最近一条还在跑的：同一间课堂的推进是串行的，不会同时有两条。
 */
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
    await saveState(stateRoot, id, st)
    return act
  }
  return null
}

async function prepStep({ stateRoot, id, st, chat, cfg }) {
  const { source, chunks } = await chaptersOf(stateRoot, id)
  const sourceNorm = norm(source)

  // 0) boundary & version first: without it, every scenario question may be out of scope
  if (!st.prep.scope) {
    await markProgress(stateRoot, id, st, 'scope', '通读全文，定适用范围与版本',
      { detail: `${source.length} 字 · ${sectionTitles(source).length} 节`, tag: '读取文档' })
    let data = null
    let error = ''
    try {
      const res = await callModel(chat, {
        system: PROMPTS.scope,
        prompt: `课程标题：${st.title}\n\n课件原文：\n${source.slice(0, 24000)}`,
        maxTokens: 4000,
      })
      data = jsonOf(res.text)
      if (!data) error = '模型没给出可解析的 JSON'
    } catch (e) {
      error = String(e.message || e).slice(0, 160)
    }
    const sc = data || {}
    const terms = (sc.terms || []).filter(t => t && t.term).slice(0, 20)
      .map(t => ({ term: String(t.term).slice(0, 40), meaning: String(t.meaning || '').slice(0, 120) }))
    st.prep.scope = {
      applies_to: (sc.applies_to || []).map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, 8),
      version: String(sc.version || '').slice(0, 40),
      effective_date: String(sc.effective_date || '').slice(0, 40),
      supersedes: String(sc.supersedes || '').slice(0, 60),
      mandatory: String(sc.mandatory || '').slice(0, 200),
      recommended: (sc.recommended || []).map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, 6),
      terms,
      origin: data ? 'model' : 'unavailable',
      error,
      at: new Date().toISOString(),
    }
    if (error) st.errors.push({ at: new Date().toISOString(), scope: 'scope', message: error })
    await atomicWrite(join(dirOf(stateRoot, id), 'scope.json'), `${JSON.stringify(st.prep.scope, null, 2)}\n`)
    const sc2 = st.prep.scope
    const parts = []
    if (sc2.applies_to.length) parts.push(`适用：${sc2.applies_to.join('、')}`)
    if (sc2.version) parts.push(`版本 ${sc2.version}`)
    if (sc2.effective_date) parts.push(`生效 ${sc2.effective_date}`)
    if (sc2.mandatory) parts.push(`强制条款：${sc2.mandatory.slice(0, 50)}`)
    const missing = []
    if (!sc2.version) missing.push('版本号')
    if (!sc2.applies_to.length) missing.push('适用范围')
    const missingHint = missing.length
      ? `原文没写${missing.join('和')}，我按「没写」处理，不替它补。` : ''
    await say(stateRoot, id, {
      id: `teach-${id}-scope`, role: 'professor', kind: 'teach',
      content: data
        ? (parts.length
          ? `先把边界定清楚，免得把条款用错地方：${parts.join('；')}。${missingHint}`
          : '这份原文没写适用范围、版本和强制条款，我先记成「没写」；后面出题只就条款本身问，不假设用在哪个产品上。')
        : `边界与版本我没摘出来（${error}），这一课先不知道管到哪，出题可能越界，标在这儿。`,
      meta: { step: 'scope', origin: st.prep.scope.origin, appliesTo: sc2.applies_to.length },
    })
    // 模型给的适用范围常自带「适用于：」前缀，拼进一句话就成了「适用 适用于：…」
    const applies = (sc2.applies_to || []).map(x => String(x).replace(/^适用于?[:：]?\s*/, ''))
    await finishProgress(stateRoot, id, st,
      data
        ? `通读全文 ${source.length} 字、${sectionTitles(source).length} 节；`
          + (sc2.version ? `版本 ${sc2.version}` : '原文没写版本号')
          + (applies.length
            ? `，适用 ${applies.slice(0, 2).join('、')}${applies.length > 2 ? ` 等 ${applies.length} 项` : ''}`
            : '，原文没写适用范围')
        : `没摘出边界：${error}`,
      Boolean(data))
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }

  // 1) knowledge map
  if (!st.prep.map) {
    // 一条条款管一条规则：按每 150 字一条估。密度不够就补一轮，别让一节课只剩十来条。
    const desired = Math.max(8, Math.min(160, Math.round(source.length / 150)))
    const floor = Math.max(6, Math.round(desired * 0.7))
    await markProgress(stateRoot, id, st, 'map', '拆条款：把原文拆成一条条可执行的规则',
      { detail: `${source.length} 字 · ${sectionTitles(source).length} 节 · 目标 ≥${desired} 条`, tag: '调用模型' })
    let res = null
    let mapError = ''
    try {
      res = await callModel(chat, {
        system: PROMPTS.map.replace(
          '知识点密度：原文每 150 字左右要出一条，每一节至少一条；',
          `知识点目标 ${desired} 条，少于 ${floor} 条就算漏；`,
        ),
        prompt: `课程标题：${st.title}\n\n边界与版本：${JSON.stringify(st.prep.scope)}\n\n课件正文：\n${source}`,
        maxTokens: 20000,
        grow: true,
      })
    } catch (e) {
      mapError = String(e.message || e).slice(0, 160)
    }
    const data = (res ? jsonOf(res.text) : null) || {}
    let points = normalizeMapPoints(data.points)
    let gapAdded = 0
    if (points.length) {
      // 首轮偏薄，或整章一条条款都没有，就带着「已收录」清单再要一轮，只补不重写
      const missing = chunks.filter(ch => !points.some(p => p.source && norm(ch.text).includes(norm(p.source).slice(0, 40))))
      if (points.length < floor || missing.length) {
        const need = Math.max(4, floor - points.length, missing.length * 3)
        try {
          const gap = await callModel(chat, {
            system: PROMPTS.mapGap.replace('{need}', String(need)),
            prompt: `课程标题：${st.title}\n\n已收录（不要重复）：\n`
              + points.map(p => `- ${p.title}｜${String(p.source).slice(0, 80)}`).join('\n').slice(0, 6000)
              + (missing.length ? `\n\n这些章节现在一条条款都没有，先补它们：\n${missing.slice(0, 6).map(c => `# ${c.title}`).join('\n')}` : '')
              + `\n\n课件正文：\n${source}`,
            maxTokens: 20000,
            grow: true,
          })
          const gdata = (gap ? jsonOf(gap.text) : null) || {}
          const moduleIds = (data.modules || []).map((m, i) => String(m.id || `M${i + 1}`))
          const merged = mergeGapPoints(points, gdata.points, moduleIds)
          points = merged.points
          gapAdded = merged.added
        } catch (e) {
          st.errors.push({ at: new Date().toISOString(), scope: 'map-gap', message: String(e.message || e).slice(0, 160) })
        }
      }
    }
    let origin = 'model'
    if (!points.length) {
      // Do not pretend the model built a map. Fall back to原文锚点 and say so.
      points = densityPoints(source, desired)
      origin = 'density-fallback'
      mapError = mapError || (res?.truncated ? '模型输出被截断' : '模型没产出可用知识点')
      st.errors.push({ at: new Date().toISOString(), scope: 'map', message: mapError })
    }
    const unanchored = points.filter(p => p.source && !supported(p.source, sourceNorm)).length
    const thin = points.filter(p => !isClausePoint(p)).length
    st.prep.map = {
      modules: (data.modules || []).filter(m => m && m.title).slice(0, 8).map((m, i) => ({
        id: String(m.id || `M${i + 1}`), title: String(m.title).slice(0, 60),
      })),
      points,
      origin,
      error: mapError,
      unanchored,
      thin,
      density: { desired, floor, chars: sourceNorm.length, gapAdded },
      at: new Date().toISOString(),
    }
    await atomicWrite(join(dirOf(stateRoot, id), 'knowledge-map.json'), `${JSON.stringify(st.prep.map, null, 2)}\n`)
    await say(stateRoot, id, {
      id: `teach-${id}-map`, role: 'professor', kind: 'teach',
      content: (origin === 'model'
        ? `知识地图整理好了：${st.prep.map.modules.length} 个模块、${points.length} 条条款。`
          + (gapAdded ? `首轮只拆出 ${points.length - gapAdded} 条，按密度要求又补了 ${gapAdded} 条。` : '')
        : `知识地图我没整理出来（${mapError}），先用原文切出 ${points.length} 个锚点顶上，标成兜底，不冒充模型整理的结果。`)
        + (thin ? `其中 ${thin} 条只写了「是什么」，没说清什么情况怎么做，算不上可执行条款，审核会记着。` : '每条都说清了适用情形和动作。')
        + (unanchored ? `另有 ${unanchored} 条的原文依据逐字对不上，审核时会挑出来。` : '每条的原文依据都能在原文里逐字找到。')
        + `接下来按 ${chunks.length} 章读原文，拆出可执行条款再出课程包。`,
      meta: { step: 'map', pointCount: points.length, unanchored, thin, origin },
    })
    await finishProgress(stateRoot, id, st,
      `${points.length} 条可执行条款、${st.prep.map.modules.length} 个模块；`
      + `依据逐字对得上的 ${points.length - unanchored}/${points.length} 条`
      + (thin ? `，只说「是什么」的 ${thin} 条` : ''))
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }

  // 2) 章节登记（不再逐章写备课笔记）
  //    学员自学读的是原文分段与课程包，备课笔记从来没人打开；它剩下的唯一用途是
  //    「原文有表格，笔记里也得有表」这条审核，改成查课程包有没有整体略过表格章节，
  //    判据同样硬，但省掉每章一次 8000 预算的长输出。章节元数据留着给审核用。
  if (!(st.prep.chapters || []).length) {
    st.prep.chapters = chunks.map(c => ({
      index: c.index, title: c.title, sourceChars: c.text.length,
      noteChars: 0, hasTable: /\n\s*\|[^\n]*\|/.test(c.text),
      tableKeys: tableKeysOf(c.text), skipped: true,
    }))
    st.prep.chapters.sort((a, b) => a.index - b.index)
    await saveState(stateRoot, id, st)
  }

  // 3) professor pack (reused across classrooms: it is the same course)
  if (!st.prep.pack) {
    await markProgress(stateRoot, id, st, 'pack', '出课程包：按条款写重点、出题库',
      { detail: `${(st.prep.map?.points || []).length} 条条款 · 要 ${bankTarget(st, cfg)} 道题`, tag: '调用模型' })
    const brief = (st.prep.map.points || []).slice(0, 24).map(p => ({
      id: p.id, title: p.title, trigger: p.trigger, action: p.action, summary: p.summary,
    }))
    const scopeLine = st.prep.scope
      ? `\n\n边界与版本：${JSON.stringify({
        applies_to: st.prep.scope.applies_to, version: st.prep.scope.version,
        mandatory: st.prep.scope.mandatory, recommended: st.prep.scope.recommended,
      })}`
      : ''
    const ask = (attempt) => callModel(chat, {
      system: PROMPTS.pack.replace(/\{need\}/g, String(bankTarget(st, cfg))),
      prompt: `课程标题：${st.title}${scopeLine}\n\n知识地图：${JSON.stringify(brief)}\n\n课件全文：\n${source}`
        + (attempt > 1 ? `\n\n提醒：上一次你没有给出题目和重点（question_bank / focus_points 是空的）。`
          + `这次必须给出至少 ${bankTarget(st, cfg)} 道题和至少 3 条重点，题面要写成具体情形，不要写「XX 的定义是什么」。只输出一个 JSON 对象。` : ''),
      maxTokens: 20000,
      grow: true,
    })
    const parse = (text) => {
      const data = jsonOf(text) || {}
      const bank = (data.question_bank || []).filter(x => x && x.q).slice(0, 40)
      const focus = (data.focus_points || []).filter(x => x && x.title).slice(0, 24)
      return { data, bank, focus }
    }
    let attempt = 0
    let parsed = { data: {}, bank: [], focus: [] }
    let lastError = ''
    while (attempt < 2) {
      attempt += 1
      try {
        const res = await ask(attempt)
        parsed = parse(res.text)
        if (parsed.bank.length >= 3 && String(parsed.data.overview || '').trim()) break
        lastError = `课程包缺料：重点 ${parsed.focus.length} 条、题目 ${parsed.bank.length} 道、概述${String(parsed.data.overview || '').trim() ? '有' : '空'}`
      } catch (e) {
        lastError = String(e.message || e).slice(0, 160)
      }
    }
    const { data, bank, focus } = parsed
    const degraded = !(bank.length >= 3 && String(data.overview || '').trim())
    st.prep.pack = {
      overview: String(data.overview || '').slice(0, 600),
      teaching_order: (data.teaching_order || st.chapters.map(c => c.title)).map(x => String(x).slice(0, 90)).slice(0, 24),
      focus_points: focus.map(f => ({
        point_id: String(f.point_id || '').slice(0, 12),
        title: String(f.title).slice(0, 80),
        why: String(f.why || '').slice(0, 200),
        source: String(f.source || '').slice(0, 300),
      })),
      question_bank: bank.map(q => ({
        point_id: String(q.point_id || '').slice(0, 12),
        q: String(q.q).slice(0, 300),
        answer_contains: String(q.answer_contains || '').slice(0, 300),
        angle: String(q.angle || '').slice(0, 40),
      })),
      common_misconceptions: (data.common_misconceptions || []).map(x => String(x).slice(0, 200)).slice(0, 12),
      attempts: attempt,
      degraded,
      degradedReason: degraded ? lastError : '',
      at: new Date().toISOString(),
    }
    st.prep.packFile = 'course-pack.md'
    st.prep.packChars = JSON.stringify(st.prep.pack).length
    if (degraded) {
      st.errors.push({ at: new Date().toISOString(), scope: 'pack', message: lastError || '课程包没有实质内容' })
    }
    await atomicWrite(join(dirOf(stateRoot, id), 'course-pack.json'), `${JSON.stringify(st.prep.pack, null, 2)}\n`)
    await atomicWrite(join(dirOf(stateRoot, id), 'course-pack.md'), renderPack(st))
    await say(stateRoot, id, {
      id: `teach-${id}-pack`, role: 'professor', kind: 'teach',
      content: degraded
        ? `提炼包这次没做出来（${lastError || '模型没给出重点和题目'}），试了 ${attempt} 次。`
          + '后面的抽查只能按原文标题问你「请说明这一条」，那属于复述题，不是真考题；我先如实标出来，不拿复述题冒充考核。'
        : `提炼包做好了：${st.prep.pack.focus_points.length} 个重点、${st.prep.pack.question_bank.length} 道题、`
          + `${st.prep.pack.common_misconceptions.length} 条常见误区。这一版不再逐章写备课笔记，备课结论都收在这份课程包里，接下来送独立审核。`,
      meta: { step: 'pack', degraded, attempts: attempt, questions: st.prep.pack.question_bank.length },
    })
    await finishProgress(stateRoot, id, st,
      degraded
        ? `没出成课程包，试了 ${attempt} 次：${lastError || '模型没给重点和题目'}`
        : `${st.prep.pack.focus_points.length} 个重点、${st.prep.pack.question_bank.length} 道题、`
          + `${st.prep.pack.common_misconceptions.length} 条常见误区`,
      !degraded)
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }

  // 4) independent audit: deterministic blocks, model advice is advisory
  if (!st.prep.audit) {
    await markProgress(stateRoot, id, st, 'audit', '独立审核：逐条核原文依据和判分关键词',
      { detail: `${(st.prep.pack?.question_bank || []).length} 道题 · ${(st.prep.map?.points || []).length} 条条款`, tag: '核对' })
    const deterministic = deterministicAudit(st, sourceNorm)
    let advisory = []
    try {
      const res = await callModel(chat, {
        system: PROMPTS.audit,
        prompt: `课程：${st.title}\n\n课件原文：\n${source.slice(0, 20000)}\n\n课程包：\n${JSON.stringify(st.prep.pack).slice(0, 12000)}`,
        maxTokens: 5000,
        grow: true,
      })
      const data = jsonOf(res.text) || {}
      advisory = (data.issues || []).filter(x => x && (x.message || x.quote)).slice(0, 20).map(x => ({
        level: 'low', // model findings never block: downgraded on purpose
        scope: String(x.scope || 'claim').slice(0, 20),
        where: String(x.where || '').slice(0, 60),
        message: String(x.message || x.quote).slice(0, 240),
        quote: String(x.quote || x.evidence || '').slice(0, 180),
        advisory: true,
      }))
    } catch (e) {
      st.errors.push({ at: new Date().toISOString(), scope: 'audit', message: String(e.message || e).slice(0, 160) })
    }
    const rank = { high: 0, medium: 1, low: 2 }
    const all = [...deterministic.issues, ...advisory]
      .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3))
    all.forEach((x, i) => {
      x.no = i + 1
      x.levelLabel = LEVEL_LABEL[x.level] || x.level
      x.resolved = false
      if (!x.where) x.where = x.advisory ? '审核员意见' : '未定位'
    })
    const hard = all.filter(x => !x.advisory)
    st.prep.audit = {
      ...deterministic,
      issues: all,
      hardCount: hard.length,
      advisoryCount: advisory.length,
    }
    // 硬问题不放过门：这一版把关口从「结课时提一句」提前到「开课前点头」。
    const blocked = hard.length > 0
    st.prep.audit.gate = blocked ? 'blocked' : 'passed'
    await atomicWrite(join(dirOf(stateRoot, id), 'professor-audit.json'), `${JSON.stringify(st.prep.audit, null, 2)}\n`)
    const listed = hard.slice(0, 8).map(x =>
      `第 ${x.no} 条（${x.levelLabel}｜${x.where || '未定位'}）：${x.message}`
      + (x.quote ? `\n　原文/缺失点：${String(x.quote).slice(0, 100)}` : '')).join('\n')
    await say(stateRoot, id, {
      id: `teach-${id}-audit`, role: 'professor', kind: 'teach',
      content: `独立审核：${hard.length} 条硬问题、${advisory.length} 条参考意见。`
        + '原文依据、判分关键词、章节覆盖、表格章节这四项机器可判，硬问题只从这几项来；'
        + '模型审读的意见一律降成参考，不参与放行也不参与拦截。\n'
        + (listed || '硬问题是 0 条。'),
      // 只留页面点编号要用的字段：整条 issue 带 quote 时，12 条就能把 meta 顶到上限
      meta: {
        step: 'audit', status: deterministic.status, hardCount: hard.length,
        advisoryCount: advisory.length, gate: st.prep.audit.gate,
        issues: all.slice(0, 10).map(x => ({
          no: x.no, level: x.level, levelLabel: x.levelLabel,
          where: String(x.where || '').slice(0, 60),
          message: String(x.message || '').slice(0, 120),
          advisory: Boolean(x.advisory),
        })),
      },
    })
    await finishProgress(stateRoot, id, st,
      `硬问题 ${hard.length} 条、参考意见 ${advisory.length} 条`
      + (blocked ? '；停在开课前，等您决定' : '；通过，可以开课'))
    if (blocked) {
      st.stage = 'prep'
      await saveState(stateRoot, id, st)
      await say(stateRoot, id, {
        id: `teach-${id}-gate`, role: 'professor', kind: 'teach',
        content: `这 ${hard.length} 条不过，我不往下开课。两条路：照现有课程包开，问题记进结课账；`
          + '或者你指出第几条该怎么改，我按你说的改完重审，通过了再开。',
        meta: { step: 'gate', hardCount: hard.length },
      })
      return { state: describe(st), needUser: true, gate: 'blocked' }
    }
    st.stage = 'study'
    await saveState(stateRoot, id, st)
    // 准备阶段收工，交给学员：判据是条款、题库、审核这三样各自的硬指标
    const prepChecks = [
      { name: '可执行条款', pass: (st.prep.map?.points || []).length >= 6, detail: `${(st.prep.map?.points || []).length} 条` },
      { name: '课程包题库', pass: !st.prep.pack?.degraded, detail: `${(st.prep.pack?.focus_points || []).length} 重点 / ${(st.prep.pack?.question_bank || []).length} 题` },
      { name: '独立审核', pass: hard.length === 0, detail: `${hard.length} 条硬问题` },
    ]
    await sayHandoff(stateRoot, id, {
      stage: 'prep',
      from: '教务与教授',
      to: '学员',
      delivered: `原文 ${st.sourceChars} 字定边界版本，拆出 ${(st.prep.map?.points || []).length} 条可执行条款，`
        + `课程包 ${(st.prep.pack?.focus_points || []).length} 个重点、${(st.prep.pack?.question_bank || []).length} 道题。`,
      checks: prepChecks,
      verdict: 'pass',
      next: '学员按原文分段自学',
    })
    await say(stateRoot, id, {
      id: `teach-${id}-study-start`, role: 'professor', kind: 'teach',
      content: `审核过了，我开始自己学。原文共 ${st.sourceChars} 字，我会分 ${studyParts(st.chapters).length} 段逐段读，读完把覆盖清单和没弄懂的问题交给你。`,
      meta: { step: 'study-start' },
    })
    return { state: describe(st), needUser: false }
  }

  st.stage = 'study'
  await saveState(stateRoot, id, st)
  return { state: describe(st), needUser: false }
}

async function studyStep({ stateRoot, id, st, chat, cfg }) {
  if (!st.study.parts.length) {
    const { chunks } = await chaptersOf(stateRoot, id)
    // 定向重学：只把错题涉及的那几章重新排进学习计划，不整门从头再来
    const scopedTitles = st.study.scoped ? (st.study.scoped.titles || []) : []
    const scopedChunks = scopedTitles.length
      ? chunks.filter(c => scopedTitles.some(t => norm(t) === norm(c.title)))
      : []
    const use = scopedChunks.length ? scopedChunks : chunks
    st.study.parts = studyParts(use).map(p => ({
      index: p.index, titles: p.titles, chars: p.chars, status: 'todo', points: [], unresolved: [],
    }))
    if (scopedChunks.length) {
      await say(stateRoot, id, {
        id: `teach-${id}-scoped-${st.study.loops}`, role: 'professor', kind: 'teach',
        content: `这一轮只重学错的那几处，不整门重来：${scopedChunks.map(c => c.title).join('、')}`
          + `（${st.study.parts.length} 段）。`,
        meta: { step: 'scoped', titles: scopedChunks.length },
      })
    } else if (scopedTitles.length) {
      await say(stateRoot, id, {
        id: `teach-${id}-scoped-miss-${st.study.loops}`, role: 'professor', kind: 'teach',
        content: '错题对应不到具体章节，没法只挑那几条，只能整门再看一遍。',
        meta: { step: 'scoped-miss' },
      })
    }
    await saveState(stateRoot, id, st)
  }
  const part = st.study.parts.find(p => p.status === 'todo')
  if (part) {
    await markProgress(stateRoot, id, st, 'study',
      `读第 ${part.index}/${st.study.parts.length} 段原文，写知识点`,
      { detail: `${part.chars} 字 · ${part.titles.join('、').slice(0, 40)}`, tag: '读取文档' })
    const { chunks } = await chaptersOf(stateRoot, id)
    const chaptersText = chunks
      .filter(c => part.titles.some(t => c.title === t))
      .map(c => c.text)
      .join('\n\n') || chunks.map(c => c.text).join('\n\n').slice(0, LIMITS.chapterChars)
    const focus = st.study.focus ? `\n\n这次重点再看这些薄弱点：${st.study.focus}` : ''
    const said = (st.notes || []).slice(-3).join('；')
    const extra = said ? `\n助教补充过，必须一并看：${said}` : ''
    let data = null
    let truncated = false
    let lastError = ''
    // 模型偶尔只出推理或半截 JSON：重试一次再判这段没学成，别一次就放弃
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await callModel(chat, {
          system: PROMPTS.study.replace('{i}', String(part.index)).replace('{n}', String(st.study.parts.length)),
          prompt: `课程：${st.title}\n本部分章节：${part.titles.join('、')}\n\n原文：\n${chaptersText}${focus}${extra}`
            + (attempt ? '\n\n提醒：上一次你没给出可用的 JSON。这次只输出那一个 JSON 对象，points 至少 3 条，每条都要有 rule 和原文 source。' : ''),
          maxTokens: 8000,
          grow: true,
        })
        truncated = res.truncated
        data = jsonOf(res.text)
        if ((data?.points || []).length) break
        lastError = truncated ? '模型输出被长度上限截断，没整理出知识点' : '模型没产出有效知识点'
      } catch (e) {
        lastError = String(e.message || e).slice(0, 160)
      }
    }
    const usablePoints = (data?.points || []).filter(p => p && (p.rule || p.source || p.title))
    if (!usablePoints.length) {
      part.status = 'failed'
      part.error = lastError || '模型没产出有效知识点'
      part.unresolved = [`第 ${part.index} 段没学成：${part.error}`]
      st.errors.push({ at: new Date().toISOString(), scope: 'study-retry', index: part.index, message: part.error })
      await say(stateRoot, id, {
        id: `teach-${id}-part${part.index}`, role: 'student', kind: 'answer',
        content: `第 ${part.index}/${st.study.parts.length} 段我没读下来（${part.error}），试了 2 次。`
          + '这一段先记成没学成，我不拿半截内容当笔记。',
        meta: { step: 'study', index: part.index, failed: true },
      })
      await finishProgress(stateRoot, id, st,
        `第 ${part.index} 段没读下来：${part.error}`, false)
      await saveState(stateRoot, id, st)
      return { state: describe(st), needUser: false }
    }
    const points = usablePoints.map(p => ({
      title: String(p.title || '').slice(0, 80),
      rule: String(p.rule || '').slice(0, 600),
      conditions: String(p.conditions || '').slice(0, 400),
      exceptions: String(p.exceptions || '').slice(0, 400),
      numbers: String(p.numbers || '').slice(0, 400),
      source: String(p.source || '').slice(0, 400),
      misconceptions: String(p.misconceptions || '').slice(0, 300),
    }))
    part.status = 'done'
    part.points = points
    part.unresolved = (data.unresolved || []).map(x => String(x).slice(0, 200)).slice(0, 8)
    part.covered = (data.covered_sections || []).map(x => String(x).slice(0, 90)).slice(0, 40)
    await atomicWrite(join(dirOf(stateRoot, id), 'student-notes.md'), renderStudentNotes(st))
    const brief = points.slice(0, 6).map((p, i) => `${i + 1}. ${p.title || '知识点'}：${(p.rule || p.source || '').slice(0, 90)}`)
    await say(stateRoot, id, {
      id: `teach-${id}-part${part.index}`, role: 'student', kind: 'answer',
      sectionRef: part.titles.join('、').slice(0, 80),
      content: `第 ${part.index}/${st.study.parts.length} 段读完了（${part.titles.join('、')}），${points.length} 条知识点。\n`
        + `${brief.join('\n')}\n笔记已写进 student-notes.md。`
        + (part.unresolved.length ? `\n有 ${part.unresolved.length} 处没弄懂，先记下来，学完一起问。` : ''),
      meta: { step: 'study', index: part.index, points: points.length },
      refs: points.map(p => String(p.source || '').slice(0, 280)).filter(Boolean).slice(0, 3),
    })
    await finishProgress(stateRoot, id, st,
      `${points.length} 条知识点，${part.covered.length} 处原文对上，${part.unresolved.length} 处没弄懂`)
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }

  // all parts done (or failed): merge, check coverage, decide next stage
  const allTitles = sectionTitles((await chaptersOf(stateRoot, id)).source)
  const scopedTitles = st.study.scoped ? (st.study.scoped.titles || []) : []
  const roundTitles = scopedTitles.length
    ? allTitles.filter(t => scopedTitles.some(s => norm(s) === norm(t)))
    : allTitles
  const coveredAll = st.study.parts.flatMap(p => p.covered || [])
  const coverage = coverageReport(roundTitles.length ? roundTitles : allTitles, coveredAll)
  // 整门课的覆盖率只在完整那一轮记；定向重学不覆盖它
  if (!scopedTitles.length && (!st.study.coverageAll || coverage.covered.length >= st.study.coverageAll.covered.length)) {
    st.study.coverageAll = coverage
  }
  const unresolved = []
  const origins = []
  st.study.parts.forEach(p => (p.unresolved || []).forEach(q => {
    // 「这段没跑成」是工程故障，不是学员的问题，不进答疑队列
    if (/没学成|没产出|需要重学/.test(q)) return
    unresolved.push(q); origins.push('student')
  }))
  if (!scopedTitles.length && coverage.missing.length) {
    unresolved.push(`覆盖核对发现这些章节没读到：${coverage.missing.slice(0, 6).join('、')}`)
    origins.push('coverage')
  }
  const points = st.study.parts.flatMap(p => p.points || [])
  st.study.summary = {
    round: st.study.history.length + 1,
    sourceChars: st.sourceChars,
    parts: st.study.parts.length,
    failedParts: st.study.parts.filter(p => p.status !== 'done').length,
    points: points.length,
    sectionsTotal: coverage.total,
    coveredSections: coverage.covered.length,
    coverage,
    scoped: scopedTitles.length ? scopedTitles.slice(0, 8) : null,
    unresolved: unresolved.slice(0, 8),
    at: new Date().toISOString(),
  }
  await atomicWrite(join(dirOf(stateRoot, id), 'student-notes.md'), renderStudentNotes(st))
  st.clarify.questions = unresolved.slice(0, 5)
  st.clarify.origins = origins.slice(0, 5)
  st.clarify.answers = []
  st.clarify.asked = 0
  await saveState(stateRoot, id, st)
  // 自学收工，交给教授答疑：判据看覆盖有没有读全、每段有没有出要点
  await sayHandoff(stateRoot, id, {
    stage: 'study',
    from: '学员',
    to: '教授（答疑）',
    delivered: `原文 ${st.study.parts.length} 段读完 ${st.study.parts.filter(p => p.status === 'done').length} 段，`
      + `知识点 ${points.length} 条，没弄懂 ${unresolved.length} 处。`,
    checks: [
      { name: '章节覆盖', pass: coverage.missing.length === 0, detail: `${coverage.covered.length}/${coverage.total}` },
      { name: '段落产出', pass: st.study.parts.every(p => p.status === 'done'), detail: `${st.study.parts.filter(p => p.status !== 'done').length} 段没学成` },
      { name: '疑点登记', pass: true, detail: `${unresolved.length} 处待答` },
    ],
    verdict: 'pass',
    next: unresolved.length ? `先答这 ${unresolved.length} 个问题` : '没有疑点，直接开考',
  })
  await say(stateRoot, id, {
    id: `teach-${id}-summary-${st.study.summary.round}`, role: 'professor', kind: 'teach',
    content: `学完了，先给你一份学习概要：\n`
      + `- 原文 ${st.sourceChars} 字，分 ${st.study.parts.length} 段，${st.study.summary.failedParts} 段没学成\n`
      + `- ${scopedTitles.length ? '本轮（只补错题章节）覆盖' : '章节覆盖'} ${coverage.covered.length}/${coverage.total}${coverage.missing.length ? `，没读到：${coverage.missing.slice(0, 5).join('、')}` : '，全部读到'}\n`
      + `- 知识点了 ${points.length} 条，没弄懂 ${unresolved.length} 处\n`
      + (unresolved.length ? '学员自己提的问题我接着答，答不上来的明说等助教。' : '没有遗留问题，可以开考。'),
    meta: { step: 'study-summary', coverage: `${coverage.covered.length}/${coverage.total}`, points: points.length },
  })
  st.stage = unresolved.length ? 'clarify' : 'exam'
  await saveState(stateRoot, id, st)
  return { state: describe(st), needUser: false }
}

async function clarifyStep({ stateRoot, id, st, chat, cfg }) {
  const source = await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')
  const pending = st.clarify.questions.filter(q => !st.clarify.answers.some(a => a.q === q))
  if (!pending.length) {
    st.stage = 'exam'
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }
  const q = pending[0]
  await markProgress(stateRoot, id, st, 'clarify',
    `回答第 ${(st.clarify.answers || []).length + 1}/${st.clarify.questions.length} 个疑点`,
    { detail: String(q).slice(0, 60), tag: '调用模型' })
  let answer = ''
  try {
    answer = (await callModel(chat, {
      system: '★你是这门课的教授。学员问了一个本课的问题。只依据课件原文回答，两三句讲清；'
        + '原文没写到的，直接说「原文没写，不能编，等助教确认」，不要用常识补。',
      prompt: `课程：${st.title}\n\n课件原文（节选）：\n${source.slice(0, 12000)}\n\n学员问题：${q}`,
      maxTokens: 2500,
    })).text
  } catch (e) {
    answer = '原文相关段落不足，我没法给出确定答复，请助教复核。'
    st.errors.push({ at: new Date().toISOString(), scope: 'clarify', message: String(e.message || e).slice(0, 160) })
  }
  st.clarify.answers.push({ q, a: answer })
  st.clarify.asked += 1
  await say(stateRoot, id, {
    id: `teach-${id}-clarify-${st.clarify.asked}`, role: 'professor', kind: 'teach',
    content: `学员问：${q}\n我先答：${answer}`,
    meta: { step: 'clarify', index: st.clarify.asked },
  })
  if (st.clarify.answers.length >= st.clarify.questions.length) {
    st.stage = 'exam'
    // 答疑收工，交给考核：判据看问过的有没有都答上、答不上来的有没有如实标出来
    const unanswerable = st.clarify.answers.filter(a => /不能编|等助教/.test(String(a.a || ''))).length
    await sayHandoff(stateRoot, id, {
      stage: 'clarify',
      from: '教授（答疑）',
      to: '当堂考核',
      delivered: `${st.clarify.answers.length} 个学员疑问逐条答完，其中 ${unanswerable} 条原文没写、如实标给助教。`,
      checks: [
        { name: '问题都答了', pass: st.clarify.answers.length >= st.clarify.questions.length, detail: `${st.clarify.answers.length} 问` },
        { name: '没编答案', pass: true, detail: `原文没写的 ${unanswerable} 条都标了等助教` },
      ],
      verdict: 'pass',
      next: `按 ${(st.prep.pack?.question_bank || []).length} 道题库抽题考`,
    })
    await say(stateRoot, id, {
      id: `teach-${id}-clarify-done`, role: 'professor', kind: 'teach',
      content: st.clarify.questions.length
        ? '以上是我的初步答复，助教可以随时插话补充或纠正；现在开始当堂抽查。'
        : '没有遗留问题，现在开始当堂抽查。',
      meta: { step: 'clarify-done' },
    })
  }
  await finishProgress(stateRoot, id, st,
    `答完第 ${st.clarify.asked} 问：`
    + (/不能编|等助教/.test(answer) ? '原文没写，已标给助教' : `给了 ${answer.length} 字答复`))
  await saveState(stateRoot, id, st)
  return { state: describe(st), needUser: false }
}

const APPLY_ANGLES = new Set(['判定边界', '数据口径', '流程与顺序', '责任划分', '反例与常见错法'])

/** A question that can be answered by reciting the source without thinking. */
export function isRecallQuestion(text) {
  const s = String(text || '').trim()
  // 兜底题固定写成「请说明：XX」，本身就是要学员背一条，按复述题算
  if (/^请(说明|简述|列举|写出|背出)/.test(s)) return true
  return /的定义是什么|的作用是什么|包含哪些|包括哪些|有哪些|是指什么|是什么$|有什么作用|分哪几类|分哪三类|的目的是|简述|列举/.test(s)
}

/** 用户插话能不能在原文里找到对应：只认逐字重合，不认意思相近。 */
export function supportQuote(source, text) {
  const src = String(source || '')
  const claim = String(text || '')
  if (!src || !claim) return ''
  const flat = s => s.replace(/\s+/g, '')
  const flatSrc = flat(src)
  const flatClaim = flat(claim).slice(0, 300)
  let hit = ''
  for (const len of [12, 10, 8, 6]) {
    for (let i = 0; i + len <= flatClaim.length; i++) {
      const win = flatClaim.slice(i, i + len)
      if (flatSrc.includes(win)) { hit = win; break }
    }
    if (hit) break
  }
  if (!hit) return ''
  const sentence = src.split(/[\n。；]/).find(line => flat(line).includes(hit))
  return String(sentence || hit).trim().slice(0, 160)
}

/** 考核题量：条款多就多考，每 5 条条款出一题，下限是配置里的题量，上限 24 题。 */
export function examTarget(st, cfg = {}) {
  const clauses = (st.prep?.map?.points || []).length
  const floor = Math.max(1, Number(cfg.maxQuestions) || LIMITS.maxQuestions)
  const scaled = clauses ? Math.round(clauses / 5) : 0
  return Math.max(floor, Math.min(LIMITS.maxExamQuestions, scaled))
}

/** 题库要出多少题：比考核题量多两道，留出挑选与去重的余地。 */
export function bankTarget(st, cfg = {}) {
  return Math.min(LIMITS.maxExamQuestions + 4, examTarget(st, cfg) + 2)
}

export function ensureQuestions(st, cfg) {
  if (st.exam.questions.length) return
  const bank = (st.prep.pack?.question_bank || []).filter(q => q.q)
  const target = examTarget(st, cfg)
  const limit = Math.max(1, Math.min(target, bank.length || target))
  // 用法题先选，复述题垫底；同一知识点只出一题，避免四道题问同一段原文。
  const rank = q => {
    const angle = String(q.angle || '').trim()
    if (APPLY_ANGLES.has(angle)) return 0
    return isRecallQuestion(q.q) ? 2 : 1
  }
  const ordered = [...bank].sort((a, b) => rank(a) - rank(b))
  const picked = []
  const seenPoints = new Set()
  for (const q of ordered) {
    if (picked.length >= limit) break
    const point = String(q.point_id || '')
    if (point && seenPoints.has(point)) continue
    if (point) seenPoints.add(point)
    picked.push({
      no: picked.length + 1,
      q: q.q,
      angle: String(q.angle || '').trim() || ANGLES[picked.length % ANGLES.length],
      pointId: point,
      answerContains: q.answer_contains || '',
      recall: isRecallQuestion(q.q),
      origin: 'course-pack', askedAt: '', answeredAt: '',
    })
  }
  if (!picked.length) {
    // explicit, labelled fallback: the pack had no questions, build from anchors
    const points = (st.prep.map?.points || []).slice(0, limit)
    points.forEach((p, i) => picked.push({
      no: i + 1, q: `请说明：${p.title}`, angle: '原文复述', pointId: p.id,
      answerContains: p.source || '', recall: true, origin: 'anchor-fallback', askedAt: '', answeredAt: '',
    }))
  }
  st.exam.questions = picked
  st.exam.recallHeavy = picked.filter(q => isRecallQuestion(q.q)).length * 2 > picked.length
  st.exam.applyCount = picked.filter(q => !isRecallQuestion(q.q)).length
}

async function examStep({ stateRoot, id, st, chat, cfg }) {
  ensureQuestions(st, cfg)

  // 助教纠正过的口径必须变成一道回归题，否则下一轮还是答错。
  const corrCount = (st.corrections || []).length
  if (corrCount > (st.exam.regressionFor || 0)) {
    const fresh = (st.corrections || []).slice(st.exam.regressionFor || 0)
    st.exam.regressionFor = corrCount
    const source = await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')
    const added = []
    for (const c of fresh.slice(-2)) {
      let data = null
      try {
        const res = await callModel(chat, {
          system: PROMPTS.regress,
          prompt: `课程：${st.title}\n\n助教课上纠正的是：${c.text}\n\n原文依据：${c.quote}\n\n课件原文（节选）：\n${source.slice(0, 8000)}`,
          maxTokens: 2500,
        })
        data = jsonOf(res.text)
      } catch (e) {
        st.errors.push({ at: new Date().toISOString(), scope: 'regress', message: String(e.message || e).slice(0, 160) })
      }
      // 模型偶尔会把「题目」当占位符抄回来，这种不能当真考题用
      const rawQ = String(data?.q || '').trim()
      const usable = rawQ.length >= 10 && !/^(题目|q|题干)/i.test(rawQ) && !/^[.…\s]+$/.test(rawQ)
      added.push({
        no: 0,
        q: (usable ? rawQ : `按本课原文「${c.quote}」，遇到同类情形该怎么判、该谁做？`).slice(0, 300),
        angle: String(data?.angle || '判定边界').slice(0, 40),
        pointId: '',
        answerContains: String(data?.answer_contains || c.quote).slice(0, 300),
        recall: usable ? isRecallQuestion(rawQ) : true,
        origin: 'user-correction', askedAt: '', answeredAt: '',
        correctedFrom: c.text.slice(0, 160),
      })
    }
    // 回归题放最前面：这一轮第一件事就是看它改没改过来
    st.exam.questions = [...added, ...st.exam.questions]
      .map((q, i) => ({ ...q, no: i + 1 }))
    const corrNs = added.map(q => q.no).join('、')
    await say(stateRoot, id, {
      id: `teach-${id}-regress-${st.exam.round}`, role: 'professor', kind: 'teach',
      content: `你纠正过 ${fresh.length} 条，我把它们变成回归题（第 ${corrNs} 题），这一轮必须考；`
        + '考不过就说明没真改过来，不会因为你上次说了就自动算过。',
      meta: { step: 'regression-made', count: added.length },
    })
    await saveState(stateRoot, id, st)
  }

  const total = st.exam.questions.length
  if (!total) {
    st.stage = 'confirm'
    st.confirm.at = new Date().toISOString()
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: true, note: '没有可考的题，直接进入结课确认' }
  }

  const pending = st.exam.questions.find(q => q.askedAt && !q.answeredAt)
  if (pending) {
    await markProgress(stateRoot, id, st, 'exam-grade',
      `第 ${pending.no}/${total} 题：学员作答、教授判卷`,
      { detail: String(pending.q).slice(0, 60), tag: '调用模型' })
    const source = await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')
    let answerText = ''
    try {
      const res = await callModel(chat, {
        system: PROMPTS.answer,
        prompt: `课程：${st.title}\n题目：${pending.q}\n\n课件原文（节选）：\n${source.slice(0, 10000)}`,
        maxTokens: 2500,
      })
      const data = jsonOf(res.text) || {}
      answerText = String(data.conclusion || res.text).trim()
      if (data.basis) answerText += `\n依据：${String(data.basis).trim()}`
      if (data.unsure) answerText += `\n（${String(data.unsure).trim()}）`
    } catch (e) {
      answerText = `这题我答不上来：${String(e.message || e).slice(0, 120)}`
    }
    await say(stateRoot, id, {
      id: `teach-${id}-q${pending.no}-a`, role: 'student', kind: 'answer',
      content: answerText.slice(0, 4000),
      meta: { step: 'exam-answer', no: pending.no },
    })

    let graded = null
    let gradeError = ''
    // 判分返回 0 分却一个字都没说，通常不是真 0 分，是模型回了半截 JSON；
    // 这种不能当成「答错」，重试一次，再不行就标成没判，不计分。
    for (let attempt = 0; attempt < 2 && !graded; attempt++) {
      try {
        const res = await callModel(chat, {
          system: PROMPTS.grade,
          prompt: `课程：${st.title}\n原文（节选）：\n${source.slice(0, 8000)}\n\n题目：${pending.q}\n\n`
            + `判分关键词：${pending.answerContains || '（无）'}\n\n学员作答：${answerText}`,
          maxTokens: 2500,
        })
        const data = jsonOf(res.text)
        if (!data) { gradeError = '判分没给出 JSON'; continue }
        const score = Math.max(0, Math.min(100, Number(data.score)))
        const comment = String(data.comment || '').slice(0, 300)
        const gap = String(data.gap || '').slice(0, 240)
        const correct = String(data.correct || '').slice(0, 600)
        if (!Number.isFinite(score)) { gradeError = '判分没给出分数'; continue }
        if (score === 0 && !comment && !gap && !correct) { gradeError = '判分给 0 分却没有任何说明'; continue }
        graded = {
          score,
          passed: data.passed == null ? score >= 70 : Boolean(data.passed),
          comment, gap, correct, ungraded: false,
        }
      } catch (e) {
        gradeError = String(e.message || e).slice(0, 160)
      }
    }
    if (!graded) {
      graded = { score: null, passed: false, comment: `判分没跑成（${gradeError || '未知原因'}），这题先不计分。`, gap: '', correct: '', ungraded: true }
      st.errors.push({ at: new Date().toISOString(), scope: 'grade', message: gradeError || '判分失败' })
    }
    pending.answeredAt = new Date().toISOString()
    Object.assign(pending, graded)
    pending.answer = answerText.slice(0, 1500)
    if (pending.origin === 'user-correction' && graded.score != null) {
      st.exam.regression = st.exam.regression || { asked: 0, passed: 0 }
      st.exam.regression.asked = (st.exam.regression.asked || 0) + 1
      if (graded.score >= 70) st.exam.regression.passed = (st.exam.regression.passed || 0) + 1
    }
    const low = graded.score != null && graded.score < 70
    const noteSuffix = low && (graded.correct || graded.gap) ? '（这条纠错已写进课堂笔记）' : ''
    await say(stateRoot, id, {
      id: `teach-${id}-q${pending.no}-g`, role: 'professor', kind: low ? 'correction' : 'teach',
      content: graded.score == null
        ? `第 ${pending.no} 题没判成：${graded.comment}这题不计分，回头重考一次。`
        : `第 ${pending.no} 题 ${graded.score} 分。${graded.comment}`
          + (low && graded.correct ? `\n正确口径：${graded.correct}` : '')
          + noteSuffix,
      meta: { step: 'exam-grade', no: pending.no, score: graded.score, passed: graded.passed, ungraded: Boolean(graded.ungraded) },
    })
    if (low && graded.gap) st.exam.gaps.push(graded.gap)
    await atomicWrite(join(dirOf(stateRoot, id), 'student-notes.md'), renderStudentNotes(st))
    await finishProgress(stateRoot, id, st,
      graded.score == null
        ? `第 ${pending.no} 题没判成，先不计分`
        : `第 ${pending.no} 题 ${graded.score} 分${graded.passed ? '，过了' : '，没过'}`,
      graded.score != null)
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }

  const next = st.exam.questions.find(q => !q.askedAt)
  if (next) {
    await markProgress(stateRoot, id, st, 'exam-ask',
      `出第 ${next.no}/${total} 题（${next.angle || '概念与定义'}）`,
      { detail: next.q ? '从题库抽题' : '题库没这题，现出一题', tag: next.q ? '抽题' : '调用模型' })
    let question = next.q
    if (!question) {
      try {
        question = (await callModel(chat, {
          system: PROMPTS.teach.replace('{angle}', next.angle || '概念与定义'),
          prompt: `课程：${st.title}\n\n课件原文（节选）：\n${(await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')).slice(0, 8000)}`,
          maxTokens: 1200,
        })).text
      } catch { question = '请说明本课最核心的一条口径。' }
      next.q = question
    }
    next.askedAt = new Date().toISOString()
    await say(stateRoot, id, {
      id: `teach-${id}-q${next.no}`, role: 'professor', kind: 'teach',
      content: `第 ${next.no} 题（${next.angle}）：${question}`,
      meta: { step: 'exam-ask', no: next.no, angle: next.angle },
    })
    await finishProgress(stateRoot, id, st,
      `第 ${next.no} 题已出：${String(question).slice(0, 80)}`)
    await saveState(stateRoot, id, st)
    return { state: describe(st), needUser: false }
  }

  // 有题没判成：重考这几道，别把「没判过」当「答错了」
  const ungraded = st.exam.questions.filter(q => q.askedAt && q.score == null)
  if (ungraded.length && (st.exam.regrade || 0) < 2) {
    st.exam.regrade = (st.exam.regrade || 0) + 1
    st.exam.questions = ungraded.map((q, i) => ({
      ...q, no: i + 1, askedAt: '', answeredAt: '', answer: '', score: null, gap: '', correct: '', comment: '',
    }))
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      id: `teach-${id}-regrade-${st.exam.regrade}`, role: 'professor', kind: 'teach',
      content: `有 ${ungraded.length} 道题判分没跑成，重考这几道。没判过的题不算你答错，也不进平均分。`,
      meta: { step: 'regrade', count: ungraded.length },
    })
    return { state: describe(st), needUser: false }
  }

  // round finished
  const scored = st.exam.questions.filter(q => q.score != null)
  const avg = scored.length ? Math.round(scored.reduce((n, q) => n + q.score, 0) / scored.length) : 0
  const passLine = Math.round((Number(cfg.passThreshold) || 0.75) * 100)
  st.exam.avg = avg
  st.exam.history.push({ round: st.exam.round, avg, at: new Date().toISOString() })
  const allAnchor = scored.length > 0 && scored.every(q => q.origin === 'anchor-fallback')
  await say(stateRoot, id, {
    id: `teach-${id}-round${st.exam.round}`, role: 'professor', kind: 'teach',
    content: `这一轮考完：${scored.length} 题，平均 ${avg} 分，结课线 ${passLine} 分。`
      + (allAnchor
        ? '（要说明：这一轮没有真考题，用的是原文标题抽查，本质是复述，只能说明笔记抄得全，不能说明会用。）'
        : st.exam.recallHeavy ? '（这一轮复述题偏多，查的是背得下来，不是用得上；下轮我会多出用法题。）' : '')
      + (st.exam.gaps.length ? `主要缺口：${st.exam.gaps.slice(0, 3).join('；')}` : '要点基本都答到了。'),
    meta: { step: 'exam-round', round: st.exam.round, avg, passLine, recallHeavy: Boolean(st.exam.recallHeavy), allAnchor },
  })
  const regFailed = st.exam.questions.filter(q => q.origin === 'user-correction' && q.score != null && q.score < 70)
  const mustFixRegression = regFailed.length > 0 && (st.exam.regression?.retries || 0) < 1
  if ((avg < passLine || mustFixRegression) && st.study.loops < LIMITS.maxStudyLoops) {
    if (mustFixRegression) st.exam.regression.retries = (st.exam.regression.retries || 0) + 1
    const failed = mustFixRegression && avg >= passLine
      ? regFailed
      : scored.filter(q => q.score != null && q.score < 70)
    const retry = failed.length ? failed : scored
    const titles = failed.length ? await locateChapters(stateRoot, id, st, failed) : []
    st.study.loops += 1
    st.study.history.push({
      round: st.exam.round,
      summary: `平均 ${avg} 分未达标，按 ${failed.length} 道错题定向重学${titles.length ? `（${titles.join('、')}）` : '（定位不到章节，整门重看）'}`,
    })
    st.study.parts = []
    st.study.summary = null
    st.study.focus = [
      ...failed.map(q => q.gap || q.q).slice(0, 3),
      st.exam.gaps.slice(0, 2),
    ].filter(Boolean).join('；')
    st.study.scoped = titles.length
      ? { round: st.exam.round + 1, titles, targets: failed.map(q => q.pointId).filter(Boolean), from: failed.map(q => q.no) }
      : null
    st.exam.round += 1
    // 下一轮只考错的题（外加回归题），答对的题不再重问一遍
    st.exam.questions = retry.map((q, i) => ({
      no: i + 1, q: q.q, angle: q.angle, pointId: q.pointId,
      answerContains: q.answerContains, origin: q.origin, recall: Boolean(q.recall),
      correctedFrom: q.correctedFrom || '', askedAt: '', answeredAt: '',
    }))
    st.exam.gaps = []
    st.stage = 'study'
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      id: `teach-${id}-relearn-${st.study.loops}`, role: 'professor', kind: 'teach',
      content: (mustFixRegression
        ? `平均分够了，但你纠正过的那条我还是没考过（第 ${regFailed.map(q => q.no).join('、')} 题）。纠错没闭环不算学会，我再补一轮。`
        : `没到结课线，不硬结。${failed.length ? `错的只有 ${failed.length} 道题（第 ${failed.map(q => q.no).join('、')} 题）` : '没有单题低于 70 分的，是整体偏弱'}，`)
        + (titles.length
          ? `我只重学这几章：${titles.join('、')}，别的章节不陪你重读；下一轮也只重考错的那几道。`
          : '错题对不上具体章节，只能整门再看一遍；下一轮只重考错的那几道。')
        + `\n薄弱点：${st.study.focus}`,
      meta: { step: 'relearn', loop: st.study.loops, failed: failed.length, scoped: titles.length },
    })
    return { state: describe(st), needUser: false }
  }
  st.stage = 'confirm'
  st.confirm.at = new Date().toISOString()
  const brief = buildBrief(st, cfg)
  st.confirm.brief = brief
  await saveState(stateRoot, id, st)
  // 考核收工，交给用户：判据是分数过线、每题都判成、纠正过的有回归题验证
  const ungradedCount = st.exam.questions.filter(q => q.askedAt && q.score == null).length
  const reg = st.exam.regression || { asked: 0, passed: 0 }
  await sayHandoff(stateRoot, id, {
    stage: 'exam',
    from: '学员与教授',
    to: '您（结课确认）',
    delivered: `${scored.length} 道题逐题问答、逐题判分，平均 ${avg} 分，结课线 ${passLine} 分。`,
    checks: [
      { name: '平均分过线', pass: avg >= passLine, detail: `${avg} 分 / 线 ${passLine}` },
      { name: '每题都判成', pass: ungradedCount === 0, detail: ungradedCount ? `${ungradedCount} 题没判成` : '没有漏判' },
      { name: '纠错有验证', pass: !reg.asked || reg.passed === reg.asked, detail: reg.asked ? `回归题 ${reg.asked} 道过 ${reg.passed} 道` : '本轮没有您纠正过的题' },
    ],
    verdict: 'pass',
    next: '等您拍板结课',
  })
  await sayConfirmAsk(stateRoot, id, st, brief, avg, passLine)
  return { state: describe(st), needUser: true }
}

/** 结课确认那条要落进课堂的话。id 固定，重复调用不会重复入账。 */
async function sayConfirmAsk(stateRoot, id, st, brief, avg, passLine) {
  const payload = {
    id: `teach-${id}-confirm`, role: 'professor', kind: 'teach',
    content: `课上完了，结课前先把这门课的账对一遍，你看的是「这份规范有没有按原文理解对」，不是「文件传上去了没有」：\n`
      + `${briefText(brief, st)}\n`
      + '没问题就确认结课；有问题直接点「第几条」，我改完重审再请你确认。',
    // 摘要只放计数：完整的 brief 走 describe()，塞进消息 meta 会把整条消息撑到写不进去
    meta: {
      step: 'confirm-ask', avg, passLine,
      auditTotal: brief.audit?.total || 0,
      clauses: brief.clauses?.total || 0,
      notesChars: brief.notesChars || 0,
    },
  }
  const room = await getClassroom(stateRoot, id)
  if ((room.messages || []).some(m => m.id === payload.id)) return false
  await say(stateRoot, id, payload)
  return true
}

/**
 * 阶段交接单：谁把什么交给谁、按什么判据验收、过没过。
 * 只在会话记录里留痕，不打断流程；判据不过才由调用方决定升级给用户。
 */
async function sayHandoff(stateRoot, id, { stage, from, to, delivered, checks = [], verdict = 'pass', next = '' }) {
  const passed = checks.filter(c => c.pass).length
  const lines = [
    `交接：${from} → ${to}｜${STAGE_LABEL[stage] || stage}`,
    `交了什么：${delivered}`,
    checks.length
      ? `验收判据（${passed}/${checks.length} 过）：${checks.map(c => `${c.name}${c.pass ? ' 过' : ' 没过'}${c.detail ? `（${c.detail}）` : ''}`).join('；')}`
      : '验收判据：这一阶段没有可机器判的项，按产出是否齐全看。',
    `结论：${verdict === 'pass' ? '通过' : '没过'}${next ? `，${next}` : ''}`,
  ]
  const payload = {
    id: `teach-${id}-handoff-${stage}`,
    role: 'system',
    kind: 'system',
    content: lines.join('\n'),
    meta: {
      step: 'handoff', stage, from, to, verdict,
      passed, total: checks.length,
      checks: checks.map(c => ({ name: String(c.name).slice(0, 40), pass: Boolean(c.pass), detail: String(c.detail || '').slice(0, 60) })),
    },
  }
  const room = await getClassroom(stateRoot, id)
  if ((room.messages || []).some(m => m.id === payload.id)) return false
  await say(stateRoot, id, payload)
  return true
}

/* ----------------------------------------------------------- user side */

/** User speaks in class: append, then let the student restate what it changed. */
export async function sayToClass(stateRoot, options) {
  const { chat } = options || {}
  const id = safeId(options.id)
  const text = String(options.text || '').trim()
  if (!text) throw httpError('发言不能为空', 400)
  if (text.length > 4000) throw httpError('单条发言超过 4000 字符', 413)
  const st = await loadState(stateRoot, id)
  const kind = options.kind === 'question' ? 'question' : 'correction'

  await say(stateRoot, id, { role: 'user', kind, content: text, meta: { step: 'user-say' } })
  st.notes = [...(st.notes || []), text].slice(-8)

  let reply = ''
  // 先做一遍确定性核对：用户这条能不能在原文里逐字找到落点。
  // 找到了就不许学员说「不属于本课」——那是把助教的补充当耳旁风。
  let support = ''
  try {
    support = supportQuote(await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8'), text)
  } catch { support = '' }
  try {
    reply = (await callModel(chat, {
      system: PROMPTS.restate,
      prompt: `课程：${st.title}\n\n你自学记的要点：\n${(st.study.parts.flatMap(p => p.points || []).slice(0, 12)
        .map(p => `${p.title}：${p.rule || p.source}`).join('\n') || '（还没学完）').slice(0, 3000)}`
        + `\n\n${support ? `原文里有这一句：${support}` : '旁证：原文里找不到这一句的对应句子。'}`
        + `\n\n助教说：${text}`,
      maxTokens: 2500,
    })).text
  } catch (e) {
    reply = '这条我还没完全理解透，助教能再说具体一点吗？'
    st.errors.push({ at: new Date().toISOString(), scope: 'restate', message: String(e.message || e).slice(0, 160) })
  }
  let offCourse = /不属于本课|不属于这门课|课外参考|不是本课/.test(reply)
  if (offCourse && support) {
    // 原文对得上，学员还往外推：按误判处理，记一笔，不硬改它的话，但按本课内容收下
    offCourse = false
    reply += '（原文里有对应口径，这条我收回，按本课内容记下。）'
    st.errors.push({ at: new Date().toISOString(), scope: 'restate-misfire', message: `原文对得上却被判课外：${support.slice(0, 80)}` })
  }
  if (!offCourse) {
    st.notes = [...(st.notes || []), reply].slice(-8)
    st.study.focus = [st.study.focus, text].filter(Boolean).join('；').slice(-400)
    // 带原文落点的纠错才落成条款更正，之后要出回归题；找不到原句的只当课外补充
    if (support) {
      st.corrections = [...(st.corrections || []), {
        at: new Date().toISOString(), text: text.slice(0, 300), quote: support, kind,
      }].slice(-8)
    }
  }
  const res = await say(stateRoot, id, {
    role: 'student', kind: 'note',
    content: reply + (offCourse ? '（这条我当课外参考，没写进本课笔记）' : '（已记进本课的补充与理解）'),
    meta: { step: 'restate', offCourse, support: Boolean(support) },
  })
  await saveState(stateRoot, id, st)
  return { ...res, teaching: describe(st) }
}

/**
 * 审核卡在硬问题上的开课许可。
 * 同意就开课，问题记进结课账；不同意就按用户的话改课程包，清掉审核结论重审一遍。
 * 改稿轮次最多两轮：再改下去也只是在原文边缘打转，不如换个教材。
 */
export async function openClass(stateRoot, options) {
  const { chat } = options || {}
  const id = safeId(options.id)
  const st = await loadState(stateRoot, id)
  if (st.stage !== 'prep') {
    throw httpError(`现在不在开课前审核阶段（当前：${STAGE_LABEL[st.stage] || st.stage}）`, 409)
  }
  const audit = st.prep?.audit
  if (!audit || audit.gate !== 'blocked') throw httpError('现在没有待批的审核问题，不需要开课许可', 409)
  const approve = Boolean(options.approve)
  const comment = String(options.comment || '').trim().slice(0, 2000)
  const hard = (audit.issues || []).filter(x => !x.advisory)

  if (approve) {
    audit.gate = 'passed'
    st.prep.gateDecision = {
      at: new Date().toISOString(), approve: true, comment,
      openIssues: hard.filter(x => !x.resolved).length,
    }
    st.stage = 'study'
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      role: 'user', kind: 'note', content: comment || '照现有课程包开课，问题记在结课账上。',
      meta: { step: 'gate-open' },
    })
    await say(stateRoot, id, {
      role: 'professor', kind: 'teach',
      content: `行，按现在的课程包开课。${hard.filter(x => !x.resolved).length} 条没改的硬问题记在账上，结课时一并给你看。`,
      meta: { step: 'gate-passed' },
    })
    // 您放行也是一次交接，记下放行了几条、交给学员
    await sayHandoff(stateRoot, id, {
      stage: 'prep',
      from: '您',
      to: '学员',
      delivered: `您放行了 ${hard.filter(x => !x.resolved).length} 条硬问题，课程包按现状开课。`,
      checks: [
        { name: '条款与题库齐全', pass: Boolean(st.prep?.map && st.prep?.pack), detail: `${(st.prep?.map?.points || []).length} 条条款 / ${(st.prep?.pack?.question_bank || []).length} 题` },
        { name: '硬问题清零', pass: hard.filter(x => !x.resolved).length === 0, detail: `${hard.filter(x => !x.resolved).length} 条放行，记在结课账` },
      ],
      verdict: 'pass',
      next: '学员按原文分段自学',
    })
    await say(stateRoot, id, {
      id: `teach-${id}-study-start`, role: 'professor', kind: 'teach',
      content: `审核过了，我开始自己学。原文共 ${st.sourceChars} 字，我会分 ${studyParts(st.chapters).length} 段逐段读，读完把覆盖清单和没弄懂的问题交给你。`,
      meta: { step: 'study-start' },
    })
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: describe(st) }
  }

  if (!comment) throw httpError('要说清楚哪里不对：点出「第几条」，或者直接写一句该怎么改', 400)

  // 点到的编号记成「已按用户意见处理」，改完重审时仍按原文逐字比对
  const cited = [...comment.matchAll(/第\s*(\d+)\s*条/g)].map(m => Number(m[1]))
  const hit = []
  for (const no of cited) {
    const issue = (audit.issues || []).find(x => x.no === no)
    if (issue && !issue.resolved) {
      issue.resolved = true
      issue.resolvedBy = comment.slice(0, 200)
      issue.resolvedAt = new Date().toISOString()
      hit.push(no)
    }
  }
  await say(stateRoot, id, {
    role: 'user', kind: 'correction', content: comment, meta: { step: 'gate-hold', cited: hit },
  })

  const source = await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')
  const rounds = Number(st.prep.gateRounds || 0) + 1
  st.prep.gateRounds = rounds
  let data = null
  let error = ''
  try {
    const res = await callModel(chat, {
      system: PROMPTS.fix,
      prompt: `课程：${st.title}\n\n教务的意见：${comment}\n\n`
        + `被点到的条目：${hit.length ? `第 ${hit.join('、')} 条` : '（没点编号，按意见整段处理）'}\n\n`
        + '审核问题清单：\n'
        + hard.slice(0, 12).map(x => `第 ${x.no} 条（${x.where || '未定位'}）：${x.message}`
          + (x.quote ? `｜${String(x.quote).slice(0, 100)}` : '')).join('\n')
        + `\n\n现有课程包：\n${JSON.stringify(st.prep.pack).slice(0, 12000)}\n\n课件原文：\n${source.slice(0, 20000)}`,
      maxTokens: 14000,
      grow: true,
    })
    data = jsonOf(res.text)
    if (!data) error = '模型没给出可解析的 JSON'
  } catch (e) {
    error = String(e.message || e).slice(0, 160)
  }

  if (!data) {
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      role: 'professor', kind: 'teach',
      content: `你的意思我收到了，但这次没改出来（${error || '模型没给出可解析的 JSON'}）。要么再说一次，要么就照现有课程包开课。`,
      meta: { step: 'gate-fix-failed', error },
    })
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: describe(st), needUser: true }
  }

  // 只替换新包里有内容的字段，没提到的保留旧值，避免一次改稿把题库清空
  const old = st.prep.pack || {}
  const bank = (data.question_bank || []).filter(x => x && x.q).slice(0, 40)
  const focus = (data.focus_points || []).filter(x => x && x.title).slice(0, 24)
  const order = (data.teaching_order || []).filter(x => String(x || '').trim())
  st.prep.pack = {
    ...old,
    overview: String(data.overview || old.overview || '').slice(0, 600),
    teaching_order: (order.length ? order : old.teaching_order || [])
      .map(x => String(x).slice(0, 90)).slice(0, 24),
    focus_points: (focus.length ? focus : old.focus_points || []).map(f => ({
      point_id: String(f.point_id || '').slice(0, 12),
      title: String(f.title).slice(0, 80),
      why: String(f.why || '').slice(0, 200),
      source: String(f.source || '').slice(0, 300),
    })),
    question_bank: (bank.length ? bank : old.question_bank || []).map(q => ({
      point_id: String(q.point_id || '').slice(0, 12),
      q: String(q.q).slice(0, 300),
      answer_contains: String(q.answer_contains || '').slice(0, 300),
      angle: String(q.angle || '').slice(0, 40),
    })),
    common_misconceptions: ((data.common_misconceptions || []).length
      ? data.common_misconceptions : old.common_misconceptions || [])
      .map(x => String(x).slice(0, 200)).slice(0, 12),
    revisedAt: new Date().toISOString(),
    revisionRounds: rounds,
  }
  st.prep.packChars = JSON.stringify(st.prep.pack).length
  await atomicWrite(join(dirOf(stateRoot, id), 'course-pack.json'), `${JSON.stringify(st.prep.pack, null, 2)}\n`)
  await atomicWrite(join(dirOf(stateRoot, id), 'course-pack.md'), renderPack(st))
  // 审核结论作废，下一次 advance 重审
  st.prep.audit = null
  st.prep.gateDecision = { at: new Date().toISOString(), approve: false, comment, cited: hit, round: rounds }
  await saveState(stateRoot, id, st)
  await say(stateRoot, id, {
    role: 'professor', kind: 'teach',
    content: `按你说的改了：${st.prep.pack.focus_points.length} 个重点、${st.prep.pack.question_bank.length} 道题。`
      + '我重审一遍，这次只看原文依据、判分关键词、章节覆盖、表格章节四项。'
      + (rounds >= 2 ? '\n已经改过两轮，再审不过就别在这份原文上耗，我们商量要不要换教材。' : ''),
    meta: { step: 'gate-revised', cited: hit, round: rounds, questions: st.prep.pack.question_bank.length },
  })
  return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: describe(st), needUser: false }
}

/** User decides whether to close the class. Never auto-close. */
export async function decideClass(stateRoot, options) {
  const { chat } = options || {}
  const id = safeId(options.id)
  const st = await loadState(stateRoot, id)
  if (st.stage !== 'confirm') throw httpError(`现在不在结课确认阶段（当前：${STAGE_LABEL[st.stage]}）`, 409)
  const agree = Boolean(options.agree)
  const comment = String(options.comment || '').trim().slice(0, 2000)

  if (!agree) {
    await say(stateRoot, id, { role: 'user', kind: 'correction', content: comment || '先不结课，继续学。', meta: { step: 'decide-no' } })
    // 点到「第 N 条」的，按编号记成已按用户意见处理，重审照样只认确定性项
    const cited = [...String(comment).matchAll(/第\s*(\d+)\s*条/g)].map(m => Number(m[1]))
    const hit = []
    if (cited.length && st.prep.audit?.issues) {
      for (const no of cited) {
        const issue = st.prep.audit.issues.find(x => x.no === no)
        if (issue && !issue.resolved) {
          issue.resolved = true
          issue.resolvedBy = comment.slice(0, 200)
          issue.resolvedAt = new Date().toISOString()
          hit.push(no)
        }
      }
    }
    let reply = ''
    if (comment) {
      try {
        reply = (await callModel(chat, {
          system: PROMPTS.restate,
          prompt: `课程：${st.title}\n\n助教的意见：${comment}`,
          maxTokens: 2500,
        })).text
      } catch { reply = '这条我记下了，下一轮按这个改。' }
    }
    if (reply) {
      await say(stateRoot, id, { role: 'student', kind: 'note', content: reply, meta: { step: 'decide-restate' } })
      st.notes = [...(st.notes || []), comment, reply].slice(-8)
    }
    // 有原文落点的意见进纠错账，下一轮出成回归题
    let support = ''
    try {
      support = supportQuote(await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8'), comment)
    } catch { support = '' }
    if (support && comment) {
      st.corrections = [...(st.corrections || []), {
        at: new Date().toISOString(), text: comment.slice(0, 300), quote: support, kind: 'correction',
      }].slice(-8)
    }
    let titles = []
    if (support) titles = await locateChapters(stateRoot, id, st, [{ q: comment, answerContains: `"${support}"` }])
    const canLoop = st.study.loops < LIMITS.maxStudyLoops
    st.confirm = { ...st.confirm, agreed: false, comment, decidedAt: new Date().toISOString() }
    if (canLoop) {
      st.study.loops += 1
      st.study.parts = []
      st.study.summary = null
      st.study.focus = [st.exam.gaps.slice(0, 2).join('；'), comment].filter(Boolean).join('；').slice(0, 400)
      st.study.scoped = titles.length ? { round: st.exam.round + 1, titles, targets: [], from: [] } : null
      st.exam.round += 1
      const failedQs = st.exam.questions.filter(q => q.score != null && q.score < 70)
      const retryQs = failedQs.length ? failedQs : st.exam.questions
      st.exam.questions = retryQs.map((q, i) => ({
        no: i + 1, q: q.q, angle: q.angle, pointId: q.pointId,
        answerContains: q.answerContains, origin: q.origin, recall: Boolean(q.recall),
        correctedFrom: q.correctedFrom || '', askedAt: '', answeredAt: '',
      }))
      st.exam.gaps = []
      st.stage = 'study'
    }
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      id: `teach-${id}-continue-${st.study.loops}`, role: 'professor', kind: 'teach',
      content: (hit.length ? `你点到的第 ${hit.join('、')} 条我标成按你的意见处理了，重审还是只认原文依据、判分关键词、章节覆盖、表格这四项。\n` : '')
        + (canLoop
          ? (titles.length
            ? `行，不结课。这条落在 ${titles.join('、')}，我只重学这几章，再把你这条变成回归题，重考时先考它。`
            : '行，不结课，我按你的意见再带一轮，重学完重考；这条在原文里找不到原句，我按补充口径处理，没法当条款出回归题。')
          : `已经重学 ${st.study.loops} 轮了，再自动循环意义不大；你可以直接提要求，我按你说的改，或者再点一次结课。`),
      meta: { step: 'continue', cited: hit, scoped: titles.length },
    })
    return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: describe(st) }
  }

  const scored = st.exam.questions.filter(q => q.score != null)
  const avg = scored.length ? Math.round(scored.reduce((n, q) => n + q.score, 0) / scored.length) : 0
  st.stage = 'finished'
  st.confirm = { ...st.confirm, agreed: true, comment, decidedAt: new Date().toISOString() }
  const brief = buildBrief(st, options?.cfg || {})
  st.confirm.brief = brief
  const summary = {
    title: st.title, courseId: st.courseId || id, finishedAt: new Date().toISOString(),
    sourceChars: st.sourceChars, chapters: st.chapters.length, sections: (st.sections || []).length,
    points: st.prep.map?.points?.length || 0,
    studyPoints: st.study.parts.flatMap(p => p.points || []).length,
    coverage: st.study.coverageAll
      ? `${st.study.coverageAll.covered.length}/${st.study.coverageAll.total}`
      : (st.study.summary?.coverage ? `${st.study.summary.coverage.covered.length}/${st.study.summary.coverage.total}` : ''),
    avg, passLine: Math.round((Number(options.cfg?.passThreshold) || 0.75) * 100),
    questions: scored.length, gaps: st.exam.gaps.slice(0, 5),
    loops: st.study.loops, comment,
    fallbackChapters: st.prep.chapters.filter(c => c.fallback).length,
    brief,
    corrections: (st.corrections || []).length,
    regression: { asked: st.exam.regression?.asked || 0, passed: st.exam.regression?.passed || 0 },
    exam: scored.map(q => ({
      no: q.no, q: q.q, score: q.score, passed: q.passed !== false, gap: q.gap || '',
      origin: q.origin || '', recall: Boolean(q.recall),
    })),
    artifacts: ['scope.json', 'professor-notes.md', 'knowledge-map.json', 'course-pack.json', 'course-pack.md',
      'professor-audit.json', 'student-notes.md', 'class-notes.md', 'dialogue.jsonl'],
  }
  await atomicWrite(join(dirOf(stateRoot, id), 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await saveState(stateRoot, id, st)
  await say(stateRoot, id, {
    id: `teach-${id}-finished`, role: 'system', kind: 'system',
    content: `用户确认结课，这份概要就是上架凭据。${scored.length} 题平均 ${avg} 分；重学 ${st.study.loops} 轮；`
      + `知识地图${brief.clauses.origin === 'fallback' ? '没拆成条款，用的是原文锚点兜底' : `拆出 ${brief.clauses.total} 条可执行条款`}；`
      + `审核问题 ${brief.audit.total} 条（硬问题 ${brief.audit.hard} 条${brief.audit.hard ? '，开课前你选择放行，账记在概要里' : ''}，`
      + `已按你的意见处理 ${brief.audit.resolved} 条）；`
      + `回归题 ${summary.regression.asked} 道过 ${summary.regression.passed} 道。课堂笔记、学员笔记、课程包、审核记录都在本课堂目录里。`,
    meta: {
      step: 'finished', avg,
      auditTotal: brief.audit?.total || 0,
      clauses: brief.clauses?.total || 0,
      notesChars: brief.notesChars || 0,
      questions: scored.length,
    },
  })
  return { classroom: (await getClassroom(stateRoot, id)).classroom, teaching: describe(st), summary }
}

/* -------------------------------------------------------------- public */

/** Open (or re-open) a class for this classroom and store the source text. */
export async function openTeaching(stateRoot, options = {}) {
  const incoming = String(options.source == null ? '' : options.source)
  if (incoming.trim() && incoming.length > LIMITS.maxSourceChars) {
    throw httpError(`原文 ${incoming.length} 字，超过单课上限定 ${LIMITS.maxSourceChars} 字；请按章节拆成多门课`, 413)
  }
  const id = safeId(options.id)
  const dir = dirOf(stateRoot, id)
  await mkdir(dir, { recursive: true })
  const classroom = (await getClassroom(stateRoot, id)).classroom
  const sourcePath = join(dir, 'source.md')
  let existing = null
  try { existing = await readFile(sourcePath, 'utf8') } catch { /* first time */ }
  const title = String(options.title || classroom.title || '课堂').slice(0, 160)

  if (existing == null && !incoming.trim()) {
    throw httpError('这间课堂还没有原文：请先上传课件，或把原文贴进来', 400)
  }
  if (incoming.trim() && existing !== incoming) {
    await atomicWrite(sourcePath, incoming)
    existing = incoming
  }
  const source = existing || ''
  const chapters = splitChapters(source)

  let st = await readJson(join(dir, 'teaching.json'), null)
  if (!st || st.sourceHash !== sha256(source)) {
    st = freshState({ title, source, sourceName: options.sourceName })
    st.chapters = chapters.map(c => ({ index: c.index, title: c.title, chars: c.text.length }))
    st.sections = sectionTitles(source).slice(0, 300)
    // 章节元数据开课时就登记：审核要用它判断表格章节有没有被整体略过
    st.prep = st.prep && typeof st.prep === 'object' ? st.prep : {}
    if (!(st.prep.chapters || []).length) {
      st.prep.chapters = chapters.map(c => ({
        index: c.index, title: c.title, sourceChars: c.text.length,
        noteChars: 0, hasTable: /\n\s*\|[^\n]*\|/.test(c.text),
        tableKeys: tableKeysOf(c.text), skipped: true,
      }))
    }
    await saveState(stateRoot, id, st)
    await say(stateRoot, id, {
      id: `teach-${id}-source`, role: 'system', kind: 'source',
      content: `原文已入库：${st.sourceChars} 字，分 ${chapters.length} 章。这间课堂往后只认这份原文，教材换了要另开课堂。`,
      meta: { step: 'source', chapters: chapters.length, hash: st.sourceHash.slice(0, 12) },
    })
  } else {
    st.title = title
    st.chapters = chapters.map(c => ({ index: c.index, title: c.title, chars: c.text.length }))
    st.sections = sectionTitles(source).slice(0, 300)
    // 章节元数据开课时就登记：审核要用它判断表格章节有没有被整体略过
    st.prep = st.prep && typeof st.prep === 'object' ? st.prep : {}
    if (!(st.prep.chapters || []).length) {
      st.prep.chapters = chapters.map(c => ({
        index: c.index, title: c.title, sourceChars: c.text.length,
        noteChars: 0, hasTable: /\n\s*\|[^\n]*\|/.test(c.text),
        tableKeys: tableKeysOf(c.text), skipped: true,
      }))
    }
    await saveState(stateRoot, id, st)
  }
  return { classroom, teaching: describe(st), chapters: st.chapters }
}

export async function teachingState(stateRoot, id) {
  const st = await loadState(stateRoot, id)
  return describe(st)
}

export function describe(st, cfg = {}) {
  const chapters = st.chapters || []
  const prepDone = (st.prep.chapters || []).length
  const parts = st.study.parts || []
  const partsDone = parts.filter(p => p.status === 'done').length
  const scored = (st.exam.questions || []).filter(q => q.score != null)
  const avg = scored.length ? Math.round(scored.reduce((n, q) => n + q.score, 0) / scored.length) : null
  const bankSize = (st.prep.pack?.question_bank || []).length
  const plannedTotal = (st.exam.questions || []).length || Math.min(LIMITS.maxExamQuestions, bankSize)
  const auditIssues = st.prep.audit?.issues || []
  return {
    stage: st.stage,
    stageLabel: STAGE_LABEL[st.stage] || st.stage,
    // 机器正在做的事：只给界面看，不进对话。没有这一步就是空闲。
    progress: st.progress ? { key: st.progress.key, label: st.progress.label, at: st.progress.at } : null,
    // 动作流：正在做什么、做完了什么、花了多久。课堂对话框下面是照着这个渲染的。
    activity: (st.activity || []).slice(-14).map(a => ({
      id: a.id, key: a.key, label: a.label, detail: a.detail || '', tag: a.tag || '',
      at: a.at, doneAt: a.doneAt || '', status: a.status,
      ms: a.ms == null ? null : a.ms, result: a.result || '',
    })),
    title: st.title,
    sourceChars: st.sourceChars,
    sourceHash: (st.sourceHash || '').slice(0, 12),
    chapters: chapters.length,
    sections: (st.sections || []).length,
    scope: st.prep.scope
      ? {
        appliesTo: st.prep.scope.applies_to || [],
        version: st.prep.scope.version || '',
        effectiveDate: st.prep.scope.effective_date || '',
        mandatory: st.prep.scope.mandatory || '',
        origin: st.prep.scope.origin || '',
      }
      : null,
    prep: {
      scope: Boolean(st.prep.scope),
      map: st.prep.map ? (st.prep.map.points || []).length : 0,
      clauses: clauseStats(st.prep.map?.points || []),
      chaptersDone: (st.prep.chapters || []).length,
      chaptersTotal: chapters.length,
      fallbackChapters: (st.prep.chapters || []).filter(c => c.fallback).length,
      pack: Boolean(st.prep.pack),
      questions: (st.prep.pack?.question_bank || []).length,
      auditStatus: st.prep.audit?.status || '',
      auditGate: st.prep.audit?.gate || '',
      gateBlocked: st.stage === 'prep' && st.prep.audit?.gate === 'blocked',
      gateRounds: st.prep.gateRounds || 0,
      gateComment: st.prep.gateDecision?.comment || '',
      auditHigh: st.prep.audit?.highCount ?? null,
      auditHard: st.prep.audit?.hardCount ?? null,
      auditAdvisory: st.prep.audit?.advisoryCount ?? null,
      auditTotal: auditIssues.length,
      auditResolved: auditIssues.filter(i => i.resolved).length,
      pending: pendingUnits(st),
    },
    study: {
      partsDone,
      partsTotal: parts.length || Math.max(1, Math.ceil((st.sourceChars || 0) / LIMITS.partChars)),
      points: parts.flatMap(p => p.points || []).length,
      unresolved: (st.study.summary?.unresolved || []).length,
      coverage: st.study.summary?.coverage
        ? `${st.study.summary.coverage.covered.length}/${st.study.summary.coverage.total}` : '',
      loops: st.study.loops || 0,
      focus: st.study.focus || '',
    },
    clarify: { total: (st.clarify.questions || []).length, answered: (st.clarify.answers || []).length },
    exam: {
      asked: (st.exam.questions || []).filter(q => q.askedAt).length,
      answered: scored.length,
      total: plannedTotal,
      avg,
      round: st.exam.round,
      recallHeavy: Boolean(st.exam.recallHeavy),
      gaps: (st.exam.gaps || []).slice(0, 5),
      questions: (st.exam.questions || []).map(q => ({
        no: q.no, q: q.q, score: q.score ?? null, gap: q.gap || '', angle: q.angle || '',
        pointId: q.pointId || '', recall: Boolean(q.recall), origin: q.origin || '',
      })),
    },
    canDecide: st.stage === 'confirm',
    finished: st.stage === 'finished',
    auditIssues: auditIssues.slice(0, 12).map(i => ({
      no: i.no, level: i.level, label: i.levelLabel || LEVEL_LABEL[i.level] || i.level,
      where: i.where || '', message: i.message || '',
      quote: String(i.quote || i.evidence || '').slice(0, 120),
      advisory: Boolean(i.advisory), resolved: Boolean(i.resolved),
    })),
    corrections: (st.corrections || []).length,
    regression: { asked: st.exam.regression?.asked || 0, passed: st.exam.regression?.passed || 0 },
    brief: buildBrief(st, cfg),
    errors: (st.errors || []).slice(-5),
    updatedAt: st.updatedAt,
  }
}

/* ------------------------------------------------------------ selftest */

const FIXTURE = [
  '# 第 1 章 总则',
  '1.1 抽样比例：每批抽 5%，不足 20 件时改为全检。',
  '1.2 批次定义：同一投料批为一批，不按工单划分。',
  '',
  '# 第 2 章 判定',
  '2.1 不合格判定：抽检发现 1 件不合格即整批拒收。',
  '2.2 复检：被拒收的批次可申请一次复检，复检比例为 10%。',
  '',
  '# 第 3 章 记录',
  '3.1 记录保存：检验记录保存三年，到期由质量部销毁。',
].join('\n')

function fakeChat(box) {
  return async ({ system, prompt, maxTokens }) => {
    box.calls.push({ system: system.slice(0, 12), maxTokens })
    if (/【任务:边界与版本】/.test(system)) {
      if (box.noScope) throw new Error('模拟边界抽取失败')
      return JSON.stringify({
        applies_to: ['触摸模组的进料检验', '品质部与研发中心'],
        version: 'V1.2', effective_date: '2026-01-01', supersedes: 'V1.1',
        mandatory: '第 2 章判定条款为强制',
        recommended: ['附录 A 抽样示意'],
        terms: [{ term: '批', meaning: '同一投料批为一批' }],
      })
    }
    if (/【任务:知识地图】/.test(system)) {
      if (box.emptyMap) return '{"modules":[],"points":[]}'
      return JSON.stringify({
        modules: [{ id: 'M1', title: '抽样与判定' }],
        points: [
          { id: 'K1', module: 'M1', title: '抽样比例', type: 'rule', trigger: '每批进料检验时', action: '抽 5%，不足 20 件全检', summary: '每批 5%', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。' },
          { id: 'K2', module: 'M1', title: '批次定义', type: 'definition', trigger: '划分批次时', action: '按同一投料批算，不按工单', summary: '同一投料批', source: '批次定义：同一投料批为一批，不按工单划分。' },
          { id: 'K3', module: 'M1', title: '不合格判定', type: 'boundary', trigger: '抽检发现不合格时', action: '1 件即整批拒收，不许挑选放行', summary: '1 件即拒收', source: '抽检发现 1 件不合格即整批拒收。' },
          { id: 'K4', module: 'M1', title: '复检比例', type: 'rule', trigger: '被拒收批次申请复检时', action: '按 10% 复检，只能一次', summary: '10%', source: '复检比例为 10%。' },
          { id: 'K5', module: 'M1', title: '记录保存', type: 'rule', trigger: '检验记录归档时', action: '保存三年，到期由质量部销毁', summary: '三年', source: '检验记录保存三年，到期由质量部销毁。' },
        ],
      })
    }
    if (/【任务:按意见改课程包】/.test(system)) {
      // 模拟「按意见改稿」：把编造的重点删掉，其余保留
      return JSON.stringify({
        overview: '这份规范讲抽样、判定、复检与记录保存。',
        teaching_order: ['第 1 章 总则', '第 2 章 判定', '第 3 章 记录'],
        focus_points: [
          { point_id: 'K1', title: '抽样比例', why: '最常算错', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。' },
          { point_id: 'K3', title: '不合格判定', why: '决定整批去留', source: '抽检发现 1 件不合格即整批拒收。' },
        ],
        question_bank: [
          { point_id: 'K1', q: '每批抽多少？不足 20 件怎么办？', answer_contains: '"每批抽 5%" "不足 20 件时改为全检"', angle: '数据口径' },
          { point_id: 'K3', q: '抽检发现 1 件不合格，这批怎么处理？', answer_contains: '"1 件不合格即整批拒收"', angle: '判定边界' },
          { point_id: 'K4', q: '复检比例是多少？可以复检几次？', answer_contains: '"复检比例为 10%"', angle: '流程与顺序' },
        ],
        common_misconceptions: ['把批次按工单划分'],
      })
    }
    if (/【任务:课程包】/.test(system)) {
      if (box.truncOnce && !box.truncServed) {
        box.truncServed = true
        return { text: '{"overview":"半截', finish: 'length' }
      }
      if (box.emptyPack) return '{"overview":"","teaching_order":[],"focus_points":[],"question_bank":[],"common_misconceptions":[]}'
      return JSON.stringify({
        overview: '这份规范讲抽样、判定、复检与记录保存。',
        teaching_order: ['第 1 章 总则', '第 2 章 判定', '第 3 章 记录'],
        focus_points: [
          { point_id: 'K1', title: '抽样比例', why: '最常算错', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。' },
          { point_id: 'K3', title: '不合格判定', why: '决定整批去留', source: '抽检发现 1 件不合格即整批拒收。' },
          { point_id: 'K9', title: '编造的重点', why: '故意让审核挑出来', source: '原文里根本没有这句话。' },
        ],
        question_bank: [
          { point_id: 'K1', q: '每批抽多少？不足 20 件怎么办？', answer_contains: '"每批抽 5%" "不足 20 件时改为全检"', angle: '数据口径' },
          { point_id: 'K3', q: '抽检发现 1 件不合格，这批怎么处理？', answer_contains: '"1 件不合格即整批拒收"', angle: '判定边界' },
          { point_id: 'K4', q: '复检比例是多少？可以复检几次？', answer_contains: '"复检比例为 10%"', angle: '流程与顺序' },
          { point_id: 'K2', q: '批次定义是什么？', answer_contains: '"同一投料批为一批"', angle: '概念与定义' },
          { point_id: 'K5', q: '抽样比例的定义是什么？', answer_contains: '"每批抽 5%"', angle: '概念与定义' },
        ],
        common_misconceptions: ['把批次按工单划分', '以为可以无限复检'],
      })
    }
    if (/【任务:知识地图补漏】/.test(system)) {
      // 故意只回已收录的条目：验证去重不重复入表，条数不因补漏轮虚增
      return JSON.stringify({
        modules: [{ id: 'M1', title: '抽样与判定' }],
        points: [
          { id: 'G1', module: 'M1', title: '抽样比例', type: 'rule', trigger: '每批进料检验时', action: '抽 5%，不足 20 件全检', summary: '每批 5%', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。' },
          { id: 'G2', module: 'M9', title: '复检比例', type: 'rule', trigger: '被拒收批次申请复检时', action: '按 10% 复检，只能一次', summary: '10%', source: '复检比例为 10%。' },
        ],
      })
    }
    if (/【任务:独立审读】/.test(system)) {
      return JSON.stringify({ issues: [{ level: 'high', scope: 'claim', message: '模型认为某条重点有问题', evidence: '（模型意见）' }] })
    }
    if (/【任务:回归出题】/.test(system)) {
      if (box.regressPlaceholder) return '{"q":"...","answer_contains":"...","angle":"..."}'
      return JSON.stringify({
        q: '一批 18 件要检验，按这份规范该怎么抽、还是全检？',
        answer_contains: '"不足 20 件时改为全检"', angle: '判定边界',
      })
    }
    if (/【任务:学员自学】/.test(system)) {
      if (box.failPart && prompt.includes(box.failPart)) throw new Error('模拟自学超时')
      const titles = (prompt.match(/本部分章节：(.+)/) || [])[1] || ''
      const covered = titles.split('、').filter(Boolean)
      const points = covered.map(t => ({
        title: `${t} 的要点`,
        rule: '按原文执行',
        conditions: '每批检验时适用',
        exceptions: '不足 20 件改为全检',
        numbers: '5%',
        source: t.includes('判定') ? '抽检发现 1 件不合格即整批拒收。' : '抽样比例：每批抽 5%，不足 20 件时改为全检。',
        misconceptions: '把批次按工单划分',
      }))
      return JSON.stringify({ covered_sections: covered, points, unresolved: [] })
    }
    if (/【任务:学员作答】/.test(system)) {
      return JSON.stringify({ conclusion: '每批抽 5%，不足 20 件全检。', basis: '每批抽 5%', unsure: '' })
    }
    if (/【任务:教授判分】/.test(system)) {
      if (box.blankOnce && !box.blankServed) {
        box.blankServed = true
        return '{"score":0}'
      }
      const q = (prompt.match(/题目：(.+)/) || [])[1] || ''
      const first = !box.graded.has(q)
      box.graded.add(q)
      if (/不合格|复检|判定/.test(q) && first) {
        return JSON.stringify({ score: 50, passed: false, comment: '结论错了。', gap: '把 10% 复检记成 5%', correct: '复检比例为 10%，且只能申请一次。' })
      }
      return JSON.stringify({ score: 90, passed: true, comment: '答到了要点。', gap: '', correct: '' })
    }
    if (/【任务:学员复述】/.test(system)) {
      if (/旁证：原文里找不到/.test(prompt)) return '这条不属于本课，我只当课外参考。'
      return '落在「复检比例」这条上，我原来记成 5% 是错的，以后按 10% 且只能一次执行。'
    }
    if (/【任务:教授提问】/.test(system)) return '请说明本课最核心的一条口径。'
    if (/★你是这门课的教授/.test(system)) return '原文写的是每批抽 5%，不足 20 件全检。'
    throw new Error(`fake chat 未匹配系统提示：${system.slice(0, 40)}`)
  }
}

async function runSelftest() {
  const execFileAsync = promisify(execFile)
  let passed = 0
  const failures = []
  const check = (label, ok) => { if (ok) passed++; else failures.push(label) }
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-teaching-'))
  const box = { calls: [], graded: new Set(), failChapter: '', failPart: '' }
  const chat = fakeChat(box)
  const cfg = { maxQuestions: 8, passThreshold: 0.75 }

  try {
    const { openClassroom } = await import('./classroom.js')
    const opened = await openClassroom(stateRoot, { courseId: 'teach-selftest', title: '抽样检验规范' })
    const id = opened.classroom.id

    // open requires source
    let needSource = false
    try { await openTeaching(stateRoot, { id }) } catch (e) { needSource = e.status === 400 }
    check('没原文不许开课', needSource)

    const opened2 = await openTeaching(stateRoot, { id, title: '抽样检验规范', source: FIXTURE, sourceName: 'fixture.md' })
    check('开课记录原文与章数', opened2.teaching.sourceChars === FIXTURE.length && opened2.teaching.chapters === 3)
    check('章节按标题切分', opened2.chapters.map(c => c.title).join('|').includes('第 1 章'))
    const sourceOnDisk = await readFile(join(dirOf(stateRoot, id), 'source.md'), 'utf8')
    check('原文落盘', sourceOnDisk === FIXTURE)

    // prep: scope, map, chapter 1 ok, chapter 2 fallback, chapter 3 ok, pack, audit
    box.failChapter = '第 2 章'
    check('还没开跑时没有进度记录', !(await teachingState(stateRoot, id)).progress)
    await advance(stateRoot, { id, chat, cfg })             // scope
    let st = await loadState(stateRoot, id)
    const act0 = (st.activity || [])[st.activity.length - 1]
    check('每步跑完留一条动作记录', act0?.key === 'scope' && act0.status === 'done')
    check('动作记录写了结果与耗时', String(act0.result).includes('字') && act0.ms >= 0)
    check('动作流随状态描述一起给前端', (describe(st).activity || []).some(a => a.key === 'scope' && a.status === 'done'))
    check('跑完不留「正在跑」的进度', st.progress === null)
    check('先摘出边界与版本', st.prep.scope?.origin === 'model' && st.prep.scope.applies_to.length === 2)
    check('边界落盘 scope.json', (await readFile(join(dirOf(stateRoot, id), 'scope.json'), 'utf8')).includes('V1.2'))
    check('待办不再列章备课', pendingUnits(st).includes('知识地图') && !pendingUnits(st).some(x => x.includes('章备课')))
    await advance(stateRoot, { id, chat, cfg })             // map
    st = await loadState(stateRoot, id)
    check('知识地图落盘', st.prep.map?.points?.length === 5)
    check('拆条款也进了动作流', st.activity.filter(a => a.key === 'map' && a.status === 'done').length === 1)
    check('地图写了 5 个知识点', describe(st).prep.map === 5)
    check('知识点拆成可执行条款', clauseStats(st.prep.map.points).qualified === 5)
    check('首轮偏薄会触发补漏轮', box.calls.some(c => c.system.startsWith('【任务:知识地图补漏】')))
    check('补漏轮重复条目不入表', st.prep.map.points.length === 5 && st.prep.map.density.gapAdded === 0)
    check('密度目标按原文长度算（≥8 条）', st.prep.map.density.desired >= 8 && st.prep.map.density.floor >= 6)
    const merged = mergeGapPoints(
      [{ id: 'K1', module: 'M1', title: '抽样比例', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。' }],
      [
        { id: 'X1', module: 'M1', title: '抽样比例', source: '抽样比例：每批抽 5%，不足 20 件时改为全检。' },
        { id: 'X2', module: 'M9', title: '复检次数', action: '只能申请一次', source: '被拒收的批次可申请一次复检' },
      ],
      ['M1'],
    )
    check('补漏只并入新条款并归位模块', merged.added === 1 && merged.points.length === 2
      && merged.points[1].module === 'M1' && merged.points[1].id === 'K2')
    const many = n => ({ prep: { map: { points: new Array(n).fill({ id: 'K', title: 't', source: 's' }) } } })
    check('题量按条款数放大（86 条→17 题）', examTarget(many(86), cfg) === 17)
    check('题量不越 24 题上限', examTarget(many(400), cfg) === 24)
    check('题库留两道挑选余地', bankTarget(many(86), cfg) === 19)

    await advance(stateRoot, { id, chat, cfg })             // 章节登记 + 出课程包
    st = await loadState(stateRoot, id)
    check('章节只登记不写笔记', (st.prep.chapters || []).length === st.chapters.length
      && st.prep.chapters.every(c => c.skipped === true && c.noteChars === 0))
    const notesGone = await readFile(join(dirOf(stateRoot, id), 'professor-notes.md'), 'utf8').then(() => false).catch(() => true)
    check('不再产出备课笔记文件', notesGone === true)
    check('整门课一次章节备课调用都不发', box.calls.filter(c => /【任务:章节备课】/.test(c.system)).length === 0)
    check('课程包落盘', st.prep.pack?.question_bank?.length === 5)
    check('提炼包 markdown 可读', (await readFile(join(dirOf(stateRoot, id), 'course-pack.md'), 'utf8')).includes('## 题库'))

    await advance(stateRoot, { id, chat, cfg })             // audit
    st = await loadState(stateRoot, id)
    check('审核判出硬问题', st.prep.audit?.status === 'needs_review' && st.prep.audit.highCount >= 1)
    check('编造的原文依据被挑出', (st.prep.audit.issues || []).some(i => /原文依据在课件里找不到/.test(i.message)))
    check('模型审读只作参考', (st.prep.audit.issues || []).some(i => i.advisory === true && i.level === 'low'))
    check('审核问题按编号排序', st.prep.audit.issues.every((x, i) => x.no === i + 1))
    check('审核问题带原文引用', st.prep.audit.issues.some(i => /原文依据在课件里找不到/.test(i.message) && i.quote))
    check('审核问题能定位到第几条', st.prep.audit.issues.some(i => /重点 \d/.test(i.where || '')))
    check('硬问题卡住不开课', st.stage === 'prep' && st.prep.audit?.gate === 'blocked')
    check('卡住状态回传 needUser', (await advance(stateRoot, { id, chat, cfg })).gate === 'blocked')
    let gateErr = ''
    try { await openClass(stateRoot, { id, chat, approve: false, comment: '' }) } catch (e) { gateErr = e.message }
    check('不同意又没说怎么改会被拒', /要说清楚/.test(gateErr))
    const revised = await openClass(stateRoot, { id, chat, approve: false, comment: '第 3 条编造的重点删掉' })
    check('按意见改课程包并清掉审核结论', revised.teaching.prep.auditGate === '' && revised.teaching.prep.gateRounds === 1)
    await advance(stateRoot, { id, chat, cfg })             // 重审 → 通过 → 开课
    st = await loadState(stateRoot, id)
    check('重审通过自动开课', st.stage === 'study' && st.prep.audit?.gate === 'passed')

    // study: force one part to fail, then finish and hit coverage gap
    box.failPart = '第 1 章'
    const studyCallsBefore = box.calls.filter(c => /学员自学/.test(c.system)).length
    await advance(stateRoot, { id, chat, cfg })
    const studyCallsAfter = box.calls.filter(c => /学员自学/.test(c.system)).length
    st = await loadState(stateRoot, id)
    check('自学失败段标记 failed', st.study.parts.some(p => p.status === 'failed'))
    check('自学失败会重试一次', studyCallsAfter - studyCallsBefore >= 2)
    check('自学失败记进 errors', st.errors.some(e => e.scope === 'study-retry'))
    const partsTotal = st.study.parts.length
    for (let i = 0; i < partsTotal; i++) await advance(stateRoot, { id, chat, cfg })   // 跑到合并那一步就停
    st = await loadState(stateRoot, id)
    check('分段自学完成并合并', st.study.parts.length === partsTotal)
    check('学员笔记落盘', (await readFile(join(dirOf(stateRoot, id), 'student-notes.md'), 'utf8')).includes('学员研读笔记'))
    check('覆盖账本记到漏读', st.study.summary?.coverage?.missing?.length >= 1)
    check('漏读转答疑', st.stage === 'clarify')
    check('答疑问题带覆盖来源', st.clarify.origins.includes('coverage'))

    // clarify answers each question
    for (let i = 0; i < 6 && st.stage === 'clarify'; i++) {
      await advance(stateRoot, { id, chat, cfg })
      st = await loadState(stateRoot, id)
    }
    check('教授逐条答完进考核', st.stage === 'exam' && st.clarify.answers.length === st.clarify.questions.length)

    // exam round 1: two wrong answers -> avg below line -> re-study
    let guard = 0
    while (st.stage === 'exam' && guard++ < 20) {
      await advance(stateRoot, { id, chat, cfg })
      st = await loadState(stateRoot, id)
    }
    check('首轮未达标触发重学', st.stage === 'study' && st.study.history.length >= 1)
    check('重学带着薄弱点', Boolean(st.study.focus))
    check('轮次记录平均分', st.exam.history.length >= 1 && typeof st.exam.history[0].avg === 'number')
    check('重学只带错题章节', Array.isArray(st.study.scoped?.titles) && st.study.scoped.titles.length >= 1)
    check('重学只重考错题', st.exam.questions.length === 2)

    // round 2: everything correct -> confirm
    guard = 0
    while (st.stage !== 'confirm' && guard++ < 40) {
      await advance(stateRoot, { id, chat, cfg })
      st = await loadState(stateRoot, id)
    }
    check('第二轮达标进入结课确认', st.stage === 'confirm')
    check('结课必须先问用户', describe(st).canDecide === true)
    const confBrief = describe(st).brief
    check('结课前给出完整概要', Boolean(confBrief) && confBrief.audit.total >= 1
      && confBrief.packChars > 0 && confBrief.notesChars === 0 && confBrief.clauses.total === 5)
    check('概要带覆盖与待办', typeof confBrief.coverage?.total === 'number' && Array.isArray(confBrief.pending))
    check('概要写明适用范围', Boolean(confBrief.scope) && confBrief.scope.appliesTo.length === 2)
    check('抽题按知识点去重', new Set(st.exam.questions.map(q => q.pointId)).size === st.exam.questions.length)
    check('重考名单里没有复述题排前面', (() => {
      const qs = st.exam.questions
      const firstRecall = qs.findIndex(q => isRecallQuestion(q.q))
      const lastApply = qs.reduce((acc, q, i) => (isRecallQuestion(q.q) ? acc : i), -1)
      return firstRecall === -1 || lastApply < firstRecall
    })())
    check('抽题把用法题排在复述题前面', (() => {
      const box2 = { prep: { pack: { question_bank: [
        { point_id: 'A', q: '抽样比例的定义是什么？', angle: '概念与定义' },
        { point_id: 'B', q: '不足 20 件时怎么处理？', angle: '判定边界' },
        { point_id: 'C', q: '跨两个工单的批次怎么算抽样基数？', angle: '数据口径' },
      ] } }, exam: { questions: [] } }
      ensureQuestions(box2, { maxQuestions: 3 })
      const qs = box2.exam.questions
      return !isRecallQuestion(qs[0].q) && isRecallQuestion(qs[qs.length - 1].q)
    })())
    check('复述题识别函数可用', isRecallQuestion('抽样比例的定义是什么？') && !isRecallQuestion('不足 20 件时怎么办？'))

    // advance must not skip past confirm
    const idle = await advance(stateRoot, { id, chat, cfg })
    check('确认阶段不再自动推进', idle.needUser === true)

    // user speaks: student restates and it lands in the notebook
    const said = await sayToClass(stateRoot, { id, chat, text: '被拒收的批次只能申请一次复检，别记成可以反复复检。' })
    check('用户发言让学生复述', said.teaching && true)
    const afterSay = await getClassroom(stateRoot, id)
    check('用户发言进课堂实录', afterSay.notes.includes('被拒收的批次只能申请一次复检'))
    check('学员复述进课堂实录', afterSay.notes.includes('我原来记成 5% 是错的'))
    check('复述标为非阻塞', said.message.role === 'student')
    check('原文对得上就不许判课外', said.message.meta?.offCourse === false && said.message.meta?.support === true)

    // 原文找不到落点的话，才允许学员当课外参考推开
    const stray = await sayToClass(stateRoot, { id, chat, text: '检验记录下班前拍照发到车间群里。' })
    check('原文对不上可判课外', stray.message.meta?.offCourse === true && stray.message.meta?.support === false)

    // decide no -> continue learning, then decide yes -> finished
    box.regressPlaceholder = true
    const noRes = await decideClass(stateRoot, { id, chat, agree: false, comment: '复检那题再讲一遍', cfg })
    check('不结课回到重学', noRes.teaching.stage === 'study')
    st = await loadState(stateRoot, id)
    check('不结课意见写进笔记', (await getClassroom(stateRoot, id)).notes.includes('复检那题再讲一遍'))

    guard = 0
    while (st.stage !== 'confirm' && guard++ < 40) {
      await advance(stateRoot, { id, chat, cfg })
      st = await loadState(stateRoot, id)
    }
    check('再次回到结课确认', st.stage === 'confirm')
    check('纠错进了纠错账', (st.corrections || []).length >= 1)
    check('纠错变成回归题', st.exam.questions.some(q => q.origin === 'user-correction'))
    check('占位符回归题被替换', (() => {
      const q = st.exam.questions.find(x => x.origin === 'user-correction')
      return Boolean(q) && /按本课原文/.test(q.q) && q.q !== '...'
    })())
    check('回归题记了成绩', (st.exam.regression?.asked || 0) >= 1)
    const yesRes = await decideClass(stateRoot, { id, chat, agree: true, comment: '结课', cfg })
    check('用户确认后结课', yesRes.teaching.stage === 'finished' && yesRes.summary.avg > 0)
    check('结课摘要带上架概要', yesRes.summary.brief?.clauses?.total === 5 && yesRes.summary.corrections >= 1)
    check('题目记下学员作答', st.exam.questions.every(q => q.score == null || (q.answer || '').length > 0))
    check('结课摘要带逐题成绩', Array.isArray(yesRes.summary.exam) && yesRes.summary.exam.length === yesRes.summary.questions)
    check('结课汇总落盘', (await readFile(join(dirOf(stateRoot, id), 'summary.json'), 'utf8')).includes('"avg"'))
    check('结课记下兜底章节数', yesRes.summary.fallbackChapters === 0)
    const finalNotes = await getClassroom(stateRoot, id)
    check('结课写进课堂实录', finalNotes.notes.includes('用户确认结课'))
    check('课堂笔记含全部阶段', ['知识地图', '第 1 章', '学完了', '题', '用户确认结课'].every(k => finalNotes.notes.includes(k)))

    const afterFinish = await advance(stateRoot, { id, chat, cfg })
    check('结课后不再推进', afterFinish.needUser === true && afterFinish.note === '已结课')
    const againDecide = await (async () => { try { await decideClass(stateRoot, { id, chat, agree: true }) } catch (e) { return e.status } })()
    check('重复结课被拒', againDecide === 409)

    // 截断：被切成半截的回答不能当完成，要用更大预算重试
    const room3 = await openClassroom(stateRoot, { title: '截断重试' })
    const box3 = { calls: [], graded: new Set(), failChapter: '', failPart: '', truncOnce: true, truncServed: false }
    const chat3 = fakeChat(box3)
    await openTeaching(stateRoot, { id: room3.classroom.id, source: FIXTURE })
    await advance(stateRoot, { id: room3.classroom.id, chat: chat3, cfg })   // scope
    await advance(stateRoot, { id: room3.classroom.id, chat: chat3, cfg })   // map
    await advance(stateRoot, { id: room3.classroom.id, chat: chat3, cfg })   // 章节登记 + 课程包（半截一次）
    const st3 = await loadState(stateRoot, room3.classroom.id)
    check('截断后自动加大预算重试', box3.truncServed === true && !!st3.prep.pack)
    check('重试成功不标兜底', (st3.prep.pack?.question_bank || []).length === 5 && st3.errors.every(e => e.scope !== 'pack'))
    check('半截内容没被当成完成', !JSON.stringify(st3.prep.pack || {}).includes('半截'))

    // 空地图：不能假装模型整理了，必须标成原文锚点兜底
    const room4 = await openClassroom(stateRoot, { title: '空地图兜底' })
    const box4 = { calls: [], graded: new Set(), failChapter: '', failPart: '', emptyMap: true }
    await openTeaching(stateRoot, { id: room4.classroom.id, source: FIXTURE })
    await advance(stateRoot, { id: room4.classroom.id, chat: fakeChat(box4), cfg })   // scope
    await advance(stateRoot, { id: room4.classroom.id, chat: fakeChat(box4), cfg })   // map (empty)
    const st4 = await loadState(stateRoot, room4.classroom.id)
    check('空地图标为原文锚点兜底', st4.prep.map?.origin === 'density-fallback' && st4.prep.map.points.length > 0)
    check('空地图记进 errors', st4.errors.some(e => e.scope === 'map'))
    check('兜底地图的锚点带原文依据', st4.prep.map.points.every(p => p.source && norm(p.source).length > 8))
    const room4Notes = await getClassroom(stateRoot, room4.classroom.id)
    check('兜底事实写进课堂实录', room4Notes.notes.includes('标成兜底，不冒充模型整理的结果'))

    // 判分给 0 分却一个字不说：不能当答错，标没判并重考
    const room6 = await openClassroom(stateRoot, { title: '判分空结论' })
    const box6 = { calls: [], graded: new Set(), failChapter: '', failPart: '', blankOnce: true, blankServed: false }
    const chat6 = fakeChat(box6)
    await openTeaching(stateRoot, { id: room6.classroom.id, source: FIXTURE })
    let st6 = null
    for (let i = 0; i < 60; i++) {
      const cur = await loadState(stateRoot, room6.classroom.id)
      if (cur.stage === 'prep' && cur.prep.audit?.gate === 'blocked') {
        await openClass(stateRoot, { id: room6.classroom.id, chat: chat6, approve: true })
      }
      await advance(stateRoot, { id: room6.classroom.id, chat: chat6, cfg })
      st6 = await loadState(stateRoot, room6.classroom.id)
      if (st6.stage === 'confirm' || st6.stage === 'finished') break
    }
    check('空的 0 分被重判', box6.blankServed === true)
    check('没说明的 0 分不进成绩', st6.exam.questions.every(q => q.score == null || q.score > 0))
    check('每题最终都有分数', st6.exam.questions.every(q => q.score != null))

    // 空课程包：不能静默通过审核
    const room5 = await openClassroom(stateRoot, { title: '空课程包' })
    const box5 = { calls: [], graded: new Set(), failChapter: '', failPart: '', emptyPack: true }
    const chat5 = fakeChat(box5)
    await openTeaching(stateRoot, { id: room5.classroom.id, source: FIXTURE })
    for (let i = 0; i < 7; i++) await advance(stateRoot, { id: room5.classroom.id, chat: chat5, cfg })
    const st5 = await loadState(stateRoot, room5.classroom.id)
    check('课程包缺料判硬问题', st5.prep.audit?.status === 'needs_review'
      && st5.prep.audit.issues.some(i => /课程包缺料/.test(i.message) || /题库是空的/.test(i.message)))
    check('缺料问题带编号与定位', st5.prep.audit.issues.every(i => i.no >= 1 && i.where)
      && st5.prep.audit.issues.filter(i => !i.advisory).every(i => i.where !== '未定位'))

    // deterministic helpers
    const single = {
      title: '单章表格',
      sourceChars: 120,
      chapters: [{ index: 1, title: '触摸模组进料检验规范 V2.1' }],
      prep: {
        chapters: [{ index: 1, title: '触摸模组进料检验规范 V2.1', hasTable: true, tableKeys: ['检验记录', '复检记录'] }],
        pack: {
          overview: '这份规范讲抽样、判定与记录保存。',
          teaching_order: ['抽样', '判定', '记录'],
          focus_points: [{ title: '检验记录保存三年', why: '容易记成五年', source: '检验记录保存三年。' }],
          question_bank: [{ q: '检验记录保存几年？', answer_contains: '"检验记录保存三年"', angle: '数据口径' }],
        },
      },
    }
    const singleSrc = norm('检验记录保存三年。复检记录保存三年。')
    const auditSingle = deterministicAudit(single, singleSrc)
    check('单章不误报漏章', !auditSingle.issues.some(i => /教学顺序没覆盖/.test(i.message)))
    check('表格提到就不报', !auditSingle.issues.some(i => /原文有表格/.test(i.message)))
    const noTable = JSON.parse(JSON.stringify(single))
    noTable.prep.pack.overview = '这份规范讲抽样的比例与判定口径。'
    noTable.prep.pack.teaching_order = ['抽样', '判定']
    noTable.prep.pack.focus_points = [{ title: '抽样比例', why: '最常算错', source: '抽样比例' }]
    noTable.prep.pack.question_bank = [{ q: '每批抽多少？', answer_contains: '"5%"', angle: '数据口径' }]
    const auditNoTable = deterministicAudit(noTable, singleSrc)
    check('表格一项没提会报', auditNoTable.issues.some(i => /原文有表格/.test(i.message)))
    check('title 归一化后能比对', coverageReport(['第 1 章 总则', '第 2 章 判定'], ['第1章 总则']).missing.length === 1)
    check('原文依据整句可判', supported('抽样比例：每批抽 5%，不足 20 件时改为全检。', norm(FIXTURE)))
    check('编造句子判不出依据', !supported('原文里根本没有这句话。', norm(FIXTURE)))
    check('jsonOf 先整体解析', jsonOf('{"a":1}')?.a === 1)
    check('jsonOf 不吃 mermaid 围栏', jsonOf('```mermaid\ngraph TD\n```\n{"a":2}')?.a === 2)
    check('jsonOf 能从思考文字里捞出 JSON', jsonOf('Let me build the JSON.\n{"a":3}\nThat is all.')?.a === 3)
    check('长文按上限切章', splitChapters(`# A\n${'x'.repeat(20000)}`).length >= 2)

    // 文档大标题不算章节；判分关键词用逗号拼了两句原文也不算编造
    const titled = ['# 老化测试作业指导书', '## 1 范围', '## 2 判定'].join('\n')
    const titles = sectionTitles(titled)
    check('唯一 H1 当标题跳过', !titles.includes('老化测试作业指导书') && titles.length === 2)
    const multiH1 = sectionTitles(['# 甲', '# 乙'].join('\n'))
    check('多个 H1 不当标题跳过', multiH1.length === 2)
    const spliced = {
      title: '拼接关键词',
      sourceChars: 200,
      chapters: [{ index: 1, title: '接线' }],
      prep: {
        chapters: [{ index: 1, title: '接线', hasTable: false }],
        pack: {
          overview: '这份规范讲插头与插座。',
          teaching_order: ['接线'],
          focus_points: [{ title: '不用转换插座', why: '常被忽略', source: '不得使用转换插座' }],
          question_bank: [{ q: '能不能用转换插座？', answer_contains: '插头须插到底,不得使用转换插座', angle: '判定边界' }],
        },
      },
    }
    const splicedAudit = deterministicAudit(spliced, norm('插头须插到底，不得使用转换插座。'))
    check('逗号拼接的判分关键词不算找不到', !splicedAudit.issues.some(i => /判分关键词/.test(i.message)))

    // source guard + path guard
    let tooBig = false
    const other = await openClassroom(stateRoot, { title: '超长原文测试' })
    try {
      await openTeaching(stateRoot, { id: other.classroom.id, source: 'y'.repeat(LIMITS.maxSourceChars + 1) })
    } catch (e) { tooBig = e.status === 413 }
    check('超上限原文被拒', tooBig)
    let badPath = false
    try { await teachingState(stateRoot, '../escape') } catch { badPath = true }
    check('路径穿越被拒', badPath)
    check('模型调用次数合理', box.calls.length > 10)
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {})
  }

  for (const file of ['classroom.js', 'contract.js', 'divergence.js']) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        fileURLToPath(new URL(`./${file}`, import.meta.url)), '--selftest',
      ])
      const tail = String(stdout).trim().split(/\r?\n/).slice(-1)[0]
      check(`${file} 回归通过（${tail}）`, /(\b0 failed\b|0 项失败)/.test(String(stdout)))
    } catch (error) {
      check(`${file} 回归通过（${error.message}）`, false)
    }
  }

  console.log(`\n课堂授课引擎自检：${passed} 项通过，${failures.length} 项失败`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  if (failures.length) process.exitCode = 1
  return { passed, failed: failures.length }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
  runSelftest().catch(error => { console.error(error); process.exitCode = 1 })
}

export { runSelftest, LIMITS, STAGE_LABEL }
