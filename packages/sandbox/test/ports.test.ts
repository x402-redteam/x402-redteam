import { describe, expect, it } from "vitest";
import { allowedPorts, harnessPort, parsePort, portOfUrl } from "../src/ports.js";

describe("allowedPorts", () => {
  it("is the harness port plus the extras, sorted", () => {
    expect(allowedPorts("http://127.0.0.1:7000", { extra: [5000] })).toEqual([5000, 7000]);
  });
  it("is empty without a usable base url", () => {
    expect(allowedPorts(undefined)).toEqual([]);
    expect(allowedPorts("not a url")).toEqual([]);
  });
  it("drops a refused harness port silently", () => {
    expect(allowedPorts("http://127.0.0.1:8402", { refused: [8402] })).toEqual([]);
  });
  it("throws for an extra that is refused or not a port", () => {
    expect(() => allowedPorts(undefined, { extra: [8402], refused: [8402] })).toThrow(/refused/);
    expect(() => allowedPorts(undefined, { extra: [0] })).toThrow(/valid port/);
    expect(() => allowedPorts(undefined, { extra: [70000] })).toThrow(/valid port/);
  });
  it("reads default ports", () => {
    expect(portOfUrl(new URL("https://a.test/"))).toBe(443);
    expect(portOfUrl(new URL("http://a.test/"))).toBe(80);
    expect(harnessPort("http://a.test:9/")).toBe(9);
  });
  it("parses a port written in an environment variable", () => {
    expect(parsePort("5555")).toBe(5555);
    expect(parsePort("0")).toBeUndefined();
    expect(parsePort("65536")).toBeUndefined();
    expect(parsePort("12a")).toBeUndefined();
    expect(parsePort(undefined)).toBeUndefined();
  });
});
