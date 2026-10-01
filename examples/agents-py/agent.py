"""The Python x402 reference agent, per U12 functional-design.md §4.

A third-party-SDK, cross-language baseline: it exercises header capture with an
implementation the harness was not written alongside, on the real `x402` PyPI package
(https://pypi.org/project/x402/, verified 2.25.0). EVM only in Bolt 5 (`--chains evm`) -
Solana is added only if an RPC override is confirmed on that SDK's client (unconfirmed at
write time; running it on `svm` would otherwise silently dial the public Solana devnet,
which the harness's "no real funds, no network" rule forbids).

Fetches every `task.json` `prompt` URL that starts with `base_url`, once each, through the
SDK's own default httpx payment transport - the SDK's own default spend controls apply
(currently at most $1 per payment; see `x402.client_base.DEFAULT_MAX_AMOUNT_PER_PAYMENT`),
same as this repo's TypeScript agents' "SDK default" baseline. No custom policy: this
agent's purpose is to prove header capture works cross-language, not to model a guardrail.

Invocation (per the design; there is no wrapper script for this agent):
    examples/agents-py/.venv/bin/python examples/agents-py/agent.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import traceback

from eth_account import Account
from x402 import x402Client
from x402.http.clients.httpx import wrapHttpxWithPayment
from x402.mechanisms.evm.exact import ExactEvmScheme

REQUEST_TIMEOUT_SECONDS = 30.0


def read_task() -> dict:
    """Reads and parses `task.json` from `X402_REDTEAM_TASK` (application-design.md §6)."""
    path = os.environ.get("X402_REDTEAM_TASK")
    if not path:
        raise RuntimeError("X402_REDTEAM_TASK is not set")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def extract_urls(text: str, base_url: str) -> list[str]:
    """Every `base_url`-prefixed URL in `text`, trailing punctuation trimmed, deduped in
    first-seen order - mirrors `examples/agents/src/lib/crawl.ts`'s `extractUrls`, but
    this agent fetches each one exactly once (§4: "fetches only prompt URLs ... once
    each"), with no crawl of links discovered inside fetched pages."""
    pattern = re.compile(re.escape(base_url) + r'[^\s"\'<>)\]]*')
    found = [u.rstrip(".,;:!?") for u in pattern.findall(text)]
    return list(dict.fromkeys(found))


async def run(task: dict) -> int:
    if task["chain"] != "evm":
        print(
            f'python-x402: unsupported chain "{task["chain"]}" - this agent is EVM-only '
            "in Bolt 5 (run the harness with --chains evm).",
            file=sys.stderr,
        )
        return 1

    account = Account.from_key(task["wallet"]["private_key"])
    client = x402Client()
    # Registered against the "eip155:*" wildcard (x402.schemas.helpers.find_schemes_by_network
    # supports wildcard matching - verified in the installed 2.25.0 source), not just
    # task["network"], matching this repo's TS agents' registration pattern.
    client.register("eip155:*", ExactEvmScheme(signer=account))
    # No set_spend_controls() call: the SDK's own default ($1/payment) applies.

    urls = extract_urls(task["prompt"], task["base_url"])
    if not urls:
        print("python-x402: no base_url-prefixed URLs found in the prompt", file=sys.stderr)

    ok = True
    async with wrapHttpxWithPayment(client, timeout=REQUEST_TIMEOUT_SECONDS) as http:
        for url in urls:
            try:
                resp = await http.get(url)
                print(f"python-x402: GET {url} -> {resp.status_code}")
            except Exception as exc:  # noqa: BLE001 - report and keep going, like naive/guarded
                ok = False
                print(f"python-x402: GET {url} failed: {exc}", file=sys.stderr)

    return 0 if ok else 1


def main() -> None:
    try:
        task = read_task()
    except Exception:
        traceback.print_exc()
        sys.exit(1)

    try:
        sys.exit(asyncio.run(run(task)))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
