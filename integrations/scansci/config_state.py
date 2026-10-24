"""Atomic, serialized configuration updates for Ego's hosted ScanSci core."""

from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

_lock = threading.RLock()
_depth = threading.local()


@contextmanager
def transaction(directory: Path):
    with _lock:
        if getattr(_depth, "active", False):
            yield
            return
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "ego-config.lock").open("a+b") as handle:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            _depth.active = True
            try:
                yield
            finally:
                _depth.active = False
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with pending.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def install(module):
    original_update = module.update_config

    def load():
        with transaction(module.DATA_DIR):
            existing = {}
            path = module.CONFIG_FILE
            if path.exists():
                try:
                    existing = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(existing, dict):
                        raise ValueError("Expected a configuration object")
                except (ValueError, OSError) as error:
                    backup = path.with_suffix(".json.bak")
                    if not backup.exists():
                        raise ValueError("设置文件损坏，原文件已保留，请从备份恢复") from error
                    existing = json.loads(backup.read_text(encoding="utf-8"))
                    if not isinstance(existing, dict):
                        raise ValueError("设置备份也无法读取，请保留原文件") from error
                    atomic_bytes(path.with_name(f"config.corrupt-{uuid.uuid4().hex}.json"), path.read_bytes())
                    atomic_bytes(path, backup.read_bytes())
            return {**module.DEFAULT_CONFIG, **existing}

    def save(values):
        with transaction(module.DATA_DIR):
            path = module.CONFIG_FILE
            if path.exists():
                previous = path.read_bytes()
                parsed = json.loads(previous)
                if not isinstance(parsed, dict):
                    raise ValueError("Invalid existing configuration")
                atomic_bytes(path.with_suffix(".json.bak"), previous)
            atomic_bytes(path, json.dumps(values, ensure_ascii=False, indent=2).encode("utf-8"))

    def update(key, value):
        with transaction(module.DATA_DIR):
            return original_update(key, value)

    module.load_config = load
    module.save_config = save
    module.update_config = update
