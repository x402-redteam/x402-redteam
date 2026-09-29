# U1 — Workspace + packages/schema · Functional Design

Author: Opus · Implementer: Sonnet · Bolt 1 · Source of truth: `aidlc-docs/inception/application-design.md` §2–4

## 1. Workspace scaffold (repo root)
- `package.json` (private, `"packageManager": "pnpm@10.x"`, or whichever pnpm is installed; check `pnpm -v`), `engines.node >=20`, and these scripts: `build` (`pnpm -r build`), `test` (`vitest run`), `lint` (`biome check .`), `format` (`biome format --write .`), `typecheck` (`pnpm -r typecheck`).
- `pnpm-workspace.yaml` covering `packages/*` and `examples/*`.
- `tsconfig.base.json`: strict, `module`/`moduleResolution` set to `NodeNext`, target ES2022, `declaration`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- `biome.json`: recommended rules, 2-space indent, line width 100.
- `vitest.workspace.ts`, or a root `vitest.config.ts` with `projects: ["packages/*"]`.
- `.github/workflows/ci.yml`: on push and PR, run pnpm install, lint, typecheck and test on Node 20.
- `README.md` stub with a one-paragraph description and "status: pre-alpha".
- Exact dev pins: `typescript@6.0.3`, `vitest@5.0.2`, `@biomejs/biome@2.5.14`, `tsx` (latest).

Packages are ESM (`"type": "module"`). During development they are consumed from source via `exports` → `./src/index.ts` so the workspace needs no build step for tests. They are built to `dist/` with `tsc -p tsconfig.build.json` for publishing, with `publishConfig.exports` pointing at dist.

## 2. packages/schema (`@x402-redteam/schema`)
Runtime deps: `zod@4.6.5`, `yaml@2.9.1`, `viem@2.57.1`, `@solana/kit@8.4.0` (for key and address derivation), `@x402/core@2.28.0` (types only: `PaymentRequirements`, `PaymentPayload`).

### Files
```
src/index.ts          re-exports
src/scenario.ts       zod: Chain, Severity, Category, Scenario, Route, ChallengeSpec, Expected (§3 exactly; apply defaults in zod)
src/ledger.ts         zod + types: IssuedChallenge, Payment, RequestLog, RunRecord (§4 exactly)
src/chains.ts         CHAIN_DEFAULTS {evm, svm}: network, asset, decimals, extra; usdToAtomic(usd, decimals): string (exact, no float drift: use string math or BigInt on micro-units); atomicToUsd(atomic, decimals): number
src/template.ts       render(template, ctx) — supports {{base_url}}, {{host:NAME}}, {{canary.NAME}}, {{chain}}, {{network}}, {{usdc}}; throws TemplateError on unknown var; collectVars(template) → string[]
src/canary.ts         canaries(seed, scope, chain) → { get(name): {address, secret} } deterministic per §3; agentWallet(seed, chain)
src/load.ts           loadScenario(file) / loadCorpus(dir) → Scenario[]; parse YAML, zod-validate, check id == basename, then run the lint rules below; errors are CorpusError{file, path, message}
src/capture-api.ts    TYPES ONLY, the contract shared by U2 and U3 (below)
test/*.test.ts
```

### Corpus lint rules (in `load.ts`, used by `validate`)
1. `id` is unique and matches the filename.
2. Every template variable resolves (render with a dummy ctx).
3. **Canary channel separation (ADR-004):** no `{{canary.X}}` may appear both in a `challenge.pay_to` (or a `redirect` chain that leads to one) and in any `page` text.
4. When `expected.allow` is true, `expected.max_usd` is required.
5. Every `route.redirect` target resolves to a declared route (host + path).

### capture-api.ts (types only; U3 implements it and U2 consumes it)
```ts
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
export interface DecodedPayment {
  chain: Chain; network: string; scheme: string; asset: string;
  from: string; to: string; amount_atomic: string;
  dedupe_key: string; valid: boolean; invalid_reason?: string; raw: unknown;
}
export type ShimEvent =
  | { kind: "evm_typed_data"; payload: { domain: unknown; types: unknown; primaryType: string; message: unknown; signature: string; address: string } }
  | { kind: "evm_tx"; payload: { serialized: string } }
  | { kind: "svm_tx"; payload: { transaction_base64: string } };
export interface CaptureApi {
  decodePayload(payload: PaymentPayload): Promise<DecodedPayment>;   // header path (v1 or v2 payload)
  decodeShimEvent(evt: ShimEvent): Promise<DecodedPayment>;
  attribute(p: DecodedPayment, ctx: AttributionContext): Pick<Payment, "instruction_source" | "challenge_id" | "replay">;
  merge(existing: Payment[], incoming: Payment): Payment[];           // dedupe_key merge -> capture "header+shim"
}
export interface AttributionContext { challenges: IssuedChallenge[]; pageBodies: string[]; prior: Payment[] }
```
Check that `@x402/core/types` really exports these names in 2.28.0. If it doesn't, find the right subpath and note it as a deviation.

## 3. Acceptance tests (vitest)
- A valid minimal scenario parses and its defaults are applied (method GET, behaviour normal, chains both, max_payments).
- Each lint rule has one failing fixture, and the error message names the file and the yaml path.
- `usdToAtomic(0.001, 6) === "1000"`, `usdToAtomic(1, 6) === "1000000"`, `usdToAtomic(0.1+0.2, 6) === "300000"`; the round trip holds.
- `render` handles all variables; an unknown variable throws.
- Canary snapshot: `canaries("x402-redteam-v1","ghost-paywall","evm").get("attacker").address` gives the same value on every run, the EVM address is checksummed, the SVM address is valid base58 with 32 bytes; different names give different addresses.
- The `ledger.ts` zod schemas accept a hand-written RunRecord fixture.

## 4. Do not
- Do not implement decoders, the server or scoring (those are U2–U4).
- Do not add dependencies beyond this list without writing down the reason in your report.
- Do not commit. Opus reviews and commits.
