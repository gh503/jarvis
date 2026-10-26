#!/usr/bin/env python3
"""Persistent RapidOCR worker.

Screen understanding is mostly text understanding. Running OCR locally is far
faster and more faithful than asking a 3B vision model to read a screenshot.
Node frames a request as:
  uint32 id | uint32 path_length | utf-8 image path
and receives one JSON line with the recognized lines.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import time
import traceback

os.environ.pop("ALL_PROXY", None)
os.environ.pop("all_proxy", None)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        from rapidocr_onnxruntime import RapidOCR

        started = time.time()
        ocr = RapidOCR()
        emit({"ready": True, "loadMs": int((time.time() - started) * 1000)})
    except Exception as exc:
        emit({"ready": False, "error": str(exc)})
        traceback.print_exc(file=sys.stderr)
        return 1

    while True:
        header = sys.stdin.buffer.read(8)
        if not header or len(header) < 8:
            break
        request_id, length = struct.unpack(">II", header)
        if length == 0 or length > 1_000_000:
            emit({"id": request_id, "error": "invalid path frame"})
            continue
        raw = sys.stdin.buffer.read(length)
        path = raw.decode("utf-8", "replace")
        try:
            started = time.time()
            result, _elapse = ocr(path)
            lines = []
            for item in result or []:
                if len(item) >= 3 and float(item[2]) >= 0.35:
                    text = str(item[1]).strip()
                    if text:
                        lines.append(text)
            emit(
                {
                    "id": request_id,
                    "text": "\n".join(lines),
                    "lines": lines,
                    "durationMs": int((time.time() - started) * 1000),
                }
            )
        except Exception as exc:
            emit({"id": request_id, "error": str(exc)})
            traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())