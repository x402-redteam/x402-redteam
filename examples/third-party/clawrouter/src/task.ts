/**
 * The harness's task.json, as far as this adapter needs it. One shared reader for the parent,
 * the child and the guard: it lives in @x402-redteam/sandbox (U35 D16).
 */
export { readTask, readTaskFrom, type TaskFile, taskHostnames, taskUrls } from "@x402-redteam/sandbox";
