#!/usr/bin/env python3
"""Build an evidence-only Word transcript from bounded ASR windows."""

from __future__ import annotations

import json
import re
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


CHUNKS = Path("/private/tmp/grav-chunked.jsonl")
CONTEXT = Path("/private/tmp/grav-chunk-39-73.json")
OUTPUT = Path("outputs/recording-5-0000-to-0206-transcript.docx")


def shade(cell, color: str) -> None:
    props = cell._tc.get_or_add_tcPr()
    fill = OxmlElement("w:shd")
    fill.set(qn("w:fill"), color)
    props.append(fill)


def cell_text(cell, text: str, bold: bool = False) -> None:
    paragraph = cell.paragraphs[0]
    paragraph.paragraph_format.space_after = Pt(0)
    run = paragraph.add_run(text)
    run.bold = bold
    run.font.name = "Aptos"
    run.font.size = Pt(10)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def keep_together(row, header: bool = False) -> None:
    props = row._tr.get_or_add_trPr()
    props.append(OxmlElement("w:cantSplit"))
    if header:
        marker = OxmlElement("w:tblHeader")
        marker.set(qn("w:val"), "true")
        props.append(marker)


def segments() -> list[tuple[str, str]]:
    raw = CHUNKS.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    chunks = []
    position = 0
    while position < len(raw):
        while position < len(raw) and raw[position].isspace():
            position += 1
        if position >= len(raw):
            break
        chunk, position = decoder.raw_decode(raw, position)
        chunks.append(chunk)
    by_range = {(item["start"], item["end"]): item["result"]["text"] for item in chunks}
    contextual = json.loads(CONTEXT.read_text(encoding="utf-8"))["text"]
    # These are exact, independent ASR decodes. The middle context window is
    # retained because its wider audio context resolves business names/phrases.
    windows = [
        ("00:00–00:34", by_range[(0, 34)]),
        ("00:39–01:13", contextual),
        ("01:08–01:36", by_range[(68, 96)]),
        ("01:34–02:06", by_range[(94, 126)]),
    ]
    return remove_window_overlap(windows)


def remove_window_overlap(windows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Drop only an exact shared word-boundary prefix from overlapped audio."""
    output: list[tuple[str, str]] = []
    previous_words: list[str] = []
    for time_range, text in windows:
        words = text.split()
        comparable = lambda values: [re.sub(r"[^a-z0-9]+", "", value.lower()) for value in values]
        prior = comparable(previous_words)
        current = comparable(words)
        overlap = 0
        for length in range(min(len(prior), len(current), 18), 2, -1):
            if prior[-length:] == current[:length]:
                overlap = length
                break
        trimmed = " ".join(words[overlap:])
        output.append((time_range, trimmed))
        previous_words.extend(words)
    return output


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    document = Document()
    section = document.sections[0]
    section.top_margin = Inches(0.65)
    section.bottom_margin = Inches(0.65)
    section.left_margin = Inches(0.7)
    section.right_margin = Inches(0.7)
    document.styles["Normal"].font.name = "Aptos"
    document.styles["Normal"].font.size = Pt(10.5)
    document.styles["Title"].font.name = "Aptos Display"
    document.styles["Title"].font.size = Pt(22)

    document.add_paragraph("Recording 5 transcript · 00:00–02:06", style="Title")
    subtitle = document.add_paragraph("Automatic context-aware transcription")
    subtitle.runs[0].italic = True
    document.add_paragraph(
        "Each row is the private STT model’s exact output for a bounded audio window. "
        "Overlapping windows preserve surrounding context for business names and phrases; no text has been manually rewritten."
    )

    document.add_heading("Transcript", level=1)
    table = document.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    headers = (("Time", Inches(1.05)), ("What was heard", Inches(6.55)))
    for index, (label, width) in enumerate(headers):
        table.columns[index].width = width
        shade(table.rows[0].cells[index], "174C3C")
        cell_text(table.rows[0].cells[index], label, bold=True)
        for run in table.rows[0].cells[index].paragraphs[0].runs:
            run.font.color.rgb = RGBColor(255, 255, 255)
    keep_together(table.rows[0], header=True)
    for index, (time_range, text) in enumerate(segments()):
        cells = table.add_row().cells
        keep_together(table.rows[-1])
        if index % 2:
            for cell in cells:
                shade(cell, "F3F7F5")
        cell_text(cells[0], time_range)
        cell_text(cells[1], text)

    note = document.add_paragraph()
    note.add_run("Speaker labels omitted. ").bold = True
    note.add_run(
        "These wider context windows can contain brief overlapping speech; the separate raw diarization remains the evidence for speaker attribution."
    )
    document.save(OUTPUT)


if __name__ == "__main__":
    main()
