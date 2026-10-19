import { describe, expect, it } from "vitest";
import {
  harnessPort,
  macosProfile,
  sandboxArgv,
  shimEnv,
} from "../../examples/fuzz-sandbox/run.mjs";

describe("fuzz-sandbox launcher (pure parts; the OS-level canary is manual)", () => {
  it("takes the harness port from base_url", () => {
    expect(harnessPort("http://127.0.0.1:4021")).toBe(4021);
    expect(harnessPort("http://x.test")).toBe(80);
    expect(harnessPort("https://x.test")).toBe(443);
    expect(harnessPort("nonsense")).toBeUndefined();
    expect(harnessPort("http://127.0.0.1:")).toBeUndefined();
    expect(harnessPort("http://127.0.0.1:/x")).toBeUndefined();
    expect(harnessPort("http://127.0.0.1/x")).toBe(80);
    expect(harnessPort(undefined)).toBeUndefined();
    expect(harnessPort("http://x.test:99999")).toBeUndefined();
  });

  it("allows network only to the harness port, plus unix sockets under the temp dirs", () => {
    const p = macosProfile(4021, "/private/tmp/fz-x");
    expect(p).toContain("(deny mach-lookup)");
    expect(p).not.toContain('(subpath "/private/tmp")');
    expect(p).toContain("(deny network*)");
    expect(p).toContain('(remote ip "localhost:4021")');
    const allowed = p.split("\n").filter((l) => l.startsWith("(allow network"));
    expect(allowed).toHaveLength(3);
    expect(allowed.filter((l) => !l.includes("unix-socket"))).toHaveLength(1);
    expect(p).not.toContain("mDNSResponder");
  });

  it("wraps the command and refuses an absent sandbox", () => {
    expect(sandboxArgv("sandbox-exec", 1, ["a", "b"], "/r").slice(-2)).toEqual(["a", "b"]);
    expect(() => sandboxArgv("unshare", 1, ["a"], "/r")).toThrow(/no OS sandbox/);
    expect(() => sandboxArgv("none", 1, ["a"])).toThrow(/no OS sandbox/);
  });

  it("adds the DNS shims without dropping existing options", () => {
    const env = shimEnv({ NODE_OPTIONS: "--no-warnings", PYTHONPATH: "/x" }, "/r");
    expect(env).toMatchObject({
      TMPDIR: "/r",
      TMP: "/r",
      TEMP: "/r",
      PYTHONDONTWRITEBYTECODE: "1",
    });
    expect(env.NODE_OPTIONS).toMatch(/^--no-warnings --import file:\/\/.*dns-shim\.mjs$/);
    expect(env.PYTHONPATH).toMatch(/pyshim.*\/x$/);
  });
});
