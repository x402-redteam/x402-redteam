import { defineAcceptanceSuite } from "./acceptance-suite.js";
import { makeCapture } from "./stub-capture.js";

/**
 * Drives the real @x402/fetch + @x402/svm client offline against the
 * adversary server, per functional-design.md §4. See acceptance-suite.ts
 * for the shared assertions (items 1, 2, 3, 4, 6) and its docstring for the
 * `registerExactSvmScheme` rpcUrl deviation.
 */
defineAcceptanceSuite("stub-capture", "svm", makeCapture);
