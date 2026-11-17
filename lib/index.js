/**
 * dsh-learning-academy — 智能助理学院 for DeepSeek Harness.
 *
 * Registers four tools (`learn_document`, `learn_status`, `learn_correct`,
 * `learn_reindex`), two slash commands (`/learn`, `/learn-status`), and a
 * self-contained Web academy at `/academy`. The sidebar entry and the keyed
 * `main` seat ship as this package's own client half (`lib/client.js`,
 * declared through `dsh.client`), so installing one bundle provides both the
 * Host API and the browser entry. No npm dependencies: all imports are Node
 * built-ins, and every LLM call goes through `ctx.llm`.
 *
 * The whole thing is a single local bundle. Remove its link: entry from the
 * profile and the tools, page and API routes all disappear together; remove
 * the panel plugin row and the sidebar entry goes with it.
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, runPipeline, readStatus, summarize } from './pipeline.js'
import { fileCorrection, decideCorrection, reindexMemory } from './engine.js'
import { mountAcademy } from './academy.js'

export const name = 'learning-academy'
export const inject = ['tools', 'commands', 'llm', 'skills']

/** Durable proof that this plugin was loaded and all four registrations succeeded. */
async function writeReady(cfg, tools, commands) {
  const payload = {
    plugin: name,
    readyAt: new Date().toISOString(),
    tools,
    commands,
    academy: {
      enabled: cfg.academyEnabled !== false,
      page: '/academy',
      entry: 'sidebar.panellist#academy (本插件的客户端半边 lib/client.js), framed in the keyed main seat',
      api: [
        '/api/academy/materials', '/api/academy/material',
        '/api/academy/material/upload', '/api/academy/material/enter',
        '/api/academy/material/learn',
        '/api/academy/courses', '/api/academy/course',
        '/api/academy/status', '/api/academy/upload',
        '/api/academy/classrooms', '/api/academy/classroom',
        '/api/academy/classroom/notes',
      ],
      library: {
        root: 'stateRoot/library/<materialId>/',
        layout: ['meta.json', 'v<N>/source.md', 'v<N>/parts/NN-*.md', 'attempts/N/attempt.json'],
        status: ['uploaded', 'studying', 'completed'],
        upload: 'one request ≤ 20 files = one material with N parts; no model call',
        versioning: 'same materialId, version+1, old version dirs and old classroom bindings kept',
        enter: 'opens the current-version classroom; creates a pending one only if none exists, which does not count as an attempt until the class actually starts',
      },
      classroom: {
        enabled: true,
        dialogue: 'stateRoot/classrooms/<id>/dialogue.jsonl',
        notes: 'stateRoot/classrooms/<id>/class-notes.md',
        engine: cfg.engine === 'v1' ? 'lib/teaching.js (v1)' : 'lib/engine.js (v2 全文精读)',
        stages: ['ready', 'prep', 'study', 'clarify', 'review', 'exam', 'finished'],
        steps: ['scope', 'overview-chapter', 'overview-merge', 'map', 'read', 'absorb', 'clarify', 'reconcile', 'validate', 'quiz', 'exam', 'review', 'bind', 'commit'],
        artifacts: [
          'source.md', 'ledger.json', 'plan.json', 'scope.json', 'overview.json', 'knowledge-map.json',
          'synthesis.json', 'validation.json', 'notes-final.md', 'quiz.json', 'quiz.md',
          'exam.json', 'provenance.json', 'commit.json',
        ],
        taskState: 'stateRoot/classrooms/<id>/task_state/{plan,read,notes,validation}',
        actions: ['open', 'teach', 'advance', 'say', 'ask', 'decide', 'review', 'upgrade', 'state'],
        gates: {
          deterministic: ['片段覆盖', '引用可溯源', '硬指标齐全', '表格行', '笔记字数', '说明充分', '复述比例', '解释深度', '套话重复', '全局理解'],
          exam: '题库约每 100 字一题；按章节分层抽考，闭卷只用笔记作答，通过率低于结线就退回重学',
          manualReview: cfg.enableManualReview !== false,
          noteRatioTarget: cfg.noteRatioTarget,
          maxSourceChars: cfg.maxSourceChars,
        },
      },
    },
    provider: cfg.provider,
    model: cfg.model,
    knowledgeRoot: cfg.knowledgeRoot,
    stateRoot: cfg.stateRoot,
  }
  await mkdir(cfg.stateRoot, { recursive: true })
  await writeFile(join(cfg.stateRoot, 'ready.json'), JSON.stringify(payload, null, 2), 'utf8')
}

