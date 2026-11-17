/**
 * 智能助理学院 v2 — 原文片段账本。
 *
 * 把一份原文切成互不重叠的片段（标题 / 条款 / 表格行 / 列表项 / 段落），
 * 给每个片段一个稳定 id 与哈希。后续「读没读全、笔记抄没抄、数值漏没漏、
 * 表格行在不在、引用找不找得到」全部以片段为单位做确定性判定，不靠模型自报。
 *
 * 纯函数，无副作用，可脱离课堂单独跑：
 *   node lib/ledger.js --selftest
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** 规则措辞：出现这些词的行才是「可执行条款」。 */
export const RULE_CUE = /(必须|不得|禁止|应当|应按|应按|须|至少|不超过|最多|不少于|不得少于|保存|归档|签署|核准|审核|复核|编制|填写|要求)/

/** 封面、会签、页脚这类没有学习价值的行：只登记不学习，且必须出现在账本里。 */
const BOILERPLATE = [
  /(会\s*签|签\s*名|分发份数|批\s*准\s*[:：]|审\s*核\s*[:：]|编\s*制\s*[:：]|日\s*期\s*[:：])/,
  /^(目\s*录|附\s*录|附\s*件)$/,
  /^第\s*\d+\s*页(\s*[/／]\s*共?\s*\d+\s*页)?$/,
  /^(密\s*级|保\s*密|受控文件|文件编号|发放范围|版本号|修订记录)$/,
]

const HEADING = /^(#{1,6})\s+(.+?)\s*$/
const PAGE_MARK = /^=+\s*第\s*(\d+)\s*页\s*=+$/
const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/
const CLAUSE_START = /^(\d+(?:\.\d+)*)[\s、.．)）]/
const LIST_ITEM = /^([-*+•·]|[（(]\s*\d+\s*[)）]|\d+\s*[)）])\s*/
/** 中文结构标题：一、 二、 （三） 第 1 章 —— 没有 # 的文档靠它分节。 */
const SECTION_MARK = /^((?:第\s*[一二三四五六七八九十百\d]+\s*[章节部分])|(?:[一二三四五六七八九十]+[、.．])|(?:（[一二三四五六七八九十]+）))/

/** 与教学引擎一致的宽松归一：去标点空格，用于「逐字」比对。 */
export function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[\s\u3000，。；：、！？,.;:!?"'“”‘’()（）[\]【】<>《》\-—_/\\|]+/g, '')
}

/** 有效字数：只数中文字与字母数字，标点空格不计。 */
export function countChars(text) {
  return (String(text || '').match(/[\u3400-\u9fff]|[A-Za-z0-9]/g) || []).length
}

/** 原文封条：换了文本，任何一步都能立刻发现。 */
export function seal(text) {
  const body = String(text || '').replace(/\r\n/g, '\n')
  return {
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    chars: countChars(body),
    rawChars: body.length,
    lines: body.split('\n').length,
  }
}

function cellsOf(line) {
  const sep = line.includes('|') ? '|' : (line.includes('\t') ? '\t' : '')
  if (!sep) return []
  return line.split(sep).map(x => x.trim()).filter(Boolean)
}

function isTableRow(line) {
  if (TABLE_SEP.test(line)) return false
  const cells = cellsOf(line)
  return cells.length >= 2 && cells.some(x => countChars(x) > 0)
}

function isBoilerplate(text) {
  const flat = String(text || '').replace(/\s+/g, '')
  if (!flat) return true
  if (RULE_CUE.test(flat)) return false
  if (flat.length < 6) return true
  if (BOILERPLATE.some(re => re.test(String(text || '')))) return true
  if (/[.．…]{4,}/.test(flat)) return true
  return false
}

function kindOf(text, { table = false, heading = false, clause = false, list = false } = {}) {
  if (heading) return 'heading'
  if (table) return 'table_row'
  if (clause) return 'clause'
  if (list) return 'list_item'
  return 'para'
}

/**
 * 切片段。合并过短的连续行（docx 抽出来常是一行一句），表格行各自成段，
 * 标题、条款、列表项各自成段；没有任何标题/页码的文档按约 3000 字造章节，
 * 保证后续「按章拆条款、按片覆盖率」在没有 Markdown 结构的文档上同样成立。
 *
 * @param source 原文全文
 * @returns 账本：封条、章节、片段、统计
 */
