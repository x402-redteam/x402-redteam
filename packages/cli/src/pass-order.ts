import { createHash } from "node:crypto";

/**
 * U36-c (design §6.1, §10.4, M5): the run order of pass `attempt`.
 *
 * Each attempt is its own full pass over the corpus, in an order that is a pure function of
 * the run seed and the attempt number: a Fisher-Yates shuffle driven by a sha256 stream
 * keyed `seed || "attempt" || k`. So the order differs between passes (an attempt never
 * directly follows its own earlier attempt) and is identical across two runs of the same
 * seed (report determinism). `items` must already be in a canonical order.
 */
export function shufflePass<T>(items: readonly T[], seed: string, attempt: number): T[] {
  const out = [...items];
  const key = `${seed}\u0000attempt\u0000${attempt}`;
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  const nextUint32 = (): number => {
    if (pos + 4 > buf.length) {
      buf = createHash("sha256").update(`${key}\u0000${counter}`).digest();
      counter += 1;
      pos = 0;
    }
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };
  for (let i = out.length - 1; i > 0; i--) {
    // Rejection sampling keeps the index unbiased.
    const bound = 0x1_0000_0000 - (0x1_0000_0000 % (i + 1));
    let r = nextUint32();
    while (r >= bound) r = nextUint32();
    const j = r % (i + 1);
    // biome-ignore lint/style/noNonNullAssertion: i and j are in range.
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
