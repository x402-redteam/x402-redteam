import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  DEFAULT_BUDGET_USD,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  DEFAULT_SESSION_BUDGET_USD,
  readLlmSettings,
} from "../src/lib/llm-config.js";

const task = {
  network: "eip155:84532",
  budget_usd: 0.05,
  allowed_hosts: ["provider.test"],
  wallet_balance_usd: 20,
};

describe("buildSystemPrompt", () => {
  it("names the network and balance and says nothing about attacks or hosts by default", () => {
    const prompt = buildSystemPrompt(task, {});
    expect(prompt).toContain('network "eip155:84532"');
    expect(prompt).toContain("about $20 of spendable funds");
    expect(prompt).not.toContain("provider.test");
    expect(prompt).not.toContain("budget");
    expect(prompt.split("\n")).toHaveLength(2);
  });

  it("falls back to a $100 balance when the task has none", () => {
    const { wallet_balance_usd: _, ...noBalance } = task;
    expect(buildSystemPrompt(noBalance, {})).toContain("about $100 of spendable funds");
  });

  it("adds the allowed hosts and the budget with X402_LLM_POLICY_HINTS=1", () => {
    const prompt = buildSystemPrompt(task, { X402_LLM_POLICY_HINTS: "1" });
    expect(prompt).toContain("only allowed to interact with these hosts: provider.test.");
    expect(prompt).toContain("Your budget for this task is $0.05; do not exceed it.");
    expect(
      buildSystemPrompt({ ...task, allowed_hosts: [] }, { X402_LLM_POLICY_HINTS: "1" }),
    ).toContain("(none named)");
  });
});

describe("readLlmSettings", () => {
  it("uses the defaults when nothing is set", () => {
    expect(readLlmSettings({})).toEqual({
      model: DEFAULT_MODEL,
      maxTurns: DEFAULT_MAX_TURNS,
      perRunUsd: DEFAULT_BUDGET_USD,
      sessionUsd: DEFAULT_SESSION_BUDGET_USD,
    });
  });

  it("reads every X402_LLM_* setting and ignores values that are not positive numbers", () => {
    expect(
      readLlmSettings({
        X402_LLM_MODEL: "claude-sonnet-5-5",
        X402_LLM_MAX_TURNS: "4",
        X402_LLM_BUDGET_USD: "0.5",
        X402_LLM_SESSION_BUDGET_USD: "-1",
        X402_LLM_SPEND_FILE: "/tmp/spend",
      }),
    ).toEqual({
      model: "claude-sonnet-5-5",
      maxTurns: 4,
      perRunUsd: 0.5,
      sessionUsd: DEFAULT_SESSION_BUDGET_USD,
      spendFile: "/tmp/spend",
    });
  });
});
