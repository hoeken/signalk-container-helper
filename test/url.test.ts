import { describe, it, expect } from "vitest";
import { normalizeExternalUrl } from "../src/url.js";

describe("normalizeExternalUrl", () => {
  it("adds the default scheme to a bare host:port", () => {
    expect(normalizeExternalUrl("192.168.1.50:3010")?.baseUrl).toBe(
      "http://192.168.1.50:3010",
    );
  });

  it("adds the default scheme to a bare hostname", () => {
    const r = normalizeExternalUrl("nas.local:3010");
    expect(r?.baseUrl).toBe("http://nas.local:3010");
    expect(r?.host).toBe("nas.local");
    expect(r?.port).toBe(3010);
  });

  it("PRESERVES an explicit https scheme", () => {
    // Load-bearing: consumer proxies route on the scheme, so downgrading here
    // would break an HTTPS upstream far from this function.
    const r = normalizeExternalUrl("https://backup.example.com:3010");
    expect(r?.baseUrl).toBe("https://backup.example.com:3010");
    expect(r?.scheme).toBe("https");
  });

  it("keeps https with no port and reports port null", () => {
    const r = normalizeExternalUrl("https://backup.example.com");
    expect(r?.baseUrl).toBe("https://backup.example.com");
    expect(r?.port).toBeNull();
  });

  it("strips a trailing slash", () => {
    // Without this, `${baseUrl}/api/health` becomes `//api/health`.
    expect(normalizeExternalUrl("http://x:3010/")?.baseUrl).toBe(
      "http://x:3010",
    );
  });

  it("discards a path, query and fragment rather than rejecting", () => {
    for (const input of [
      "http://x:3010/index.html",
      "http://x:3010/a/b?q=1",
      "http://x:3010/#frag",
    ]) {
      expect(normalizeExternalUrl(input)?.baseUrl).toBe("http://x:3010");
    }
  });

  it("trims whitespace and wrapping quotes", () => {
    expect(normalizeExternalUrl('  "http://x:3010"  ')?.baseUrl).toBe(
      "http://x:3010",
    );
    expect(normalizeExternalUrl("'http://x:3010'")?.baseUrl).toBe(
      "http://x:3010",
    );
  });

  it("applies defaultPort only when the input carries none", () => {
    expect(
      normalizeExternalUrl("http://x", { defaultPort: 3020 })?.baseUrl,
    ).toBe("http://x:3020");
    expect(
      normalizeExternalUrl("http://x:9999", { defaultPort: 3020 })?.baseUrl,
    ).toBe("http://x:9999");
  });

  it("honours defaultScheme for a bare host", () => {
    expect(
      normalizeExternalUrl("x:3010", { defaultScheme: "https" })?.baseUrl,
    ).toBe("https://x:3010");
  });

  it("handles IPv6 literals", () => {
    const bracketed = normalizeExternalUrl("[::1]:9000");
    expect(bracketed?.baseUrl).toBe("http://[::1]:9000");
    expect(bracketed?.host).toBe("::1");
    expect(bracketed?.port).toBe(9000);

    // A bare IPv6 literal has colons but no scheme; it must not be mistaken
    // for host:port.
    const bare = normalizeExternalUrl("[::1]");
    expect(bare?.host).toBe("::1");
    expect(bare?.port).toBeNull();
  });

  it("rejects unusable input", () => {
    for (const bad of [
      "",
      "   ",
      undefined,
      null,
      "ftp://x:3010",
      "file:///etc/passwd",
      "htp://x",
      "http://",
      "http://x:0",
      "http://x:99999",
    ]) {
      expect(normalizeExternalUrl(bad as string | undefined)).toBeNull();
    }
  });

  it("returns an address usable as host:port", () => {
    expect(normalizeExternalUrl("http://10.0.0.5:8080")?.address).toBe(
      "10.0.0.5:8080",
    );
  });
});
