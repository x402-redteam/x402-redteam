/** The host an `EGRESS_BLOCKED <kind>:<target>` guard refusal names, if `text` holds one. */
export function blockedHost(text: string): string | undefined {
  const match = /EGRESS_BLOCKED (\w+):(\S+)/.exec(text);
  if (!match) return undefined;
  const [, kind, target = ""] = match;
  try {
    if (kind === "fetch" || kind === "websocket") return new URL(target).hostname;
  } catch {
    return undefined;
  }
  if (kind === "tcp" || kind === "tls" || kind === "udp") return target.replace(/:\d*$/, "");
  return target;
}
