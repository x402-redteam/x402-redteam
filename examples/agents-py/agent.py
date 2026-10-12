"""The Python x402 reference agent, per U12 functional-design.md §4.

A third-party-SDK, cross-language baseline: it exercises header capture with an
implementation the harness was not written alongside, on the real `x402` PyPI package
(https://pypi.org/project/x402/, verified 2.25.0). EVM only in Bolt 5 (`--chains evm`) -
Solana is added only if an RPC override is confirmed on that SDK's client (unconfirmed at
write time; running it on `svm` would otherwise silently dial the public Solana devnet,
which the harness's "no real funds, no network" rule forbids).

Starts from every `task.json` `prompt` URL whose origin is declared by the task (`base_url`,
or any `host_mode: "localhost"` virtual host in `task["hosts"]` - see `url_utils.py`) and
crawls from there like the TypeScript agents (`crawl.py`: redirects and page links within
those origins, depth 3, at most 30 requests), through the SDK's own default httpx payment
transport - the SDK's own default spend
controls apply (currently at most $1 per payment; see
`x402.client_base.DEFAULT_MAX_AMOUNT_PER_PAYMENT`), same as this repo's TypeScript agents'
"SDK default" baseline. No custom policy: this agent's purpose is to prove header capture
works cross-language, not to model a guardrail. `host_mode: "proxy"` is not supported (see
`run()`).

Invocation (per the design; there is no wrapper script for this agent):
    examples/agents-py/.venv/bin/python examples/agents-py/agent.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback

from eth_account import Account
from x402 import x402Client
from x402.http.clients.httpx import wrapHttpxWithPayment
from x402.mechanisms.evm.exact import ExactEvmScheme

from crawl import crawl
from url_utils import allowed_origins, extract_urls

REQUEST_TIMEOUT_SECONDS = 30.0


def is_unpayable_402(exc: BaseException) -> bool:
    """True when the SDK refused a 402 because it carries no x402 challenge at all.

    x402 2.25.0 raises `PaymentError("Failed to handle payment: ...")` from the
    `ValueError("Invalid payment required response")` that
    `x402.http.x402_http_client_base.get_payment_required_response` raises when a 402 has
    neither a PAYMENT-REQUIRED header nor a v1 body (verified in the installed source).
    """
    cause = exc.__cause__
    return isinstance(cause, ValueError) and str(cause) == "Invalid payment required response"


def read_task() -> dict:
    """Reads and parses `task.json` from `X402_REDTEAM_TASK` (application-design.md §6)."""
    path = os.environ.get("X402_REDTEAM_TASK")
    if not path:
        raise RuntimeError("X402_REDTEAM_TASK is not set")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


async def run(task: dict) -> int:
    if task["chain"] != "evm":
        print(
            f'python-x402: unsupported chain "{task["chain"]}" - this agent is EVM-only '
            "in Bolt 5 (run the harness with --chains evm).",
            file=sys.stderr,
        )
        return 1

    # U17 code review F2: this agent only ever follows task["base_url"]/task["hosts"]
    # origin URLs (see url_utils.extract_urls) - under proxy mode every URL is a bare
    # origin it can't reach, so it would silently fetch nothing and look like a pass.
    # Fail loudly instead of a silent pass.
    if task.get("host_mode") == "proxy":
        print(
            "python-x402: proxy mode is not supported by this agent - it only follows "
            'task["base_url"]/task["hosts"]-origin URLs, never a bare proxy-mode origin '
            "(see README's Host modes section). Run it with --host-mode localhost or path.",
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

    origins = allowed_origins(task)
    urls = extract_urls(task["prompt"], origins)
    if not urls:
        print("python-x402: no base_url-prefixed URLs found in the prompt", file=sys.stderr)

    ok = True
    # httpx does not follow redirects by default; crawl() follows them itself, only
    # within the declared origins.
    async with wrapHttpxWithPayment(client, timeout=REQUEST_TIMEOUT_SECONDS) as http:

        async def get(url: str):
            nonlocal ok
            try:
                resp = await http.get(url)
            except Exception as exc:  # noqa: BLE001 - report and keep going, like naive/guarded
                if is_unpayable_402(exc):
                    # A 402 that carries no x402 challenge (no PAYMENT-REQUIRED header, no v1
                    # body), such as a page asking for a signature: nothing to pay, so the
                    # page is skipped like the TypeScript payers skip it, not an error.
                    print(f"python-x402: GET {url} -> 402 with no x402 challenge, skipped")
                    raise
                ok = False
                print(f"python-x402: GET {url} failed: {exc}", file=sys.stderr)
                raise
            print(f"python-x402: GET {url} -> {resp.status_code}")
            return resp

        await crawl(get, urls, origins)

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
