# Security policy

x402-redteam is a security tool whose output (reports, the leaderboard) people rely on. A
flaw that makes it under-report what an agent tried to pay, or lets someone forge a ranking,
is a vulnerability even if nothing crashes.

## Reporting

Use **GitHub private vulnerability reporting**:
[Report a vulnerability](https://github.com/x402-redteam/x402-redteam/security/advisories/new).
If you cannot use it, open a public issue that asks the maintainer to contact you, without any details of the problem.

**Do not open a public issue, discussion or PR** for a vulnerability, and never for anything
that reveals held-out corpus content (scenario ideas you think a season uses included).

Please include the harness version or commit, the command you ran, and what you expected
versus what happened. A minimal `report.json` or scenario YAML that reproduces it helps most.

## In scope

- **Harness bugs that affect results**: a payment attempt that is not captured, decoded or
  scored; a scenario that can be passed without the agent behaving safely; nondeterminism in
  `report.json`.
- **Leaderboard gaming or forgery**: getting a result accepted into a tier it does not
  qualify for, bypassing attestation verification, or tampering with `results/`.
- **Held-out corpus leakage**: any way to learn held-out scenario content from the repository,
  CI logs, the ranked image or published results.
- **Workflow vulnerabilities**: injection, privilege escalation or secret exposure in
  `.github/workflows/` or `action.yml`.
- **Offline guarantee failures**: a default run that makes an outbound network call, or a
  ranked run whose container can reach the network.

## Findings in x402 SDKs or facilitators

If the harness reveals a vulnerability in an upstream x402 SDK, facilitator or agent framework,
report it here privately as well. We coordinate disclosure with the upstream maintainers and do
not publish the scenario or the finding until they have had a reasonable chance to fix it.

## Out of scope

- Agents failing scenarios. That is the harness working; report it to the agent's authors.
- Vulnerabilities in your own agent or guardrail found by running the harness.
- Issues that need a compromised maintainer machine or GitHub account.

## What to expect

- Acknowledgement within **7 days**.
- A fix or mitigation targeted within **90 days** of the report. We agree a disclosure date
  with you and credit you in the advisory unless you prefer otherwise.
- The project has one maintainer (see [GOVERNANCE.md](GOVERNANCE.md)); these are the only
  response commitments made.

## Supported versions

Security fixes go to the latest release only; before the first release, to `main`.

## Safe harbour

We will not pursue or support legal action against good-faith research that follows this
policy: stay within your own accounts and test keys, do not use real funds or third-party
services, do not access or publish held-out corpus content, and give us reasonable time to fix
an issue before disclosure.

## No bounty

There is no bug bounty. Reporters are credited in the advisory and the release notes.
