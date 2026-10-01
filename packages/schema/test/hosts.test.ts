import { describe, expect, it } from "vitest";
import { hostName, hostUrl } from "../src/hosts.js";

const BASE_URL = "http://127.0.0.1:43021";

describe("hostUrl", () => {
  it("path mode: identical to the pre-v3 /_host/ builder", () => {
    expect(hostUrl("path", BASE_URL, "provider.test")).toBe(`${BASE_URL}/_host/provider.test`);
  });

  it("localhost mode: renders the full scenario hostname under .localhost, with the port", () => {
    expect(hostUrl("localhost", BASE_URL, "provider.test")).toBe(
      "http://provider.test.localhost:43021",
    );
  });

  it("localhost mode: keeps hyphenated and multi-label names intact", () => {
    expect(hostUrl("localhost", BASE_URL, "weather-report.test")).toBe(
      "http://weather-report.test.localhost:43021",
    );
    expect(hostUrl("localhost", BASE_URL, "cdn-metrics.test")).toBe(
      "http://cdn-metrics.test.localhost:43021",
    );
  });

  it("localhost mode: omits the port when baseUrl has none", () => {
    expect(hostUrl("localhost", "http://127.0.0.1", "provider.test")).toBe(
      "http://provider.test.localhost",
    );
  });

  it("proxy mode: a bare origin, no port, no .localhost suffix", () => {
    expect(hostUrl("proxy", BASE_URL, "provider.test")).toBe("http://provider.test");
  });
});

describe("hostName", () => {
  it("path mode: identity, so allowed_hosts keeps today's values", () => {
    expect(hostName("path", "provider.test")).toBe("provider.test");
  });

  it("localhost mode: the name plus .localhost", () => {
    expect(hostName("localhost", "provider.test")).toBe("provider.test.localhost");
  });

  it("proxy mode: identity, matching hostUrl's bare origin", () => {
    expect(hostName("proxy", "provider.test")).toBe("provider.test");
  });

  // Code review item 7: lowercased in every mode (DNS hostnames are case-insensitive,
  // and a guardrail's new URL(...).hostname is always lowercase).
  it("lowercases its output in every mode", () => {
    expect(hostName("path", "Provider.Test")).toBe("provider.test");
    expect(hostName("localhost", "Weather-Report.TEST")).toBe("weather-report.test.localhost");
    expect(hostName("proxy", "Provider.Test")).toBe("provider.test");
  });
});