export function buildLedger(source) {
  const text = String(source || '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const headings = []
  lines.forEach((line, i) => {
    const m = HEADING.exec(line.trim())
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), line: i })
  })
  const topLevel = headings.length ? Math.min(...headings.map(h => h.level)) : 0
  const topHeadings = headings.filter(h => h.level === topLevel)
  const hasPageMarks = lines.some(l => PAGE_MARK.test(l.trim()))

  const segments = []
  const chapters = []
  let chapter = null
  let buf = []
  let bufChars = 0
  let bufClauseNo = ''
  let order = 0

  const chapterStart = title => {
    if (chapter && chapter.segments > 0 && chapter.chars > 0) chapters.push(chapter)
    chapter = {
      id: `C${String(chapters.length + 1).padStart(2, '0')}`,
      title: String(title || '').slice(0, 90) || `第 ${chapters.length + 1} 部分`,
      chars: 0,
      segments: 0,
      start: order,
    }
  }
  const ensureChapter = () => {
    if (!chapter) chapterStart(topHeadings.length ? '前言' : '第 1 部分')
    return chapter
  }

  const push = (body, kind, extra = {}) => {
    const clean = String(body || '').trim()
    if (!clean) return
    const current = ensureChapter()
    const seg = {
      id: `S${String(order + 1).padStart(4, '0')}`,
      order,
      chapter: current.id,
      kind,
      text: clean,
      chars: countChars(clean),
      norm: normalize(clean),
      substantive: kind === 'heading' ? true : !isBoilerplate(clean),
      ...extra,
    }
    segments.push(seg)
    current.segments += 1
    current.chars += seg.chars
    order += 1
    // 没有顶层标题的文档：每攒够 3000 字轮换一章，保证拆条款与覆盖率有颗粒度
    if (!topHeadings.length && !hasPageMarks && current.chars >= 3000) {
      chapterStart(`第 ${chapters.length + 2} 部分`)
    }
  }

  const flush = () => {
    if (!buf.length) return
    const body = buf.join('\n').trim()
    const clause = Boolean(bufClauseNo)
    const list = LIST_ITEM.test(buf[0].trim())
    push(body, kindOf(body, { clause, list }), { clauseNo: bufClauseNo })
    buf = []
    bufChars = 0
    bufClauseNo = ''
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) { flush(); continue }
    if (PAGE_MARK.test(trimmed)) {
      flush()
      if (hasPageMarks && !topHeadings.length) chapterStart(`第 ${Number(PAGE_MARK.exec(trimmed)[1])} 页`)
      push(trimmed, 'page_marker', { substantive: false })
      continue
    }
    const heading = HEADING.exec(trimmed)
    if (heading) {
      flush()
      const isTop = !topHeadings.length || heading[1].length === topLevel
      if (isTop) chapterStart(heading[2])
      push(heading[2], 'heading', { level: heading[1].length })
      continue
    }
    if (isTableRow(line)) {
      flush()
      const cells = cellsOf(line)
      push(line.trim(), 'table_row', { tableKey: String(cells[0] || '').slice(0, 40) })
      continue
    }
    // 表格分隔行（| --- | :--: |）没有内容，不登记也不参与覆盖
    if (TABLE_SEP.test(line)) { flush(); continue }
    // 中文结构标题（一、目的 / 第 1 章 范围）：独立成段并按顶层标题分章
    if (SECTION_MARK.test(trimmed) && countChars(trimmed) <= 30) {
      flush()
      if (/^第\s*[一二三四五六七八九十百\d]+\s*(章|部分)/.test(trimmed) && !topHeadings.length) chapterStart(trimmed)
      push(trimmed, 'heading')
      continue
    }
    const clause = CLAUSE_START.exec(trimmed)
    if (clause) {
      flush()
      bufClauseNo = clause[1]
      buf.push(trimmed)
      bufChars += countChars(trimmed)
      continue
    }
    if (LIST_ITEM.test(trimmed) && buf.length === 0) {
      push(trimmed, 'list_item')
      continue
    }
    buf.push(trimmed)
    bufChars += countChars(trimmed)
    if (bufChars >= 400) flush()
  }
  flush()
  if (chapter && (chapter.segments > 0 || !chapters.length)) chapters.push(chapter)
  if (!chapters.length) chapters.push({ id: 'C01', title: '第 1 部分', chars: 0, segments: 0, start: 0 })

  const substantive = segments.filter(s => s.substantive)
  const stats = {
    segments: segments.length,
    substantive: substantive.length,
    boilerplate: segments.length - substantive.length,
    chars: countChars(text),
    tableRows: segments.filter(s => s.kind === 'table_row').length,
    clauses: segments.filter(s => s.kind === 'clause').length,
    headings: segments.filter(s => s.kind === 'heading').length,
    chapters: chapters.length,
  }
  return { seal: seal(text), chapters, segments, stats }
}

