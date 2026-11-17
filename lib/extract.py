"""Plain-text extractor for the resident learning pipeline.

Usage: python extract.py <file-path> [max-chars]

Writes UTF-8 text to stdout. Diagnostics go to stderr.
This script never writes to disk and never executes anything from the input.

Warnings that matter for「全文完整读取」are printed to stderr as
`YOULIAN_EXTRACT_WARN: <message>` lines, one per lossy finding (scanned pages,
images, headers/footers, footnotes). The learning engine surfaces them to the
user instead of pretending the text was complete.
"""

from __future__ import annotations

import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_LIBS = os.environ.get("YOULIAN_PY_LIBS")
if _LIBS and os.path.isdir(_LIBS):
    sys.path.insert(0, _LIBS)

PLAIN = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".log", ".xml", ".html", ".htm"}


def warn(message: str) -> None:
    print(f"YOULIAN_EXTRACT_WARN: {message}", file=sys.stderr)


def detect(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "big5", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def from_plain(path: str) -> str:
    with open(path, "rb") as f:
        return detect(f.read())


def from_docx(path: str) -> str:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn

    doc = Document(path)
    out = []
    lists = 0
    images = 0
    footnotes = 0
    notes_part = getattr(doc.part, "footnotes_part", None)
    if notes_part is not None:
        footnotes = len(notes_part.element.findall(qn("w:footnote")))
    body = doc.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            paragraph = Paragraph(child, doc)
            text = paragraph.text.strip()
            if not text:
                continue
            # 自动编号由 Word 生成，python-docx 读不到编号本身。
            # 这里保留「这是一条列表项」的结构（前缀 - ），编号仍需回看原件。
            numbered = child.find(qn("w:pPr")) is not None and child.find(qn("w:pPr")).find(qn("w:numPr")) is not None
            if numbered:
                lists += 1
                text = f"- {text}"
            out.append(text)
        elif child.tag == qn("w:tbl"):
            table = Table(child, doc)
            for row in table.rows:
                cells = [c.text.replace("\n", " ").strip() for c in row.cells]
                out.append(" | ".join(cells))
        if child.tag == qn("w:p"):
            images += len(child.findall(qn("w:r") + "/" + qn("w:drawing")))
    if lists:
        warn(f"文档有 {lists} 处自动编号列表：已按列表项保留结构，编号数字请回看原件核对")
    if images:
        warn(f"文档内嵌 {images} 张图片/示意图，文字抽取不包含图内内容")
    if footnotes:
        warn(f"文档有 {footnotes} 条脚注，文字抽取不包含脚注正文")
    for section in doc.sections:
        head = " ".join(p.text.strip() for p in section.header.paragraphs if p.text.strip())
        foot = " ".join(p.text.strip() for p in section.footer.paragraphs if p.text.strip())
        if head:
            warn(f"页眉未抽取：{head[:40]}")
            break
    for paragraph in doc.paragraphs:
        if paragraph.style is not None and "Title" in str(paragraph.style.name):
            continue
    return "\n".join(out)


def from_pdf(path: str) -> str:
    import pymupdf

    out = []
    empty_pages = []
    with pymupdf.open(path) as doc:
        for i, page in enumerate(doc, 1):
            text = page.get_text("text").strip()
            if text:
                out.append(f"\n===== 第 {i} 页 =====\n{text}")
            else:
                empty_pages.append(i)
        total = doc.page_count
    if empty_pages:
        pages = "、".join(str(p) for p in empty_pages[:10])
        warn(f"第 {pages} 页没有文字层（多半是扫描页），这些页的内容没有被抽取，需要 OCR 或补文字版")
    warn(f"PDF 共 {total} 页；表格按阅读顺序展开成文本，单元格边界以 | 保留")
    return "\n".join(out)


def from_pptx(path: str) -> str:
    from pptx import Presentation

    prs = Presentation(path)
    out = []
    images = 0
    for i, slide in enumerate(prs.slides, 1):
        lines = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    t = "".join(run.text for run in para.runs).strip()
                    if t:
                        lines.append(t)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    lines.append(" | ".join(c.text.strip() for c in row.cells))
            if shape.shape_type == 13:  # MSO_SHAPE_TYPE.PICTURE
                images += 1
        if lines:
            out.append(f"\n===== 第 {i} 页 =====\n" + "\n".join(lines))
    if images:
        warn(f"演示文稿含 {images} 张图片，文字抽取不包含图内内容")
    return "\n".join(out)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: extract.py <file> [max-chars]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 200000
    if not os.path.isfile(path):
        print(f"file not found: {path}", file=sys.stderr)
        return 2
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in PLAIN:
            text = from_plain(path)
        elif ext == ".docx":
            text = from_docx(path)
        elif ext == ".pdf":
            text = from_pdf(path)
        elif ext == ".pptx":
            text = from_pptx(path)
        else:
            print(
                f"unsupported format {ext}: convert to .txt or .md first (legacy .doc/.chm are not supported)",
                file=sys.stderr,
            )
            return 3
    except ImportError as exc:
        print(f"missing extraction dependency: {exc}", file=sys.stderr)
        return 4
    except Exception as exc:  # noqa: BLE001
        print(f"extraction failed: {exc}", file=sys.stderr)
        return 4

    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    raw_len = len(text)
    if len(text) > limit:
        text = text[:limit] + f"\n\n[抽取文本已截断，原文共 {raw_len} 字符]"
    if not text.strip():
        print("extraction produced no text (scanned image or empty document)", file=sys.stderr)
        return 5
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
