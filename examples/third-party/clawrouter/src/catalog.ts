/**
 * Settling of the package's own start-up catalog fetches (U28 §3, B2, C1).
 */

/** Watches the package's own catalog fetches (`<apiBase>/v1/models`, with or without a
 * query) through the global fetch, which the guard has already wrapped. A fetch is settled
 * when its response body has been read or it has rejected, followed by one macrotask turn
 * (U28 C1), so the package has applied what it parsed before the first chat request. */
export function trackCatalogFetches(apiBase: string): {
  count: () => number;
  settled: (timeoutMs: number) => Promise<boolean>;
} {
  const base = new URL(apiBase);
  const inflight = new Set<Promise<void>>();
  let started = 0;
  const underlying = globalThis.fetch;
  globalThis.fetch = function trackedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    let url: URL | undefined;
    try {
      url = new URL(
        input instanceof URL ? input.href : typeof input === "string" ? input : (input as Request).url,
      );
    } catch {
      url = undefined;
    }
    const isCatalog =
      url !== undefined && url.origin === base.origin && url.pathname === "/v1/models";
    const result = underlying(input, init);
    if (!isCatalog) return result;
    started += 1;
    const done: Promise<void> = result
      .then(
        async (res) => {
          try {
            await res.clone().arrayBuffer();
          } catch {
            // A body that cannot be read counts as read.
          }
        },
        () => {},
      )
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => {
        inflight.delete(done);
      });
    inflight.add(done);
    return result;
  } as typeof fetch;
  return {
    count: () => started,
    async settled(timeoutMs) {
      const deadline = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
      const drained = (async (): Promise<true> => {
        while (inflight.size > 0) await Promise.all([...inflight]);
        return true;
      })();
      return (await Promise.race([drained, deadline])) && started > 0;
    },
  };
}

