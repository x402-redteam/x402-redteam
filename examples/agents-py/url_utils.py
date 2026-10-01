"""Pure-stdlib URL-extraction helpers for the Python reference agent (`agent.py`).

Factored into its own module, with zero third-party imports, specifically so it can be
unit-tested with the system `python3` alone - no `uv sync`/venv required (see
`examples/agents/test/python-url-utils.test.ts`). Mirrors
`examples/agents/src/lib/crawl.ts`'s origin-allowlist based `extractUrls`/`allowedOrigins`
(U17 code review F1): a URL is only ever followed when its *origin* (scheme + host +
port, exact match) is one this scenario actually declared, never a `*.localhost`
suffix/prefix regex against the raw string - which `http://a.localhost.evil.com/x` or
`http://x.localhost-evil.com/y` would both satisfy as a substring while being a
completely different, real-DNS origin.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

URL_CANDIDATE_RE = re.compile(r"https?://[^\s\"'<>)\]]+")


def _origin(url: str) -> str | None:
    """`scheme://host[:port]`, lowercased, or `None` if `url` isn't a well-formed
    absolute http(s) URL - mirrors `new URL(url).origin` (lowercased; the WHATWG URL
    spec already lowercases the host, so this just normalizes the scheme too)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}".lower()


def allowed_origins(task: dict) -> set[str]:
    """`{origin(task["base_url"])} ∪ {origins of task["hosts"].values()}` - mirrors
    `examples/agents/src/lib/crawl.ts`'s `allowedOrigins`. `task["hosts"]` is absent on a
    v1/v2 task (path mode only, implicitly)."""
    origins: set[str] = set()
    base = _origin(task.get("base_url", ""))
    if base is not None:
        origins.add(base)
    for host_url in (task.get("hosts") or {}).values():
        origin = _origin(host_url)
        if origin is not None:
            origins.add(origin)
    return origins


def extract_urls(text: str, origins: set[str]) -> list[str]:
    """Every URL in `text` whose own origin is exactly one of `origins` (never a
    substring/suffix/prefix check), trailing punctuation trimmed, deduped in first-seen
    order."""
    found: list[str] = []
    seen: set[str] = set()
    for raw in URL_CANDIDATE_RE.findall(text):
        trimmed = raw.rstrip(".,;:!?")
        origin = _origin(trimmed)
        if origin is not None and origin in origins and trimmed not in seen:
            seen.add(trimmed)
            found.append(trimmed)
    return found
