// Test guardrail (U36-c): declares itself deterministic but keeps state OUTSIDE the
// harness's per-run reset scope (the path is a command-line argument, not HOME or TMPDIR).
//   usage: node flaky-state.mjs <state-file> <count|memo> <n>
//   count: allows only the first <n> requests it has ever seen, then denies (a call-order
//          flip, no replay).
//          Two separate shuffled passes disagree, so the reproducibility check rejects it.
//   order: <n> is the number of runs per pass; the verdict depends on the previous run's
//          requests (see below). Identical unshuffled passes reproduce it; passes in
//          different orders do not (the shuffle is what exposes it).
//   memo : decides like `count`, but memoises the verdict by request hash in the state file
//          and replays it. Both passes agree: the documented residual (AC-c1b).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [stateFile, mode, nArg] = process.argv.slice(2);
const n = Number(nArg);

function load() {
  return existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { calls: 0, memo: {} };
}

function respond(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    const st = load();
    st.runs = (st.runs ?? 0) + 1;
    st.digests = st.digests ?? [];
    writeFileSync(stateFile, JSON.stringify(st));
    respond({
      id: msg.id,
      hooks: ["payment", "transfer", "sign"],
      name: "flaky-state",
      version: "1",
      nondeterministic: false,
    });
    return;
  }
  const state = load();
  // A prompt/challenge-keyed cache: the request kind, the page text that prompted it and
  // the payee. The ephemeral port per run appears in URLs AND inside the prompt text
  // ("Fetch http://127.0.0.1:<port>/vault ..."), so ports are masked out of the text.
  const stable = (t) => (t ?? "").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT");
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        msg.type,
        stable(msg.source?.text ?? msg.referrer?.text),
        msg.challenge?.accepts?.[0]?.payTo ?? msg.intent?.to ?? "",
      ]),
    )
    .digest("hex");
  const id = msg.id;
  let allow;
  if (mode === "order") {
    // The verdict depends on the digest of the PREVIOUS RUN's requests (kept across runs in
    // the state file), except for the first run of each pass of <n> runs, whose predecessor
    // is "". Two passes in the same order reproduce; passes in different orders do not.
    const run = state.runs - 1;
    const prevDigest = run % n === 0 ? "" : (state.digests[run - 1] ?? "");
    // The request's position within its run is hashed in too, so one run yields several
    // verdict bits and a changed predecessor is very unlikely to leave them all unchanged.
    const seq = state.seq?.[run] ?? 0;
    state.seq = { ...state.seq, [run]: seq + 1 };
    const digest = createHash("sha256").update(`${prevDigest}|${key}|${seq}`).digest();
    allow = digest[0] % 2 !== 0;
    state.digests[run] = createHash("sha256")
      .update(`${state.digests[run] ?? ""}|${key}`)
      .digest("hex");
    writeFileSync(stateFile, JSON.stringify(state));
  } else if (mode === "memo" && key in state.memo) {
    allow = state.memo[key];
  } else {
    state.calls += 1;
    allow = state.calls <= n;
    state.memo[key] = allow;
    writeFileSync(stateFile, JSON.stringify(state));
  }
  if (!allow) {
    respond({ id, decision: "deny", reason: "flaky-state" });
  } else if (msg.type === "payment") {
    respond({ id, decision: "allow", accept_index: 0 });
  } else {
    respond({ id, decision: "allow" });
  }
});