function parseArgs(raw) {
  const out = {}
  const rest = String(raw || '').replace(
    /(?:^|\s)(path|title|tags)=("[^"]*"|'[^']*'|\S+)/gi,
    (_match, key, value) => {
      out[key.toLowerCase()] = value.replace(/^["']|["']$/g, '')
      return ' '
    },
  ).trim()
  if (rest && !out.path) out.path = rest
  return out
}

function splitTags(value) {
  if (!value) return []
  return String(value).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8)
}

function optionsFrom(source, sessionId, signal) {
  const args = parseArgs(source.rawInput)
  const file = (source.attachments || []).find(a => a?.type === 'file')
  return {
    filePath: args.path,
    attachmentId: file?.attachment?.attachmentId,
    attachmentName: file?.attachment?.name,
    title: args.title,
    tags: splitTags(args.tags),
    sessionId,
    signal,
  }
}

function resultValue(result, status) {
  if (result?.status === 'awaiting_review') {
    return {
      status: 'awaiting_review',
      title: result.title,
      source: result.source,
      score: 0,
      passThreshold: Number(result.passThreshold ?? 0.75),
      knowledgePoints: 0,
      questions: 0,
      corrections: 0,
      docPath: '',
      reviewRequired: true,
      dailyWriteOk: false,
      reindexOk: false,
      memorySearchHit: false,
      summary: [
        `已学完原文、自动校验通过，等你复核：${result.title}`,
        `来源：${result.source}`,
        `课堂：${result.classroomId}`,
        '下一步：在左侧「智能助理学院」打开这间课堂，看过定稿笔记点「复核通过」，系统会自动出题、绑定溯源并写入知识库与长期记忆。',
        '复核之前不会出题，也不会入库。',
      ].join('\n'),
    }
  }
  if (result?.status === 'running') {
    return {
      status: 'running',
      title: result.title,
      source: result.source,
      score: 0,
      passThreshold: Number(result.passThreshold ?? 0.75),
      knowledgePoints: 0,
      questions: 0,
      corrections: 0,
      docPath: '',
      reviewRequired: false,
      dailyWriteOk: false,
      reindexOk: false,
      memorySearchHit: false,
      summary: [
        `学习还在进行：${result.title}（阶段 ${result.stage || result.note || '推进中'}）`,
        `来源：${result.source}`,
        `课堂：${result.classroomId}`,
        '进度都已落盘；去「智能助理学院」那间课堂点「继续上课」接着走，不会从头再来。',
      ].join('\n'),
    }
  }
  if (result?.status === 'blocked') {
    return {
      status: 'blocked',
      title: result.title,
      source: result.source,
      score: 0,
      passThreshold: Number(result.passThreshold ?? 0.75),
      knowledgePoints: 0,
      questions: 0,
      corrections: 0,
      docPath: '',
      reviewRequired: true,
      dailyWriteOk: false,
      reindexOk: false,
      memorySearchHit: false,
      summary: [
        `学习停在没过的校验上：${result.title}`,
        `原因：${result.error || '自动校验未通过'}`,
        `课堂：${result.classroomId}`,
        '去学院页面看校验报告，按意见退回重拆；超过重试上限就会停在这里等人工处理，不会强行入库。',
      ].join('\n'),
    }
  }
  const lines = [
    `学习完成：${result.title}`,
    `来源：${result.source}`,
    `笔记倍数：${result.score}（有效字数 / 原文字数）`,
    `知识点 ${result.knowledgePoints} 条，考核题 ${result.questions} 道，校验缺项 ${result.corrections} 处`,
    `知识文件：${result.docPath}`,
    `技能入口：${result.librarySkillPath || '未写入'}${result.libraryChanged ? '（已追加清单）' : ''}`,
    `长期记忆：daily_write ${result.reme.dailyWriteOk ? '成功' : '未成功'}，reindex ${result.reme.reindexOk ? '成功' : '未成功'}，检索命中 ${result.memorySearchHit ? '是' : '否'}`,
    result.summary ? `交付：${result.summary}` : '',
    `阶段产物：${result.sessionDir}`,
  ].filter(Boolean)
  return {
    status,
    title: result.title,
    source: result.source,
    score: result.score,
    passThreshold: result.passThreshold,
    knowledgePoints: result.knowledgePoints,
    questions: result.questions,
    corrections: result.corrections,
    docPath: result.docPath,
    reviewRequired: result.reviewRequired,
    dailyWriteOk: result.reme.dailyWriteOk,
    reindexOk: result.reme.reindexOk,
    memorySearchHit: Boolean(result.memorySearchHit),
    summary: lines.join('\n'),
  }
}

export function apply(ctx, rawConfig) {
  // 可移植默认值：没配路径时按当前用户目录推导，换机器/换用户不用改插件文件
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  const portable = {
    knowledgeRoot: join(home, '.dsh', 'academy-knowledge', 'skills', 'product-knowledge', 'docs'),
    skillsRoot: join(home, '.dsh', 'academy-knowledge', 'skills'),
    stateRoot: join(home, '.dsh', 'learning'),
    attachmentsRoot: join(home, '.dsh', 'attachments', 'v1'),
  }
  const cfg = { ...DEFAULTS, ...portable, ...(rawConfig || {}) }
  for (const [key, value] of Object.entries(portable)) {
    if (!cfg[key]) cfg[key] = value
  }
  cfg.maxSourceChars = Number(cfg.maxSourceChars) || DEFAULTS.maxSourceChars
  cfg.maxTokens = Number(cfg.maxTokens) || DEFAULTS.maxTokens
  cfg.passThreshold = Number(cfg.passThreshold) || DEFAULTS.passThreshold

  // 使用说明注册成运行时技能：学完之后，别的会话的模型也能按它检索与使用学院
  try {
    const guide = readFileSync(new URL('../GUIDE.md', import.meta.url), 'utf8')
    ctx.skills.register({
      name: 'learning-academy',
      description: '智能助理学院：用课堂精读笔记回答、发起学习、更正笔记、重建索引',
      whenToUse: '用户问公司规范/BOM/流程且学院学过相关资料，或要学习新资料、更正课堂笔记、重建检索索引时',
      content: guide,
      source: 'runtime',
    })
  } catch (error) {
    ctx.logger?.warn?.(`[learning-academy] 使用说明注册失败：${String(error?.message || error)}`)
  }

  const learnTool = {
    name: 'learn_document',
    description:
      '让智能体真正学会一份资料（全文精读闭环）：原文先切成片段账本，先通读建全文框架，再拆条款、逐片精读（每片带着框架），'
      + '答疑后做综合核对（对框架、找冲突、记初读纠正）；校验与质量审查逐项核对覆盖、引用、数值/条款号/型号、表格行、笔记字数（高密度文档逐片要求 ≥ 原文 2 倍）、复述比例与解释深度；'
      + '不过就退回重拆，超过重试上限停下来等你处理。之后按原文密度出题库（约每 100 字一题），闭卷抽考（只给笔记作答），考核通过后停在人工复核；'
      + '你点头后才绑定原文溯源、写入知识库与长期记忆（写入后逐段读回比对）。'
      + ' 支持 .md/.txt/.csv/.json/.yaml 以及 .docx/.pdf/.pptx；旧的 .doc/.chm 需先转换。'
      + ' 一次调用会发起多次模型请求、耗时较长；不要在对话中重复调用同一份文件。详细用法见技能 learning-academy。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '要学习的资料绝对路径。与 attachment_id 二选一。' },
        attachment_id: { type: 'string', description: '已上传附件的 sha256 ID，替代 path。' },
        attachment_name: { type: 'string', description: '附件显示文件名，配合 attachment_id 使用。' },
        title: { type: 'string', description: '学习产物的标题；缺省时由老师备课结果决定。' },
        tags: { type: 'array', items: { type: 'string' }, description: '写入知识文件 frontmatter 的标签。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'status', 'title', 'source', 'score', 'passThreshold', 'knowledgePoints',
          'questions', 'corrections', 'docPath', 'reviewRequired', 'dailyWriteOk',
          'reindexOk', 'memorySearchHit', 'summary',
        ],
        properties: {
          status: { type: 'string' },
          title: { type: 'string' },
          source: { type: 'string' },
          score: { type: 'number' },
          passThreshold: { type: 'number' },
          knowledgePoints: { type: 'number' },
          questions: { type: 'number' },
          corrections: { type: 'number' },
          docPath: { type: 'string' },
          reviewRequired: { type: 'boolean' },
          dailyWriteOk: { type: 'boolean' },
          reindexOk: { type: 'boolean' },
          memorySearchHit: { type: 'boolean' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    timeoutMs: 1800000,
    async execute(args, exec) {
      const input = args || {}
      const result = await runPipeline(ctx, cfg, {
        filePath: input.path,
        attachmentId: input.attachment_id,
        attachmentName: input.attachment_name,
        title: input.title,
        tags: Array.isArray(input.tags) ? input.tags : [],
        sessionId: exec?.agent?.session?.id,
        signal: exec?.signal,
        budgetMs: Math.min(Number(cfg.toolBudgetMs) || 20 * 60 * 1000, 25 * 60 * 1000),
      })
      return resultValue(result, result.status === 'completed' ? (result.reviewRequired ? 'completed_needs_review' : 'completed') : result.status)
    },
  }

  const statusTool = {
    name: 'learn_status',
    description: '查看常驻学习流水线的会话进度与结果。给 id 查单次会话，不给则列出最近几次。学习任务运行时可用它轮询阶段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '学习会话 ID，形如 learn-20261115120000-abcd1234；省略则列出最近会话。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const state = await readStatus(cfg, (args || {}).id)
      return { text: summarize(state) }
    },
  }

  // 更正课堂知识：先登记提案，用户确认后才回退重学；不在已复核的笔记上直接改字。
  const correctTool = {
    name: 'learn_correct',
    description: '对一间课堂的定稿笔记提更正：不带 decision 时登记为「待确认」；带 decision=accept/reject 时由用户确认后执行。'
      + ' 确认采纳会把更正记进课堂补充、回退受影响分片、作废复核结论并重走校验与抽考。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['classroom_id'],
      properties: {
        classroom_id: { type: 'string', description: '课堂 ID，形如 class-YYYYMMDDHHMMSS-xxxxxxxx。' },
        text: { type: 'string', description: '更正内容：原来是什么、应该改成什么。不带 decision 时必填。' },
        evidence: { type: 'string', description: '依据：原文原句或权威文件出处；能对上原文会自动标片段。' },
        origin: { type: 'string', description: '提出更正的会话/来源，便于复核时追溯。' },
        decision: { type: 'string', enum: ['accept', 'reject'], description: '用户确认后的处理。' },
        correction_id: { type: 'string', description: '要处理的提案 ID；带 decision 时必填。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const input = args || {}
      const id = String(input.classroom_id || '').trim()
      if (!id) return { text: '缺少 classroom_id。' }
      try {
        if (input.decision) {
          const out = await decideCorrection(cfg.stateRoot, {
            id,
            correctionId: String(input.correction_id || ''),
            accept: input.decision === 'accept',
          })
          const applied = out.correction.status === 'accepted'
          return {
            text: `${applied ? '已采纳' : '已驳回'}更正 ${out.correction.id}：${out.correction.text.slice(0, 120)}\n`
              + (applied
                ? `受影响分片已回退，复核结论作废，当前阶段 ${out.stage}；重新上课后会重走校验、题库与抽考，复核通过才重新入库。`
                : '笔记未改动。')
              + `\n待确认提案：${out.pending.filter(item => item.status === 'pending').length} 条。`,
          }
        }
        const out = await fileCorrection(cfg.stateRoot, {
          id,
          text: input.text,
          evidence: input.evidence,
          origin: input.origin,
        })
        return {
          text: `已登记待确认更正 ${out.correction.id}：${out.correction.text.slice(0, 160)}\n`
            + `原文依据：${out.correction.support ? out.correction.support.slice(0, 120) : '未找到原文原句，按课外补充记录'}\n`
            + `待确认提案：${out.pending.filter(item => item.status === 'pending').length} 条。`
            + ' 你确认后我再执行采纳，采纳会回退受影响分片并重走复核。',
        }
      } catch (error) {
        return { text: `更正处理失败：${String(error?.message || error)}` }
      }
    },
  }

  const reindexTool = {
    name: 'learn_reindex',
    description: '重建学院知识的 ReMe 检索索引。默认只重建向量（embedding），可选 bm25 / tag；all 会把全部块重新嵌入，耗时和嵌入调用都更多，只有用户明确要求时才用。'
      + ' 只在用户要求重建索引，或检索明显异常（新内容搜不到、语义命中变差、重启后索引不一致）时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['embedding', 'bm25', 'tag', 'all'],
          description: '默认 embedding（向量）；bm25 只重建关键词；all 全量（含向量重嵌入，较慢）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const scope = String((args || {}).scope || 'embedding')
      const out = await reindexMemory(cfg, scope)
      const seconds = (Math.max(0, out.ms) / 1000).toFixed(1)
      return {
        text: out.ok
          ? `索引已重建：scope=${out.scope}，耗时 ${seconds} 秒${out.indexed == null ? '' : `，${out.indexed} 块`}。${out.detail || ''}`
          : `重建失败（scope=${out.scope}）：${out.error}`,
      }
    },
  }

  const learnCommand = {
    name: 'learn',
    description: '把随命令上传的资料（或 path= 指定的文件）交给教学闭环学习，学完写入知识库与长期记忆',
    input: {
      hint: 'path="C:\\path\\to\\file.pdf" title=标题 tags=规范,BOM（也可直接附加文件）',
      attachments: true,
    },
    handler: async invocation => {
      const options = optionsFrom(
        {
          rawInput: invocation.rawInput,
          attachments: invocation.attachments,
        },
        invocation.agent?.session?.id,
        // The UI request signal is aborted as soon as this handler returns.
        // A background pipeline must not inherit it.
        undefined,
      )
      if (!options.filePath && !options.attachmentId) {
        return { kind: 'error', text: '请随 /learn 附上文件，或用 path="绝对路径" 指定要学习的资料。' }
      }
      void runPipeline(ctx, cfg, options).catch(error => {
        ctx.logger?.warn?.(`[learning-academy] pipeline failed: ${String(error?.message || error)}`)
      })
      return {
        kind: 'success',
        text: '学习任务已在后台启动：原文切片段账本 → 逐片精读写知识点 → 八项自动校验（不过就回退重拆）'
          + ' → 停在这里等你复核 → 复核通过后按条款出题、绑定原文溯源、写入知识库与长期记忆。'
          + ' 过程会发起多次模型请求，通常需要十几分钟到一小时；用 /learn-status 查看进度，'
          + '也可以在左侧「智能助理学院」里打开这间课堂看实时动作。',
      }
    },
  }

  const statusCommand = {
    name: 'learn-status',
    description: '查看学习流水线的进度与结果，可带会话 ID',
    input: { hint: '会话 ID（可省略，省略则列出最近几次）' },
    handler: async invocation => {
      try {
        const id = String(invocation.rawInput || '').trim().split(/\s+/)[0]
        const state = await readStatus(cfg, id || undefined)
        return { kind: 'success', text: summarize(state) }
      } catch (error) {
        return { kind: 'error', text: `读取学习状态失败：${String(error?.message || error)}` }
      }
    },
  }

  if (cfg.academyEnabled !== false) {
    void mountAcademy(ctx, cfg, runPipeline).catch(error => {
      try {
        ctx.root?.logger?.('learning-academy')?.warn?.(`academy mount failed: ${String(error?.message || error)}`)
      } catch { /* optional logger */ }
    })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(learnTool),
      ctx.tools.register(statusTool),
      ctx.tools.register(correctTool),
      ctx.tools.register(reindexTool),
      ctx.commands.register(learnCommand),
      ctx.commands.register(statusCommand),
    ]
    void writeReady(cfg, ['learn_document', 'learn_status', 'learn_correct', 'learn_reindex'], ['learn', 'learn-status'])
      .catch(error => {
        ctx.root?.logger?.('learning-academy')?.warn?.(`ready marker failed: ${String(error?.message || error)}`)
      })
    try {
      ctx.root?.logger?.('learning-academy')?.info?.('registered learn_document, learn_status, /learn, /learn-status')
    } catch { /* logger is optional in headless compositions */ }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'learning-academy registrations')
}