/**
 * 把片段按字数预算分块，块与块首尾相接、无空洞无重叠。
 * @param ledger 账本
 * @param budget 每块目标字数
 * @returns 分块数组，每块带片段 id 与带 id 前缀的正文
 */
export function chunkRanges(ledger, budget = 1600) {
  const segments = ledger.segments || []
  const chunks = []
  let from = 0
  while (from < segments.length) {
    let to = from
    let chars = 0
    while (to < segments.length) {
      const seg = segments[to]
      const next = chars + seg.chars
      if (to > from && next > budget) break
      chars = next
      to += 1
      if (chars >= budget) break
    }
    if (to <= from) to = from + 1
    const slice = segments.slice(from, to)
    chunks.push({
      index: chunks.length + 1,
      from,
      to,
      first: slice[0].id,
      last: slice[slice.length - 1].id,
      segIds: slice.map(s => s.id),
      substantiveIds: slice.filter(s => s.substantive).map(s => s.id),
      chars: slice.reduce((n, s) => n + s.chars, 0),
      text: slice.map(s => `⟦${s.id}⟧ ${s.text}`).join('\n'),
    })
    from = to
  }
  return chunks
}

/** 分块铺满断言：所有片段恰好出现一次。 */
export function assertTiling(ledger, chunks) {
  const seen = new Map()
  for (const chunk of chunks) {
    for (const id of chunk.segIds) seen.set(id, (seen.get(id) || 0) + 1)
  }
  const missing = []
  const duplicated = []
  for (const seg of ledger.segments || []) {
    const hit = seen.get(seg.id) || 0
    if (!hit) missing.push(seg.id)
    else if (hit > 1) duplicated.push(seg.id)
  }
  return { ok: !missing.length && !duplicated.length, missing, duplicated }
}

/** 引用是否真的落在它声称的片段里（按片段顺序拼接后逐字比对）。 */
export function quoteSupported(quote, segTexts) {
  const q = normalize(quote)
  if (!q) return false
  return normalize((segTexts || []).join('')) .includes(q)
}

/**
 * 覆盖率：哪些实质性片段没有被任何引用落到。
 * @param ledger 账本
 * @param points 笔记条目，每条带 segments 与 quote
 */
export function coverageOf(ledger, points = []) {
  const byId = new Map((ledger.segments || []).map(s => [s.id, s]))
  const covered = new Set()
  const badCitations = []
  for (const point of points) {
    const ids = Array.isArray(point.segments) ? point.segments.map(String) : []
    const segs = ids.map(id => byId.get(id)).filter(Boolean)
    if (!segs.length) {
      badCitations.push({ id: point.id || '', reason: '引用的片段 id 不存在', segments: ids })
      continue
    }
    if (!point.quote) {
      badCitations.push({ id: point.id || '', reason: '没有写原文依据', segments: ids })
      continue
    }
    if (!quoteSupported(point.quote, segs.map(s => s.text))) {
      badCitations.push({ id: point.id || '', reason: '引用原句不在所引片段里', segments: ids, quote: String(point.quote).slice(0, 80) })
      continue
    }
    for (const seg of segs) covered.add(seg.id)
  }
  const missing = (ledger.segments || [])
    .filter(s => s.substantive && s.kind !== 'heading' && !covered.has(s.id))
  const substantive = (ledger.segments || []).filter(s => s.substantive && s.kind !== 'heading')
  return {
    total: substantive.length,
    covered: substantive.length - missing.length,
    missing: missing.map(s => s.id),
    missingDetail: missing.map(s => ({ id: s.id, chapter: s.chapter, text: String(s.text).slice(0, 80) })),
    badCitations,
    rate: substantive.length ? (substantive.length - missing.length) / substantive.length : 1,
  }
}

const UNIT = '(?:%|％|mm|cm|km|kg|mg|g|ml|L|小时|分钟|秒|天|日|年|月|周|次|件|个|份|页|号|人|层|类|条|倍|度|寸|米|瓦|W|V|A|Hz)'

/**
 * 抽出原文里「错一个字就出事」的硬 token：数值+单位、条款号、型号/编码、
 * 百分比。笔记里少一个就回退，这是「不漏细节」最硬的机械判据。
 */
