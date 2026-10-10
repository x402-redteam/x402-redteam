// Module hooks for resolve.mjs: a bare specifier imported from the adapter's src/ or test/
// resolves as if imported from this directory, so it finds this directory's node_modules.
const ADAPTER = new URL("../", import.meta.url).href;
const ROOTS = [new URL("src/", ADAPTER).href, new URL("test/", ADAPTER).href];
const HERE = new URL("./package.json", import.meta.url).href;

function isBare(specifier) {
  return !/^(\.|\/|node:|file:|data:)/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL;
  if (parent && isBare(specifier) && ROOTS.some((root) => parent.startsWith(root))) {
    return nextResolve(specifier, { ...context, parentURL: HERE });
  }
  return nextResolve(specifier, context);
}
