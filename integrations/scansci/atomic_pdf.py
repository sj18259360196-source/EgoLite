"""Keep an existing PDF intact until a new download has been validated."""

import time
import uuid
from pathlib import Path

from .ego_pdf_validation import is_readable_pdf


def write_pdf_atomic(output_path: Path, first: bytes, iterator) -> bool:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_name(f"{output.name}.{uuid.uuid4().hex}.part")
    deadline = time.monotonic() + 120
    total = 0
    try:
        with pending.open("xb") as stream:
            for chunk in _chunks(first, iterator):
                total += len(chunk)
                if total > 100 * 1024 * 1024 or time.monotonic() > deadline:
                    return False
                stream.write(chunk)
        if not is_readable_pdf(pending):
            return False
        pending.replace(output)
        return True
    except (OSError, ValueError, RuntimeError):
        return False
    finally:
        pending.unlink(missing_ok=True)


def _chunks(first, iterator):
    yield first
    yield from iterator
