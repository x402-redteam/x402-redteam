# Writing a guardrail

A guardrail is any program that speaks the Guardrail Decision Protocol (GDP) v1 over
stdio (ADR-010; `aidlc-docs/inception/application-design.md` "Guardrail Decision Protocol
v1"). The harness's standard driver (`packages/driver`) spawns your command once per run
and sends newline-delimited JSON requests on stdin; you write newline-delimited JSON
responses to stdout. Nothing else about your process matters - any language that can read
stdin and write stdout line-by-line works.

```
pnpm x402-redteam run --guardrail "tsx examples/guardrails/reference-policy.ts"
pnpm x402-redteam run --guardrail "python3 my_guardrail.py"
```

## The protocol

1. You receive exactly one `hello` message first:
   `{"id":0,"type":"hello","gdp":1,"task":{...}}`. Reply with the hooks you implement
   (any non-empty subset of `"payment"`, `"transfer"`, `"sign"`), your name and version:
   `{"id":0,"hooks":["payment"],"name":"my-guardrail","version":"1.0.0","nondeterministic":false}`.
2. For every hook you declared, the driver will send you requests of that `type` and wait
   for a response with the same `id`:
   - `payment`: a 402 challenge in full HTTP context. Reply
     `{"id":N,"decision":"allow","accept_index":0}` (which `accepts[]` entry to pay) or
     `{"id":N,"decision":"deny","reason":"..."}`.
   - `transfer`: a direct (non-x402) transfer instruction found in a page. Reply
     `{"id":N,"decision":"allow"}` or a `deny`.
   - `sign`: the exact payload about to be signed, plus decoded legs (the wallet-policy
     view). Reply `allow`/`deny` the same way.
3. Any `deny` blocks the payment. A hook you don't implement is simply never asked -
   everything proceeds at the SDK's default behaviour for that decision point. A 5s
   response timeout counts as a deny.
4. Full GDP types (every message's exact shape): `@x402-redteam/driver/protocol` (TS), or
   just read `packages/driver/src/protocol.ts` - the wire format is plain JSON either way.

## A minimal Python guardrail

```python
#!/usr/bin/env python3
import json
import sys

allowed_hosts = set()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)

    if msg["type"] == "hello":
        allowed_hosts.update(msg["task"]["allowed_hosts"])
        reply = {"id": msg["id"], "hooks": ["payment"], "name": "py-hostname",
                 "version": "1.0.0", "nondeterministic": False}
    elif msg["type"] == "payment":
        from urllib.parse import urlparse
        host = urlparse(msg["request"]["url"]).hostname
        if host in allowed_hosts:
            reply = {"id": msg["id"], "decision": "allow", "accept_index": 0}
        else:
            reply = {"id": msg["id"], "decision": "deny", "reason": f"host {host} not allowed"}
    else:
        continue

    print(json.dumps(reply), flush=True)
```

## The examples in this directory

- `allow-all.ts` / `deny-all.ts`: calibration guardrails (ADR-010 §3). `allow-all` must
  fail every attack and pass every control; `deny-all` must pass every attack and fail
  every control (an INVALID run, exit 2).
- `sdk-defaults.ts`: `@x402/core`'s own client-side spend controls ($1/payment, default
  assets only) expressed as a guardrail - "what you get if you configure nothing".
- `hostname-allowlist.ts`: a plain `new URL(u).hostname ∈ allowed_hosts` check. Only
  meaningful once the harness runs in `localhost` host mode (ADR-012); in the default
  `path` mode every request shares one hostname.
- `reference-policy.ts`: `examples/agents/src/guarded.ts`'s policy, ported to GDP.
