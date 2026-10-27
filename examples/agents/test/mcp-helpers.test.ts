import { describe, expect, it } from "vitest";
import {
  advertisedToolPrice,
  approvedPrices,
  mcpServers,
  namedServers,
  namedTools,
  requireEvm,
  resultText,
} from "../src/lib/mcp.js";
import type { TaskFile } from "../src/lib/wallet.js";

function task(prompt: string, extra: Record<string, unknown> = {}): TaskFile {
  return {
    version: 4,
    run_id: "r",
    prompt,
    base_url: "http://127.0.0.1:9000",
    chain: "evm",
    network: "eip155:84532",
    budget_usd: 0.1,
    allowed_hosts: ["provider.test"],
    hosts: {
      "provider.test": "http://127.0.0.1:9000/_host/provider.test",
      "other.test": "http://127.0.0.1:9000/_host/other.test",
    },
    mcp_servers: {
      "provider.test": "http://127.0.0.1:9000/_host/provider.test/mcp",
      "other.test": "http://127.0.0.1:9000/_host/other.test/mcp",
    },
    ...extra,
  } as unknown as TaskFile;
}

describe("namedServers", () => {
  it("returns the servers whose host root or MCP URL the prompt contains", () => {
    expect(namedServers(task("Use http://127.0.0.1:9000/_host/other.test/mcp."))).toEqual([
      "http://127.0.0.1:9000/_host/other.test/mcp",
    ]);
    expect(namedServers(task("Use http://127.0.0.1:9000/_host/provider.test now"))).toEqual([
      "http://127.0.0.1:9000/_host/provider.test/mcp",
    ]);
  });

  it("treats base_url as the default host's root", () => {
    expect(namedServers(task("Use http://127.0.0.1:9000/mcp please"))).toEqual([
      "http://127.0.0.1:9000/_host/provider.test/mcp",
    ]);
  });

  it("falls back to the only server when the prompt names no URL, never with two", () => {
    const one = task("Call the tool.", {
      mcp_servers: { "provider.test": "http://127.0.0.1:9000/mcp" },
    });
    expect(namedServers(one)).toEqual(["http://127.0.0.1:9000/mcp"]);
    expect(namedServers(task("Call the tool."))).toEqual([]);
  });

  it("returns nothing when the task has no MCP server", () => {
    const t = task("Call the tool.", { mcp_servers: undefined });
    expect(mcpServers(t)).toEqual({});
    expect(namedServers(t)).toEqual([]);
  });
});

describe("namedTools", () => {
  const listed = [{ name: "get_forecast" }, { name: "get_forecast_v2" }, { name: "ping" }];

  it("matches whole names and orders them by first mention", () => {
    expect(namedTools("First `ping`, then get_forecast.", listed)).toEqual([
      "ping",
      "get_forecast",
    ]);
  });

  it("returns one call per mention, and the approval sentence is not a mention", () => {
    expect(
      namedTools("Call ping, then ping again. The user approved `ping` at $0.01 a call.", listed),
    ).toEqual(["ping", "ping"]);
  });

  it("does not match a name inside a longer identifier", () => {
    expect(namedTools("Call get_forecast_v2 only", listed)).toEqual(["get_forecast_v2"]);
  });
});

describe("approvedPrices", () => {
  it("parses the documented sentence", () => {
    const prices = approvedPrices(
      "The user approved `a_tool` at $0.01 a call. The user approved `b_tool` at $2 a call.",
    );
    expect([...prices]).toEqual([
      ["a_tool", 0.01],
      ["b_tool", 2],
    ]);
  });

  it("ignores other phrasings and keeps the first price for a tool", () => {
    expect(approvedPrices("approved a_tool at $1").size).toBe(0);
    expect(
      approvedPrices(
        "the user approved `t` at $0.01 a call; the user approved `t` at $9 a call.",
      ).get("t"),
    ).toBe(0.01);
  });
});

describe("advertisedToolPrice and resultText", () => {
  it("reads the lowest dollar amount of a description", () => {
    expect(advertisedToolPrice("Costs $0.25 a call, not $5.")).toBe(0.25);
    expect(advertisedToolPrice("Was $5, now $0.25 a call.")).toBe(0.25);
    expect(advertisedToolPrice("Free.")).toBeUndefined();
    expect(advertisedToolPrice(undefined)).toBeUndefined();
  });

  it("joins the text items of a result", () => {
    expect(
      resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
    ).toBe("a\nb");
    expect(resultText(undefined)).toBe("");
  });
});

describe("requireEvm", () => {
  it("refuses an SVM task", () => {
    expect(() => requireEvm(task("x", { chain: "svm" }))).toThrow(/EVM tasks only/);
    expect(() => requireEvm(task("x"))).not.toThrow();
  });
});
