# python-x402 reference payer

A scripted Python payer (not an autonomous agent) on the real [`x402` PyPI package](https://pypi.org/project/x402/) (verified
2.25.0), run in a **project-local** virtual environment - never a global install, never the
system Python's site-packages. Its job is to prove header capture works against an
implementation this harness was not written alongside, and to give a "third-party SDK
defaults" baseline (application-design.md §8 "v2", ADR-008 amendment (a)).

**Scope: EVM only in Bolt 5** (`--chains evm`). Solana is added only once an RPC override is
confirmed on that SDK's client; running this agent on `svm` today would silently dial the
public Solana devnet, which the harness's "no real funds, no network" rule forbids.

## Setup

```bash
cd examples/agents-py
uv venv --python 3.12 .venv
uv sync
```

This creates `.venv/` (gitignored) using the already-installed `uv` and CPython 3.12, and
installs exactly `x402[evm,httpx]==2.25.0`, `jsonschema==4.26.0` and their dependencies from
`uv.lock`. No global install, no system Python involved.

**Why jsonschema (U26-3).** Without it, `x402` 2.25.0 rejects any challenge that declares
`PaymentRequired.extensions` with "Extensions validation requires jsonschema. Install with: pip
install x402[extensions]", so it cannot pay a gas-sponsored Permit2 challenge at all (corpus
v4's `control-permit2-gas-sponsored`). A user who pays servers that declare extensions must
install jsonschema, for example through the `x402[extensions]` extra. This payer pins jsonschema
directly instead of the extra, because the extra also installs `signinwithethereum`, which holds
`web3` at 7.x.

## Run

Directly:

```bash
examples/agents-py/.venv/bin/python examples/agents-py/agent.py
```

Through the harness, from the repo root:

```bash
pnpm x402-redteam run \
  --agent "examples/agents-py/.venv/bin/python examples/agents-py/agent.py" \
  --chains evm
```

The agent reads `task.json` from `X402_REDTEAM_TASK` (set by the harness), fetches every
`base_url`-prefixed URL named directly in the task prompt exactly once (it does not crawl
links discovered inside a fetched page - a real capability gap against scenarios where the
paid resource is only reachable via such a link, e.g. `control-partner-host`,
`control-same-host-redirect`), and pays through the SDK's own default `httpx` payment
transport with the SDK's own default spend controls (currently at most $1 per payment) - no
custom policy. It exits 0 if every fetch it attempted succeeded, 1 otherwise (per-URL
failures - including the SDK correctly refusing an oversized payment, as on
`unit-confusion` - are logged to stderr and do not stop the other URLs from being tried).

## What's verified vs. not

Verified in the installed 2.25.0 source (not just the package README):

- `x402.client.x402Client`, `x402.mechanisms.evm.exact.ExactEvmScheme(signer=...)` (an
  `eth_account` `LocalAccount` is auto-wrapped), `x402.http.clients.httpx.wrapHttpxWithPayment`.
- `client.register("eip155:*", ...)` - `x402.schemas.helpers.find_schemes_by_network` supports
  wildcard network patterns, same as `@x402/core`'s TypeScript client.
- The wire header names match v2 exactly: `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
  `PAYMENT-RESPONSE` (`x402.http.constants`).
- No chain RPC is ever contacted by the client for the EIP-3009 (`exact`) scheme this
  harness's challenges use - `get_evm_chain_id` parses the chain id out of the `eip155:...`
  network string itself, so there is nothing here to point at a mock RPC even if this agent
  wanted to.
- The SDK's own default spend control matches `@x402/core`'s: at most $1 per payment
  (`x402.client_base.DEFAULT_MAX_AMOUNT_PER_PAYMENT`).
- A 402 with neither a PAYMENT-REQUIRED header nor a v1 body raises
  `ValueError("Invalid payment required response")`
  (`x402.http.x402_http_client_base.get_payment_required_response`), wrapped in a
  `PaymentError`. The agent treats that as an unpayable page and skips it, as the TypeScript
  payers do, instead of reporting an error.
