"""Bounded breadth-first crawl for the Python reference agent, mirroring
`examples/agents/src/lib/crawl.ts`.

Redirects are followed by hand, and only to an origin the task declared. Links found in a
fetched page's body are followed the same way, up to depth 3, with at most 30 HTTP requests
in total (redirect hops included). Standard library only: the HTTP call is passed in, so
`examples/agents/test/python-crawl.test.ts` can run it with the system `python3`.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from url_utils import extract_urls, origin_of

DEFAULT_MAX_DEPTH = 3
DEFAULT_MAX_FETCHES = 30
MAX_REDIRECT_HOPS = 10

Get = Callable[[str], Awaitable[Any]]


@dataclass
class Page:
    url: str
    status: int
    body: str


async def _fetch_one(get: Get, start_url: str, origins: set[str], budget: list[int]) -> Page | None:
    url = start_url
    for _ in range(MAX_REDIRECT_HOPS):
        if budget[0] <= 0:
            return None
        budget[0] -= 1
        try:
            resp = await get(url)
        except Exception:  # noqa: BLE001 - an unreachable page is skipped, like crawl.ts
            return None
        if 300 <= resp.status_code < 400:
            location = resp.headers.get("location")
            if not location:
                return None
            nxt = urljoin(url, location)
            if origin_of(nxt) not in origins:
                return None
            url = nxt
            continue
        try:
            body = resp.text or ""
        except Exception:  # noqa: BLE001 - an undecodable body reads as empty, like crawl.ts
            body = ""
        return Page(url=url, status=resp.status_code, body=body)
    return None


async def crawl(
    get: Get,
    seeds: Iterable[str],
    origins: set[str],
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_fetches: int = DEFAULT_MAX_FETCHES,
) -> list[Page]:
    budget = [max_fetches]
    queue: deque[tuple[str, int]] = deque((seed, 0) for seed in seeds)
    seen_links: set[str] = set()
    pages: list[Page] = []
    while queue and budget[0] > 0:
        url, depth = queue.popleft()
        page = await _fetch_one(get, url, origins, budget)
        if page is None:
            continue
        pages.append(page)
        if depth >= max_depth:
            continue
        for nxt in extract_urls(page.body, origins):
            if nxt in seen_links:
                continue
            seen_links.add(nxt)
            queue.append((nxt, depth + 1))
    return pages
