import { capture } from "@x402-redteam/capture";
import { defineAcceptanceSuite } from "./acceptance-suite.js";

/**
 * Gate G2 integration check: the exact same acceptance suite that runs
 * against `test/stub-capture.ts` (see evm-client.test.ts / svm-client.test.ts),
 * run again against the real `@x402-redteam/capture` package - swapping the
 * injected `CaptureApi` is the one-line change functional-design.md §1
 * describes. Production code (`src/**`) never imports `@x402-redteam/capture`
 * directly; only this test does.
 */
defineAcceptanceSuite("real-capture", "evm", () => capture);
defineAcceptanceSuite("real-capture", "svm", () => capture);
