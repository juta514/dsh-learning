# 智能助理学院 · 使用说明

这份说明给「学习完成后要在别的会话里继续用学院」的模型看：怎么查已学的知识、怎么发起新学习、怎么更正、怎么重建索引。

## 什么时候用

- 用户问公司规范、BOM、流程、判定标准，而学院学过相关资料时：先检索课堂笔记，再回答；
- 用户要学一份新课件：调用 `learn_document`（或 `/learn`）；
- 用户指出课堂笔记有误：调用 `learn_correct`，先登记待确认，确认后才改；
- 检索明显异常（新内容搜不到、重启后不一致）：调用 `learn_reindex`。

## 工具与命令

| 入口 | 用途 |
|---|---|
| `learn_document` | 学一份资料：全文精读 → 校验 → 题库 → 抽考 → 停在人工复核 |
| `learn_status` | 查学习进度与结果 |
| `learn_correct` | 对定稿笔记提更正；带 `decision=accept/reject` 时执行确认 |
| `learn_reindex` | 重建 ReMe 检索索引（默认向量） |
| `/learn`、`/learn-status` | 命令形式，等价于上面两个工具 |

## 用已学知识回答

1. 先检索：`reme_search("<主题关键词>")`，或直接读知识库：
   `~/.dsh/youlian-knowledge/skills/youlian-product-knowledge/docs/learned/`；
2. 以**课堂精读笔记**为第一引用：它的每条结论都能用 `⟦S####⟧` 回查原文片段；
3. 其它会话记的知识只作参考，引用时说明来源；与课堂笔记冲突时，以课堂笔记的原文依据为准；
4. 课堂笔记没覆盖的问题，明确说「课堂笔记未覆盖」，不要拿旧记忆冒充本课规定；
5. 回答里保留引用编号，方便用户回查。

## 学习一份新资料

`learn_document` 支持 `.md/.txt/.csv/.json/.yaml/.docx/.pdf/.pptx`。
需要 Python 3 + `python-docx`、`pymupdf`、`python-pptx`（或配置 `pythonExe` + `pyLibs`）。
一次学习会发起多次模型调用，通常十几分钟到一小时；进度用 `learn_status` 查。

## 更正课堂知识

1. 发现笔记有误 → `learn_correct({ classroom_id, text, evidence })` 登记「待确认」；
2. 用户确认 → `learn_correct({ classroom_id, correction_id, decision: "accept" })`；
3. 采纳后：更正进课堂补充 → 回退受影响分片 → 复核作废 → 重走校验、题库、抽考、复核；
4. 驳回只记录，笔记不动。**不要在已复核的笔记上直接改字。**

## 学习台账

知识库 `learned/LEARNING-RECORDS.md`（机器可读 `.json`）记录每份资料：
第几版、哪个课堂、覆盖/倍数/题数、抽考、复核日期、勘误、文件与记忆分段。
检索示例：`reme_search("学习记录 物料分类")`。

## 数据在哪

- 课堂与过程产物：`~/.dsh/learning/`
- 知识库与台账：`~/.dsh/youlian-knowledge/`
- 长期记忆：ReMe 工作区（`/daily/<日期>/learn-*`、`topic-*`、`learning-records`）
- 上传原件：`~/.dsh/learning/uploads/`、课堂内 `original/`

停用插件不丢数据；换机器需要带走上面这些目录（或重新学习）。

## 权限与边界

- 学院只写知识库目录、课堂目录与 ReMe，不给模型开通用写盘权限；
- 入库前要求笔记哈希与复核一致，并对 ReMe 逐段读回比对，不一致判失败；
- 复核通过之后才出题库与入库；抽考不过会退回重学，最多三轮。
