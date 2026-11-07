/**
 * M7 probes (U35 section 5): can a sandboxed child read another process's environment?
 *
 * A launcher process holds a random marker in its *exec* environment (so `kern.procargs2`
 * holds it) and starts the probe child through the shared spawn. The child runs the probes
 * below and compares what it sees against the markers *inside the child*; only verdicts
 * leave it. Raw output is never returned, written or logged (m8). The markers are random
 * hex, never a real key.
 */
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Verdict = "denied" | "empty" | "leaked";

export interface ProbeVerdict {
  id: string;
  verdict: Verdict;
  /** The tool was absent or could not be tried, so the verdict is `empty` by default (D2). */
  notRun?: boolean;
}

export interface Marker {
  id: string;
  value: string;
}

/** The probes the runtime preflight runs: the plain read, the copied-binary read and the
 * stock-interpreter sysctl read. P5 not run (no Command Line Tools) is reported, never silent. */
export const PREFLIGHT_PROBES = ["P1", "P4", "P5"] as const;
export const ALL_PROBES = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;

const PROBE_TIMEOUT_MS = 15_000;

interface Ran {
  stdout: string;
  stderr: string;
  failed: boolean;
  notRun: boolean;
}

function run(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = (err as { code?: unknown } | null)?.code;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            failed: err !== null,
            notRun: code === "ENOENT",
          });
        },
      );
    } catch (err) {
      // A refused exec (EPERM) can be thrown synchronously.
      const code = (err as { code?: unknown }).code;
      resolve({ stdout: "", stderr: "", failed: true, notRun: code === "ENOENT" });
    }
  });
}

/** Which markers appear in the text. Compared inside the child; only ids leave it. */
function matchedIds(text: string, markers: readonly Marker[]): string[] {
  return markers.filter((m) => text.includes(m.value)).map((m) => m.id);
}

function judge(ran: Ran, matched: readonly string[]): Verdict {
  if (matched.length > 0) return "leaked";
  if (ran.failed && ran.stdout.trim() === "") return "denied";
  if (/Operation not permitted|Permission denied/i.test(ran.stderr) && ran.stdout.trim() === "") {
    return "denied";
  }
  return "empty";
}

/** A verdict plus the ids of the markers it saw (used for P6, then dropped). */
type Seen = ProbeVerdict & { matched: string[] };

const PS = "/bin/ps";

/** Stock-interpreter route (P5): python3 calling sysctl kern.procargs2 for a pid. Needs a real
 * Command Line Tools install, because the bare /usr/bin/python3 is a stub that opens an install
 * dialog and can hang an offline run (D2). */
const PY_PROCARGS = `
import ctypes, sys
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
pid = int(sys.argv[1])
mib = (ctypes.c_int * 3)(1, 49, pid)
size = ctypes.c_size_t(0)
libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)
buf = ctypes.create_string_buffer(max(size.value, 1))
if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
    sys.stderr.write("Operation not permitted")
    sys.exit(1)
sys.stdout.write(buf.raw[: size.value].decode("utf-8", "replace"))
`;

function hasCommandLineTools(): boolean {
  const r = spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 5000 });
  return r.status === 0;
}

async function probeDarwin(id: string, home: string, markers: readonly Marker[]): Promise<Seen> {
  const ppid = String(process.ppid);
  const uid = String(process.getuid?.() ?? 0);
  const finish = (ran: Ran): Seen => {
    const matched = ran.notRun ? [] : matchedIds(`${ran.stdout}\n${ran.stderr}`, markers);
    return {
      id,
      verdict: ran.notRun ? "empty" : judge(ran, matched),
      matched,
      ...(ran.notRun ? { notRun: true } : {}),
    };
  };
  switch (id) {
    case "P1":
      return finish(await run(PS, ["-E", "-ww", "-o", "command=", "-p", ppid]));
    case "P2":
      return finish(await run(PS, ["-E", "-ww", "-o", "command=", "-U", uid]));
    case "P3":
      return finish(await run(PS, ["eww", "-p", ppid]));
    case "P4": {
      const copy = join(home, "tmp", "p");
      try {
        copyFileSync(PS, copy);
        chmodSync(copy, 0o755);
      } catch {
        return { id, verdict: "denied", matched: [] };
      }
      return finish(await run(copy, ["-E", "-ww", "-o", "command=", "-p", ppid]));
    }
    case "P5": {
      if (!hasCommandLineTools()) return { id, verdict: "empty", notRun: true, matched: [] };
      return finish(await run("/usr/bin/python3", ["-c", PY_PROCARGS, ppid]));
    }
    default:
      return { id, verdict: "empty", notRun: true, matched: [] };
  }
}

function probeLinux(id: string, markers: readonly Marker[]): Seen {
  const ppid = String(process.ppid);
  const seen = (matched: string[]): Seen => ({
    id,
    verdict: matched.length > 0 ? "leaked" : "empty",
    matched,
  });
  try {
    if (id === "P1")
      return seen(matchedIds(readFileSync(`/proc/${ppid}/environ`, "latin1"), markers));
    if (id === "P2") {
      const found = new Set<string>();
      for (const pid of readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n))) {
        try {
          for (const m of matchedIds(readFileSync(`/proc/${pid}/environ`, "latin1"), markers))
            found.add(m);
        } catch {
          // Not readable: fine.
        }
      }
      return seen([...found]);
    }
  } catch {
    return { id, verdict: "denied", matched: [] };
  }
  return { id, verdict: "empty", notRun: true, matched: [] };
}

/**
 * Runs the named probes inside the child. P6 is a verdict over everything the other probes
 * saw: `leaked` when the key-file marker (id `key`) appears in any of their output.
 */
export async function runProbes(
  ids: readonly string[],
  markers: readonly Marker[],
  home: string,
): Promise<ProbeVerdict[]> {
  const out: ProbeVerdict[] = [];
  let keySeen = false;
  for (const id of ids) {
    if (id === "P6") continue;
    const seen =
      process.platform === "darwin"
        ? await probeDarwin(id, home, markers)
        : probeLinux(id, markers);
    if (seen.matched.includes("key")) keySeen = true;
    const { matched: _matched, ...verdict } = seen;
    out.push(verdict);
  }
  if (ids.includes("P6")) out.push({ id: "P6", verdict: keySeen ? "leaked" : "empty" });
  return out;
}

/** True when no verdict is `leaked`. */
export function noLeak(verdicts: readonly ProbeVerdict[]): boolean {
  return verdicts.every((v) => v.verdict !== "leaked");
}