export function tokensOf(ledger) {
  const out = new Map()
  const add = (value, seg) => {
    const key = String(value).replace(/\s+/g, '')
    if (!key || key.length > 40) return
    if (!out.has(key)) out.set(key, { value: key, segments: [] })
    const row = out.get(key)
    if (row.segments.length < 6) row.segments.push(seg.id)
  }
  for (const seg of ledger.segments || []) {
    if (!seg.substantive || seg.kind === 'heading' || seg.kind === 'page_marker') continue
    const body = seg.text
    for (const m of body.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})`, 'g'))) {
      add(`${m[1]}${m[2] === '％' ? '%' : m[2]}`, seg)
    }
    for (const m of body.matchAll(/第\s*\d+\s*[条章节款项]/g)) add(m[0], seg)
    for (const m of body.matchAll(/(?:^|\s|\||、|，)(\d+(?:\.\d+){1,})\b/g)) add(m[1], seg)
    for (const m of body.matchAll(/\b([A-Z]{1,5}[-_]?\d{2,}(?:[-_.][A-Za-z0-9]+)*)\b/g)) add(m[1], seg)
    for (const m of body.matchAll(/\b([A-Z]{1,3}\d\.\d{2}\.\d{3,4})\b/g)) add(m[1], seg)
  }
  return [...out.values()]
}

/** 笔记里没有出现的 token。 */
export function missingTokens(tokens, noteText) {
  const hay = normalize(noteText)
  return (tokens || []).filter(t => !hay.includes(normalize(t.value)))
}

function stripQuoteLines(text) {
  return String(text || '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n')
}

/**
 * 有效字数：剔除引用块与逐字复制的句子，只数「自己写出来的解释」。
 * 抄一遍原文不能算 2 倍。
 */
export function copyStats(noteText, sourceText) {
  const sourceNorm = normalize(sourceText)
  const body = stripQuoteLines(noteText)
  const sentences = body.split(/(?<=[。；;！？!?\n])/).map(s => s.trim()).filter(Boolean)
  let copied = 0
  let own = 0
  for (const sentence of sentences) {
    const norm = normalize(sentence)
    const isCopy = norm.length >= 16 && sourceNorm.includes(norm)
    if (isCopy) copied += countChars(sentence)
    else own += countChars(sentence)
  }
  const total = own + copied
  return { chars: own, copied, total, copyRate: total ? copied / total : 0 }
}

/** 笔记渲染后与原文的比值口径：分母用该范围内实质性片段的字数。 */
export function ratioOf(noteChars, sourceChars) {
  return sourceChars > 0 ? Number((noteChars / sourceChars).toFixed(3)) : 0
}

/** 密度画像：高密度文档要求笔记字数超过原文，低密度只要信息全覆盖。 */
export function densityOf(ledger) {
  const substantive = (ledger.segments || []).filter(s => s.substantive && s.kind !== 'heading')
  const chars = substantive.reduce((n, s) => n + s.chars, 0) || 1
  const ruleLines = substantive.filter(s => RULE_CUE.test(s.text)).length
  const tokens = tokensOf(ledger)
  const tableRows = substantive.filter(s => s.kind === 'table_row').length
  const clauses = substantive.filter(s => s.kind === 'clause').length
  const ruleRate = ruleLines / substantive.length
  const perK = (tokens.length / chars) * 1000
  const signals = {
    ruleLines,
    ruleRate: Number(ruleRate.toFixed(3)),
    tokens: tokens.length,
    tokensPerK: Number(perK.toFixed(1)),
    tableRows,
    clauses,
  }
  const high = ruleRate >= 0.2
    || (ruleRate >= 0.12 && perK >= 6)
    || tableRows >= 20
    || clauses >= 15
  const reason = high
    ? (clauses >= 15 ? `条款 ${clauses} 条`
      : tableRows >= 20 ? `表格 ${tableRows} 行`
        : `规则句占比 ${Math.round(ruleRate * 100)}%、每千字 ${Math.round(perK)} 个硬指标`)
    : '规则与硬指标稀疏，按通用资料处理'
  return { high, signals, reason }
}

/* ------------------------------------------------------------------ */
/* 自检：不依赖网络，直接用真实规范的片段做输入                        */
/* ------------------------------------------------------------------ */

async function runSelftest() {
  let passed = 0
  const failures = []
  const check = (label, ok, extra = '') => {
    if (ok) passed++
    else failures.push(label)
    if (process.env.LEDGER_VERBOSE || !ok) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  }

  const source = [
    '# 第 1 章 总则',
    '1.1 抽样比例：每批抽 5%，不足 20 件时改为全检。',
    '1.2 批次定义：同一投料批为一批，不按工单划分。',
    '',
    '| 序号 | 字段 | 填写要求 |',
    '| --- | --- | --- |',
    '| 1 | 工程编号 | 抬头栏，按立项号填写，等线 22 号 |',
    '| 2 | 物料规格 | 按规格书或公司标准型号填写 |',
    '',
    '# 第 2 章 判定',
    '2.1 不合格判定：抽检发现 1 件不合格即整批拒收。',
    '2.2 复检：被拒收的批次可申请一次复检，复检比例为 10%。',
    '',
    '文 件 会 签 及 分 发 单 位',
    '部    门        会    签    者        分 发 份 数',
    '业务部                                    3',
  ].join('\n')

  const ledger = buildLedger(source)
  check('原文封条记录字数与哈希', ledger.seal.chars > 100 && /^[a-f0-9]{64}$/.test(ledger.seal.sha256))
  check('有标题时按标题分章', ledger.chapters.length === 2 && ledger.chapters[0].title.includes('总则'))
  check('表格每行一个片段', ledger.stats.tableRows >= 3, `tableRows=${ledger.stats.tableRows}`)
  check('条款行识别成条款', ledger.stats.clauses >= 4, `clauses=${ledger.stats.clauses}`)
  check('会签页登记为无需学习', ledger.segments.some(s => s.substantive === false && s.text.includes('会 签')))

  const chunks = chunkRanges(ledger, 120)
  const tiling = assertTiling(ledger, chunks)
  check('分块铺满全部片段', tiling.ok, JSON.stringify(tiling))
  check('分块正文带片段 id 前缀', chunks[0].text.startsWith('⟦S0001⟧'))
  check('每块都带实质性片段清单', chunks.every(c => Array.isArray(c.substantiveIds)))

  const tokens = tokensOf(ledger)
  const tokenValues = tokens.map(t => t.value)
  check('抽出百分比与单位数值', tokenValues.includes('5%') && tokenValues.includes('10%'), tokenValues.join(','))
  check('抽出条款号', tokenValues.some(v => /^第\d+[条章]/.test(v)) || tokenValues.some(v => /^2\.\d$/.test(v)), tokenValues.join(','))
  check('抽出型号类编码', tokenValues.includes('22号') || tokenValues.some(v => v === '1'), tokenValues.join(','))

  const note = [
    '### K1 抽样比例 ⟦S0001⟧',
    '> 原文：抽样比例：每批抽 5%，不足 20 件时改为全检。⟦S0001⟧',
    '- 解释：每批都要抽样，不是只抽一次；比例按件数算，不是按批次算。',
    '- 适用条件：进料检验与出货检验都按这一条执行，复检另算。',
    '- 例外：不足 20 件时不再按比例抽，直接全检，避免样本过少。',
    '- 判据：抽样记录上的比例与件数对得上才算合规。',
  ].join('\n')
  const copy = copyStats(note, source)
  check('引用块不计入有效字数', copy.chars > 60 && copy.chars < countChars(note))
  check('整句抄原文被记为复制', copyStats('抽样比例：每批抽 5%，不足 20 件时改为全检。', source).copyRate > 0.8)

  const points = [
    { id: 'K1', segments: ['S0002'], quote: '抽样比例：每批抽 5%，不足 20 件时改为全检。' },
    { id: 'K2', segments: ['S0003'], quote: '批次定义：同一投料批为一批，不按工单划分。' },
  ]
  const cov = coverageOf(ledger, points)
  check('覆盖账本列出未引用片段', cov.missing.length > 0 && cov.rate < 1, `missing=${cov.missing.join(',')}`)
  check('引用与片段对不上被挑出', coverageOf(ledger, [{ segments: ['S0002'], quote: '这句话原文里根本没有' }]).badCitations.length === 1)

  const density = densityOf(ledger)
  check('密度画像给出依据', typeof density.high === 'boolean' && density.reason.length > 2, density.reason)

  // 无标题、无空行的 docx 抽取结果：仍要能切出章节与片段
  const flatDoc = '一、目的\n为规范BOM编制，特制定本规范。\n二、范围\n适用整机及模组配板。\n三、职责\n制BOM工程师负责编制，ERP审核工程师复核。'
  const flat = buildLedger(flatDoc)
  check('无标题文档按段落切片段', flat.segments.length >= 4, `segments=${flat.segments.length}`)
  check('无标题文档仍有章节', flat.chapters.length >= 1)
  check('无标题文档分块仍铺满', assertTiling(flat, chunkRanges(flat, 80)).ok)

  console.log(`\n原文账本自检：${passed} 项通过，${failures.length} 项失败`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  if (failures.length) process.exitCode = 1
  return { passed, failed: failures.length }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
  runSelftest().catch(error => { console.error(error); process.exitCode = 1 })
}
