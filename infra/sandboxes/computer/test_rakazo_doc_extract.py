#!/usr/bin/env python3
"""Offline regression tests for rakazo-doc-extract using small files and low ceilings.

Covers:
1. Positive control: normal PDF and normal nested ZIP within budget.
2. Nested ZIP exceeding max_depth across the shared ExtractionBudget tree.
3. Archive member count exceeding max_entries.
4. Cumulative extracted bytes exceeding max_total_bytes.
5. Streamed byte ceiling enforcement when ZIP header metadata (file_size) is spoofed smaller than the actual payload.
6. Corrupt/unparseable document and parser unavailable classification.
7. Multi-page PDF never silently omits blank/unreadable pages and enforces max_pages budget.
8. XLSX evaluates uncached formula cells (<f> without <v>) and enforces max_rows budget with truncated=True.
9. DOCX extracts paragraphs and tables with stdlib ECMA-376 OpenXML fallback.
10. Unsupported binary formats (.doc/.xls/.rar/.7z/.bin), encrypted PDF/Office/ZIP classification, and mixed archive partial extraction flagging.
11. Shared output character budget (max_output_chars) marks truncated=True and limitExceeded="output_char_limit_exceeded".
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile

SCRIPT_PATH = Path(__file__).resolve().parent / "rakazo-doc-extract"
loader = importlib.machinery.SourceFileLoader("rakazo_doc_extract", str(SCRIPT_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


def _make_minimal_valid_pdf(text: str = "PDF-POSITIVE-CONTROL-2026") -> bytes:
    return _make_multipage_pdf([text])


def _make_multipage_pdf(pages: list[str]) -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}

    def add_obj(obj_id: int, body: bytes) -> None:
        offsets[obj_id] = len(out)
        out.extend(f"{obj_id} 0 obj\n".encode("latin-1"))
        out.extend(body)
        if not body.endswith(b"\n"):
            out.extend(b"\n")
        out.extend(b"endobj\n")

    page_obj_ids = [4 + i * 2 for i in range(len(pages))]
    kids_str = " ".join(f"{pid} 0 R" for pid in page_obj_ids)
    add_obj(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    add_obj(2, f"<< /Type /Pages /Kids [{kids_str}] /Count {len(pages)} >>".encode("latin-1"))
    add_obj(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for i, text in enumerate(pages):
        pid = 4 + i * 2
        cid = pid + 1
        if text:
            safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream = f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET".encode("latin-1")
        else:
            stream = b""
        add_obj(
            pid,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {cid} 0 R /Resources << /Font << /F1 3 0 R >> >> >>".encode(
                "latin-1"
            ),
        )
        add_obj(cid, f"<< /Length {len(stream)} >>\nstream\n".encode("latin-1") + stream + b"\nendstream")

    max_id = max(offsets.keys())
    xref_pos = len(out)
    out.extend(f"xref\n0 {max_id + 1}\n0000000000 65535 f \n".encode("latin-1"))
    for idx in range(1, max_id + 1):
        off = offsets.get(idx, 0)
        out.extend(f"{off:010d} 00000 n \n".encode("latin-1"))
    out.extend(
        f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("latin-1")
    )
    return bytes(out)


def _make_minimal_docx(paragraphs: list[str], table_rows: list[list[str]]) -> bytes:
    buf = io.BytesIO()
    body_parts: list[str] = []
    for p in paragraphs:
        body_parts.append(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>")
    if table_rows:
        tr_xml: list[str] = []
        for row in table_rows:
            tc_xml = "".join(f"<w:tc><w:p><w:r><w:t>{cell}</w:t></w:r></w:p></w:tc>" for cell in row)
            tr_xml.append(f"<w:tr>{tc_xml}</w:tr>")
        body_parts.append(f"<w:tbl>{''.join(tr_xml)}</w:tbl>")
    doc_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(body_parts)}</w:body></w:document>"
    )
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("word/document.xml", doc_xml)
    return buf.getvalue()


def _make_minimal_xlsx_uncached_formula() -> bytes:
    buf = io.BytesIO()
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    sheet1_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>"
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>1200</v></c></row>'
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Q2</t></is></c><c r="B3"><v>800</v></c></row>'
        '<row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4"><f>SUM(B2:B3)</f></c></row>'
        "</sheetData></worksheet>"
    )
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/_rels/workbook.xml.rels", rels_xml)
        zf.writestr("xl/worksheets/sheet1.xml", sheet1_xml)
    return buf.getvalue()


def _mark_zip_entries_encrypted(zip_bytes: bytes) -> bytes:
    data = bytearray(zip_bytes)
    idx = 0
    while True:
        pos = data.find(b"PK\x03\x04", idx)
        if pos == -1:
            break
        flags = struct.unpack_from("<H", data, pos + 6)[0]
        struct.pack_into("<H", data, pos + 6, flags | 0x1)
        idx = pos + 4
    idx = 0
    while True:
        pos = data.find(b"PK\x01\x02", idx)
        if pos == -1:
            break
        flags = struct.unpack_from("<H", data, pos + 8)[0]
        struct.pack_into("<H", data, pos + 8, flags | 0x1)
        idx = pos + 4
    return bytes(data)


class RakazoDocExtractBudgetTests(unittest.TestCase):
    def test_positive_control_pdf_and_normal_zip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "sample.pdf"
            pdf_path.write_bytes(_make_minimal_valid_pdf("PDF-POSITIVE-CONTROL-2026"))
            pdf_res = mod.extract_document(pdf_path, budget=mod.ExtractionBudget())
            self.assertTrue(pdf_res["ok"])
            self.assertEqual(pdf_res["type"], "pdf")
            self.assertFalse(pdf_res["truncated"])
            self.assertIn("PDF-POSITIVE-CONTROL-2026", pdf_res["text"])

            inner_zip_buf = io.BytesIO()
            with zipfile.ZipFile(inner_zip_buf, "w", zipfile.ZIP_DEFLATED) as zf_in:
                zf_in.writestr("inner/contract.pdf", _make_minimal_valid_pdf("ZIP-INNER-PDF-OK-7731"))

            outer_zip = Path(tmp) / "bundle.zip"
            with zipfile.ZipFile(outer_zip, "w", zipfile.ZIP_DEFLATED) as zf_out:
                zf_out.writestr("readme.txt", "OUTER-README-OK")
                zf_out.writestr("nested.zip", inner_zip_buf.getvalue())

            zip_res = mod.extract_document(outer_zip, budget=mod.ExtractionBudget(max_depth=3))
            self.assertTrue(zip_res["ok"])
            self.assertFalse(zip_res["truncated"])
            self.assertIsNone(zip_res["limitExceeded"])
            self.assertIn("OUTER-README-OK", zip_res["text"])
            self.assertIn("ZIP-INNER-PDF-OK-7731", zip_res["text"])

    def test_nested_zip_exceeds_max_depth(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lvl2 = io.BytesIO()
            with zipfile.ZipFile(lvl2, "w") as z2:
                z2.writestr("deep.txt", "SHOULD_NOT_BE_EXTRACTED_DEPTH_2")

            lvl1 = io.BytesIO()
            with zipfile.ZipFile(lvl1, "w") as z1:
                z1.writestr("allowed_lvl1.txt", "ALLOWED_AT_DEPTH_1")
                z1.writestr("lvl2.zip", lvl2.getvalue())

            root_zip = Path(tmp) / "root.zip"
            with zipfile.ZipFile(root_zip, "w") as z0:
                z0.writestr("lvl1.zip", lvl1.getvalue())

            budget = mod.ExtractionBudget(max_depth=1)
            res = mod.extract_document(root_zip, budget=budget)
            self.assertTrue(res["truncated"])
            self.assertEqual(res["limitExceeded"], "zip_depth_limit_exceeded")
            self.assertIn("ALLOWED_AT_DEPTH_1", res["text"])
            self.assertNotIn("SHOULD_NOT_BE_EXTRACTED_DEPTH_2", res["text"])
            self.assertIn("PARTIAL ARCHIVE EXTRACTION", res["text"])

    def test_member_count_exceeds_max_entries_across_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "many.zip"
            with zipfile.ZipFile(zpath, "w") as zf:
                for i in range(1, 6):
                    zf.writestr(f"file_{i}.txt", f"CONTENT_ENTRY_{i}")

            budget = mod.ExtractionBudget(max_entries=2)
            res = mod.extract_document(zpath, budget=budget)
            self.assertTrue(res["ok"])
            self.assertTrue(res["truncated"])
            self.assertEqual(res["limitExceeded"], "zip_entry_count_limit_exceeded")
            self.assertEqual(len(res["entries"]), 2)
            self.assertIn("CONTENT_ENTRY_1", res["text"])
            self.assertIn("CONTENT_ENTRY_2", res["text"])
            self.assertNotIn("CONTENT_ENTRY_3", res["text"])
            self.assertIn("PARTIAL ARCHIVE EXTRACTION", res["text"])

    def test_cumulative_bytes_exceed_max_total_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "cumulative.zip"
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("part1.txt", "A" * 80)
                zf.writestr("part2.txt", "B" * 80)

            budget = mod.ExtractionBudget(max_entry_bytes=200, max_total_bytes=120)
            res = mod.extract_document(zpath, budget=budget)
            self.assertTrue(res["truncated"])
            self.assertEqual(res["limitExceeded"], "zip_total_bytes_limit_exceeded")
            self.assertIn("AAAA", res["text"])
            self.assertNotIn("BBBB", res["text"])
            self.assertIn("PARTIAL ARCHIVE EXTRACTION", res["text"])

    def test_streamed_ceiling_enforced_when_zip_header_metadata_is_spoofed(self) -> None:
        """Even if ZipInfo.file_size claims 10 bytes, streamed reading must stop at max_entry_bytes."""
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "spoofed.zip"
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("bomb.txt", "Z" * 500)

            orig_infolist = zipfile.ZipFile.infolist
            orig_open = zipfile.ZipFile.open

            def spoofed_infolist(self_zf: zipfile.ZipFile):  # type: ignore
                infos = orig_infolist(self_zf)
                for inf in infos:
                    inf.file_size = 10  # Spoof tiny metadata size during pre-check
                return infos

            def real_stream_open(self_zf: zipfile.ZipFile, name_or_info, mode: str = "r", pwd=None, *, force_zip64: bool = False):  # type: ignore
                if isinstance(name_or_info, zipfile.ZipInfo):
                    name_or_info.file_size = 500  # Actual decompressed stream is 500 bytes
                return orig_open(self_zf, name_or_info, mode=mode, pwd=pwd, force_zip64=force_zip64)

            zipfile.ZipFile.infolist = spoofed_infolist  # type: ignore
            zipfile.ZipFile.open = real_stream_open  # type: ignore
            try:
                budget = mod.ExtractionBudget(max_entry_bytes=100, max_total_bytes=1000)
                res = mod.extract_document(zpath, budget=budget)
            finally:
                zipfile.ZipFile.infolist = orig_infolist  # type: ignore
                zipfile.ZipFile.open = orig_open  # type: ignore

            self.assertFalse(res["ok"])
            self.assertEqual(res["errorType"], "budget_exceeded")
            self.assertTrue(res["truncated"])
            self.assertEqual(res["limitExceeded"], "zip_entry_size_limit_exceeded")
            self.assertEqual(budget.total_bytes_read, 101)
            self.assertNotIn("ZZZZZZZZZZ", res["text"])

    def test_corrupt_pdf_and_parser_unavailable_classification(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bad_pdf = Path(tmp) / "corrupt.pdf"
            bad_pdf.write_bytes(b"NOT_A_VALID_PDF_BINARY_HEADER_\x80\xff\x00")
            res = mod.extract_document(bad_pdf, budget=mod.ExtractionBudget())
            self.assertFalse(res["ok"])
            self.assertIn(res["errorType"], ("corrupt_or_invalid_document", "parser_unavailable"))

    def test_pdf_never_silently_omits_blank_pages_and_respects_page_budget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "blank_middle.pdf"
            pdf_path.write_bytes(_make_multipage_pdf(["PAGE_ONE_OK", "", "PAGE_THREE_OK"]))
            res = mod.extract_document(pdf_path, budget=mod.ExtractionBudget())
            self.assertTrue(res["ok"])
            self.assertEqual(res["pageCount"], 3)
            self.assertIn("--- Page 1 ---", res["text"])
            self.assertIn("--- Page 2 ---", res["text"])
            self.assertIn("[PAGE 2: NO EXTRACTABLE TEXT", res["text"])
            self.assertIn("--- Page 3 ---", res["text"])
            self.assertTrue(res["truncated"])
            self.assertEqual(res["limitExceeded"], "pdf_missing_page_text")

            low_page_res = mod.extract_document(pdf_path, budget=mod.ExtractionBudget(max_pages=2))
            self.assertTrue(low_page_res["ok"])
            self.assertTrue(low_page_res["truncated"])
            self.assertEqual(low_page_res["limitExceeded"], "pdf_page_limit_exceeded")
            self.assertNotIn("PAGE_THREE_OK", low_page_res["text"])

    def test_xlsx_evaluates_uncached_formulas_and_marks_row_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            xlsx_path = Path(tmp) / "uncached_formula.xlsx"
            xlsx_path.write_bytes(_make_minimal_xlsx_uncached_formula())
            res = mod.extract_document(xlsx_path, budget=mod.ExtractionBudget())
            self.assertTrue(res["ok"])
            self.assertFalse(res["truncated"])
            self.assertIn("Total | 2000", res["text"])

            low_row_res = mod.extract_document(xlsx_path, budget=mod.ExtractionBudget(max_rows=2))
            self.assertTrue(low_row_res["ok"])
            self.assertTrue(low_row_res["truncated"])
            self.assertEqual(low_row_res["limitExceeded"], "xlsx_row_limit_exceeded")

    def test_docx_extracts_paragraphs_and_tables_via_openxml(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            docx_path = Path(tmp) / "sample.docx"
            docx_path.write_bytes(
                _make_minimal_docx(
                    ["Policy Clause 4.2", "Approved SLA: 99.95%"],
                    [["Metric", "Target"], ["Penalty", "15%"]],
                )
            )
            res = mod.extract_document(docx_path, budget=mod.ExtractionBudget())
            self.assertTrue(res["ok"])
            self.assertEqual(res["type"], "docx")
            self.assertIn("Policy Clause 4.2", res["text"])
            self.assertIn("Penalty | 15%", res["text"])

    def test_unsupported_and_encrypted_classification_and_mixed_archive_partial_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            doc_path = Path(tmp) / "legacy.doc"
            doc_path.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1LEGACY_WORD_BINARY")
            doc_res = mod.extract_document(doc_path, budget=mod.ExtractionBudget())
            self.assertFalse(doc_res["ok"])
            self.assertEqual(doc_res["errorType"], "unsupported_format")

            enc_pdf = Path(tmp) / "secret.pdf"
            enc_pdf.write_bytes(
                b"%PDF-1.4\n1 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 >>\nendobj\n"
                b"trailer\n<< /Root 1 0 R /Encrypt 1 0 R >>\n%%EOF\n"
            )
            enc_pdf_res = mod.extract_document(enc_pdf, budget=mod.ExtractionBudget())
            self.assertFalse(enc_pdf_res["ok"])
            self.assertEqual(enc_pdf_res["errorType"], "encrypted_document")

            raw_zip = io.BytesIO()
            with zipfile.ZipFile(raw_zip, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("secret.txt", "TOP_SECRET")
            enc_zip = Path(tmp) / "encrypted.zip"
            enc_zip.write_bytes(_mark_zip_entries_encrypted(raw_zip.getvalue()))
            enc_zip_res = mod.extract_document(enc_zip, budget=mod.ExtractionBudget())
            self.assertFalse(enc_zip_res["ok"])
            self.assertEqual(enc_zip_res["errorType"], "encrypted_document")

            mixed_zip = Path(tmp) / "mixed.zip"
            with zipfile.ZipFile(mixed_zip, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("valid.txt", "VALID_MEMBER_OK")
                zf.writestr("broken.pdf", b"CORRUPT_PDF_MEMBER")
            mixed_res = mod.extract_document(mixed_zip, budget=mod.ExtractionBudget())
            self.assertTrue(mixed_res["ok"])
            self.assertTrue(mixed_res["truncated"])
            self.assertEqual(mixed_res["limitExceeded"], "corrupt_or_invalid_document")
            self.assertEqual(mixed_res["entries"], ["valid.txt"])
            self.assertEqual(len(mixed_res["failedEntries"]), 1)
            self.assertEqual(mixed_res["failedEntries"][0]["entry"], "broken.pdf")

    def test_output_char_budget_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            txt_path = Path(tmp) / "long.txt"
            txt_path.write_text("LONG_CONTENT_" * 40, encoding="utf-8")
            res = mod.extract_document(txt_path, budget=mod.ExtractionBudget(max_output_chars=80))
            self.assertTrue(res["ok"])
            self.assertTrue(res["truncated"])
            self.assertEqual(res["limitExceeded"], "output_char_limit_exceeded")
            self.assertIn("PARTIAL EXTRACTION", res["text"])


if __name__ == "__main__":
    unittest.main()
