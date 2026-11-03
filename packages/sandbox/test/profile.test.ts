import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DENIED_HOME_PATHS, macosProfile, outDirOf, sbString } from "../src/profile.js";

const base = {
  deniedRoot: "/Users/real",
  childHome: "/private/var/folders/xx/T/x402rt-a-home-1",
  ports: [] as number[],
  writable: ["/private/var/folders/xx/T/x402rt-a-home-1"],
  readable: [] as string[],
};

describe("macosProfile", () => {
  it("denies the union of private folders under the parent's real home, never the child's HOME (M2)", () => {
    const profile = macosProfile(base);
    for (const p of DENIED_HOME_PATHS) {
      expect(profile).toContain(`(subpath "${join("/Users/real", p)}")`);
      expect(profile).not.toContain(join(base.childHome, p));
    }
    for (const name of [".openclaw", ".blockrun", ".wrangler", "x402-redteam-private", ".ssh"]) {
      expect(profile).toContain(name);
    }
  });

  it("names a real home that a spawn would use", () => {
    const profile = macosProfile({ ...base, deniedRoot: homedir() });
    expect(profile).toContain(`(subpath "${join(homedir(), ".ssh")}")`);
  });

  it("adds extra denied folders per adapter", () => {
    expect(macosProfile({ ...base, extraDeniedHomePaths: [".extra"] })).toContain(
      "/Users/real/.extra",
    );
  });

  it("emits one network rule per port and no wildcard", () => {
    const profile = macosProfile({ ...base, ports: [5000, 6000] });
    expect(profile).toContain('(remote ip "localhost:5000")');
    expect(profile).toContain('(remote ip "localhost:6000")');
    expect(profile).not.toContain("localhost:*");
    expect(profile).not.toMatch(/network-bind|network-inbound/);
  });

  it("grants bind and inbound only on the listen port", () => {
    const profile = macosProfile({ ...base, ports: [6000], listenPort: 6000 });
    expect(profile).toContain('(allow network-bind (local ip "localhost:6000"))');
    expect(profile).toContain('(allow network-inbound (local ip "localhost:6000"))');
  });

  it("re-allows the out dir for reading before the secret-file denial, so .env stays denied there", () => {
    const profile = macosProfile({ ...base, readable: ["/out"] });
    const allow = profile.indexOf('(allow file-read* (subpath "/out"))');
    const deny = profile.indexOf("dev\\.vars");
    expect(allow).toBeGreaterThan(profile.indexOf("(deny file-read* (subpath"));
    expect(deny).toBeGreaterThan(allow);
  });

  it("allows writes only to /dev and the writable set, which excludes the out dir and tmpdir", () => {
    const profile = macosProfile({ ...base, readable: ["/out"] });
    expect(profile).toContain(
      `(deny file-write* (require-not (require-any (subpath "/dev") (subpath "${base.childHome}"))))`,
    );
    expect(profile).not.toMatch(/subpath "\/out"\)\)\)\)/);
    expect(profile).not.toContain('"/private/tmp"');
  });

  it("carries the M7 controls and denies exec under the child's HOME", () => {
    const profile = macosProfile(base);
    expect(profile).toContain(
      '(deny sysctl-read (sysctl-name "kern.procargs2") (sysctl-name "kern.procargs"))',
    );
    expect(profile).toContain("(deny process-info* (target others))");
    expect(profile).toContain(`(deny process-exec* (subpath "${base.childHome}"))`);
    expect(profile).not.toContain('(literal "/bin/ps")');
  });
});

describe("helpers", () => {
  it("escapes quotes and backslashes in profile strings", () => {
    expect(sbString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
  it("the out dir is two levels above the task file", () => {
    expect(outDirOf("/nonexistent/out/tasks/run.json")).toBe("/nonexistent/out");
  });
});
