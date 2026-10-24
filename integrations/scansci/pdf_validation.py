"""Require a readable document, not merely a PDF-looking response."""

from pathlib import Path

import fitz


def is_readable_pdf(path: Path) -> bool:
    try:
        with Path(path).open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                return False
        with fitz.open(path) as document:
            if document.needs_pass or document.page_count < 1:
                return False
            document.load_page(0).get_text()
        return True
    except (OSError, ValueError, RuntimeError):
        return False
