#!/usr/bin/env python3
"""Render the first ten minutes of INTERNALPPM as an auditable Word transcript."""

from __future__ import annotations

import json
import re
import argparse
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


INPUT = Path("outputs/internalppm-first-10min/contextual-recovery-v2.json")
OUTPUT = Path("outputs/INTERNALPPM-first-10-minutes-recovered-transcript.docx")


def stamp(seconds: float) -> str:
    minutes, seconds = divmod(int(round(seconds)), 60)
    return f"{minutes:02d}:{seconds:02d}"


def comparable(words: list[str]) -> list[str]:
    return [re.sub(r"[^a-z0-9]+", "", word.lower()) for word in words]


def trim_exact_overlap(previous: list[str], current: str) -> str:
    """Remove only verbatim word-boundary overlap from adjacent audio windows."""
    words = current.split()
    prior = comparable(previous)
    candidate = comparable(words)
    for length in range(min(len(prior), len(candidate), 20), 1, -1):
        if prior[-length:] == candidate[:length]:
            return " ".join(words[length:]).strip()
    return current.strip()


def set_cell_shading(cell, colour: str) -> None:
    properties = cell._tc.get_or_add_tcPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), colour)
    properties.append(shading)


def set_cell_margins(cell, top: int = 100, start: int = 120, bottom: int = 100, end: int = 120) -> None:
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def prevent_row_split(row, header: bool = False) -> None:
    properties = row._tr.get_or_add_trPr()
    properties.append(OxmlElement("w:cantSplit"))
    if header:
        marker = OxmlElement("w:tblHeader")
        marker.set(qn("w:val"), "true")
        properties.append(marker)


def remove_paragraph_border(paragraph_or_style) -> None:
    """Avoid Word's inherited blue Title-rule in the exported transcript."""
    properties = paragraph_or_style._element.get_or_add_pPr()
    border = properties.find(qn("w:pBdr"))
    if border is not None:
        properties.remove(border)


def set_border(cell, colour: str = "D9E2DE") -> None:
    properties = cell._tc.get_or_add_tcPr()
    borders = properties.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        properties.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = qn(f"w:{edge}")
        node = borders.find(tag)
        if node is None:
            node = OxmlElement(f"w:{edge}")
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), "4")
        node.set(qn("w:color"), colour)


def put_text(cell, text: str, *, bold: bool = False, colour: str | None = None) -> None:
    paragraph = cell.paragraphs[0]
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.line_spacing = 1.13
    run = paragraph.add_run(text)
    run.bold = bold
    run.font.name = "Aptos"
    run.font.size = Pt(10.5)
    if colour:
        run.font.color.rgb = RGBColor.from_string(colour)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    set_cell_margins(cell)
    set_border(cell)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=INPUT)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8"))
    windows = data.get("windows") or data.get("utteranceReviews") or []
    document = Document()
    section = document.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.7)
    section.bottom_margin = Inches(0.7)
    section.left_margin = Inches(0.72)
    section.right_margin = Inches(0.72)
    styles = document.styles
    styles["Normal"].font.name = "Aptos"
    styles["Normal"].font.size = Pt(10.5)
    styles["Title"].font.name = "Aptos Display"
    styles["Title"].font.size = Pt(22)
    styles["Title"].font.color.rgb = RGBColor(0, 0, 0)
    remove_paragraph_border(styles["Title"])

    title = document.add_paragraph("INTERNALPPM Transcript First 10 Minutes", style="Title")
    remove_paragraph_border(title)
    subtitle = document.add_paragraph("Context-aware, evidence-preserving transcription from 00:00 to 10:00")
    subtitle.paragraph_format.space_after = Pt(10)
    subtitle.runs[0].italic = True
    subtitle.runs[0].font.color.rgb = RGBColor(70, 85, 79)
    explanation = document.add_paragraph(
        "This readable transcript preserves the original ASR evidence. A replacement is shown only when it passes transcript-derived meeting-context review, a separate verification pass, and substitution-only safeguards; unresolved spans remain as captured. Exact repeated words at window boundaries are removed."
    )
    explanation.paragraph_format.space_after = Pt(14)

    table = document.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    table.autofit = False
    table.columns[0].width = Inches(1.13)
    table.columns[1].width = Inches(5.83)
    header = table.rows[0]
    prevent_row_split(header, header=True)
    for cell, label in zip(header.cells, ("Time", "Transcript")):
        set_cell_shading(cell, "174C3C")
        put_text(cell, label, bold=True, colour="FFFFFF")

    previous_words: list[str] = []
    for index, window in enumerate(windows):
        text = trim_exact_overlap(
            previous_words,
            str(window.get("displayRomanText") or window.get("selectedRomanText") or window.get("romanText") or ""),
        )
        if not text:
            continue
        previous_words.extend(text.split())
        row = table.add_row()
        prevent_row_split(row)
        if index % 2:
            for cell in row.cells:
                set_cell_shading(cell, "F4F8F6")
        put_text(row.cells[0], f"{stamp(window['startSeconds'])}–{stamp(window['endSeconds'])}", bold=True)
        put_text(row.cells[1], text)

    document.add_paragraph()
    footer = document.add_paragraph(
        "Model: bodhan-ai indic-transcribe-flex · Readable view: meeting-aware, evidence-gated semantic review"
    )
    footer.runs[0].font.size = Pt(9)
    footer.runs[0].font.color.rgb = RGBColor(90, 100, 95)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document.save(args.output)


if __name__ == "__main__":
    main()
