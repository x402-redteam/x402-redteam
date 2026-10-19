// Preloaded into Node clients by run.mjs (NODE_OPTIONS --import). The network-deny layer
// blocks the OS resolver, so `localhost` and `*.localhost` (the harness's virtual hosts)
// are resolved here to 127.0.0.1. Every other name goes to the real resolver, which the
// sandbox refuses. Only the resolver is touched; the connect rule is the OS's.
import dns from "node:dns";

const isLocal = (host) =>
  host === "localhost" || (typeof host === "string" && host.endsWith(".localhost"));

const realLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" || options == null ? {} : options;
  if (!isLocal(hostname)) return realLookup.call(dns, hostname, options, callback);
  const family = typeof opts === "number" ? opts : opts.family;
  if (family === 6 || family === "IPv6") {
    queueMicrotask(() =>
      cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })),
    );
    return {};
  }
  queueMicrotask(() =>
    opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4),
  );
  return {};
};

const realPromisesLookup = dns.promises.lookup;
dns.promises.lookup = async function lookup(hostname, options) {
  if (!isLocal(hostname)) return realPromisesLookup.call(dns.promises, hostname, options);
  const all = typeof options === "object" && options !== null && options.all;
  return all ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 };
};
