#!/usr/bin/env python3
"""Persistent faster-whisper worker.

The model is loaded once. Node frames each request as:
  uint32 id | uint32 wav_length | wav bytes
and receives one JSON line per request. This keeps a real conversation from
paying a multi-second model load on every utterance.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import tempfile
import time
import traceback

# HuggingFace's HTTP client can choke on a socks:// ALL_PROXY value that some
# desktop environments export. Respect HTTP(S)_PROXY but do not let the
# unrelated socks variable break the download.
os.environ.pop("ALL_PROXY", None)
os.environ.pop("all_proxy", None)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel

        started = time.time()
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            cpu_threads=max(1, args.threads),
        )
        emit({"ready": True, "model": args.model, "loadMs": int((time.time() - started) * 1000)})
    except Exception as exc:
        emit({"ready": False, "error": f"{exc}"})
        traceback.print_exc(file=sys.stderr)
        return 1

    while True:
        header = sys.stdin.buffer.read(8)
        if not header or len(header) < 8:
            break
        request_id, length = struct.unpack(">II", header)
        if length == 0 or length > 40_000_000:
            emit({"id": request_id, "error": "invalid audio frame"})
            continue
        data = sys.stdin.buffer.read(length)
        if len(data) != length:
            emit({"id": request_id, "error": "truncated audio frame"})
            break

        path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                handle.write(data)
                path = handle.name
            started = time.time()
            segments, info = model.transcribe(
                path,
                language=args.language,
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
                without_timestamps=True,
                initial_prompt="以下是普通话对话，可能包含 Jarvis、屏幕、提醒、记忆、项目等词。",
            )
            text = "".join(segment.text for segment in segments).strip()
            emit(
                {
                    "id": request_id,
                    "text": text,
                    "language": getattr(info, "language", args.language),
                    "durationMs": int((time.time() - started) * 1000),
                }
            )
        except Exception as exc:
            emit({"id": request_id, "error": str(exc)})
            traceback.print_exc(file=sys.stderr)
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())