import base64
import mimetypes
import time
from typing import Any, Dict, Optional

import requests
from requests import RequestException


class RemoteError(RuntimeError):
    pass


def _request_with_retry(method: str, url: str, retries: int = 3, **kwargs):
    last_err = None
    for attempt in range(retries):
        try:
            return requests.request(method, url, **kwargs)
        except RequestException as e:
            last_err = e
            if attempt == retries - 1:
                break
            # First retry is fast (0.3s), subsequent retries use longer backoff.
            time.sleep(0.3 if attempt == 0 else 0.8 * attempt)
    raise RemoteError(f"network error: {last_err}")


def _auth_header(key: str) -> str:
    k = (key or "").strip()
    if not k:
        raise RemoteError("FAL key is not configured")
    if k.lower().startswith("key ") or k.lower().startswith("bearer "):
        return k
    return f"Key {k}"


def _data_uri_from_bytes(data: bytes, filename: str) -> str:
    mt, _ = mimetypes.guess_type(filename or "")
    if not mt:
        mt = "audio/wav"
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mt};base64,{b64}"


def fal_whisper_transcribe(
    *,
    fal_key: str,
    audio_bytes: bytes,
    filename: str,
    task: str = "transcribe",
    language: Optional[str] = None,
    diarize: bool = True,
    num_speakers: Optional[int] = None,
    chunk_level: str = "segment",
    timeout_sec: int = 300,
) -> Dict[str, Any]:
    """Run fal-ai/whisper via queue API.

    Uses a base64 data URI as `audio_url` (suitable for local desktop apps).
    """

    url = "https://queue.fal.run/fal-ai/whisper"
    headers = {
        "Authorization": _auth_header(fal_key),
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "audio_url": _data_uri_from_bytes(audio_bytes, filename),
        "task": task,
        "chunk_level": chunk_level,
        "diarize": bool(diarize),
    }
    if language:
        payload["language"] = language
    else:
        payload["language"] = None
    if num_speakers is not None:
        payload["num_speakers"] = int(num_speakers)

    r = _request_with_retry("POST", url, headers=headers, json=payload, timeout=60)
    if r.status_code >= 400:
        raise RemoteError(f"fal submit failed: HTTP {r.status_code} {r.text[:400]}")
    js = r.json()
    request_id = js.get("request_id")
    if not request_id:
        raise RemoteError("fal submit failed: no request_id")

    status_url = (
        f"https://queue.fal.run/fal-ai/whisper/requests/{request_id}/status?logs=0"
    )
    result_url = f"https://queue.fal.run/fal-ai/whisper/requests/{request_id}"

    deadline = time.time() + float(timeout_sec)
    while True:
        if time.time() > deadline:
            raise RemoteError("fal timeout waiting for result")
        s = _request_with_retry(
            "GET",
            status_url,
            headers={"Authorization": headers["Authorization"]},
            timeout=30,
        )
        if s.status_code >= 400:
            raise RemoteError(f"fal status failed: HTTP {s.status_code} {s.text[:400]}")
        st = s.json()
        status = st.get("status")
        if status == "COMPLETED":
            break
        time.sleep(0.4 if status == "IN_PROGRESS" else 1.0)

    out = _request_with_retry(
        "GET", result_url, headers={"Authorization": headers["Authorization"]}, timeout=60
    )
    if out.status_code >= 400:
        raise RemoteError(f"fal result failed: HTTP {out.status_code} {out.text[:400]}")
    return out.json()
