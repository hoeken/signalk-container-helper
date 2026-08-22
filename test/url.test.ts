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

  it("keeps an explicitly typed scheme-default port", () => {
    // URL() discards :80 / :443 as scheme defaults, so `url.port` is "" for
    // BOTH "http://x" and "http://x:80". Without looking at what the operator
    // actually typed, defaultPort would silently move them off the port they
    // chose.
    expect(
      normalizeExternalUrl("http://x:80", { defaultPort: 3020 })?.baseUrl,
    ).toBe("http://x:80");
    expect(
      normalizeExternalUrl("https://x:443", { defaultPort: 3020 })?.baseUrl,
    ).toBe("https://x:443");
    expect(
      normalizeExternalUrl("[::1]:80", { defaultPort: 3020 })?.baseUrl,
    ).toBe("http://[::1]:80");
  });

  it("still applies defaultPort when no port was typed", () => {
    // Including the IPv6 case, whose colons must not read as a port.
    expect(
      normalizeExternalUrl("http://x", { defaultPort: 3020 })?.baseUrl,
    ).toBe("http://x:3020");
    expect(normalizeExternalUrl("[::1]", { defaultPort: 3020 })?.baseUrl).toBe(
      "http://[::1]:3020",
    );
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

  it("does not mistake credentials for a port, and strips them", () => {
    // "user:pass@x" has a colon in the authority that is not a port; the
    // credentials must also not survive into baseUrl, which gets logged.
    expect(
      normalizeExternalUrl("http://user:pass@x", { defaultPort: 3020 })
        ?.baseUrl,
    ).toBe("http://x:3020");
    expect(normalizeExternalUrl("http://user:pass@x:8080")?.baseUrl).toBe(
      "http://x:8080",
    );
  });

  it("rejects a hostname WHATWG URL would otherwise wave through", () => {
    // `new URL("http://\"http://x")` does NOT throw — it parses with hostname
    // `"http`. Without an explicit charset guard that garbage reaches fetch
    // and the log.
    for (const bad of ['"http://x:3010', 'http://x:3010"', "x`y", "x{}y"]) {
      expect(normalizeExternalUrl(bad)).toBeNull();
    }
  });

  it("accepts legitimate hostname shapes", () => {
    for (const good of [
      "10.0.0.5",
      "my_host.local",
      "nas-01.lan",
      "[::1]",
      "[fe80::1]:9000",
    ]) {
      expect(normalizeExternalUrl(good)).not.toBeNull();
    }
  });

  it("punycodes a unicode hostname rather than rejecting it", () => {
    expect(normalizeExternalUrl("café.local")?.host).toBe("xn--caf-dma.local");
  });

  it("reports an explicitly typed scheme-default port even with no defaultPort", () => {
    // URL() drops :80/:443 as scheme defaults. baseUrl is unaffected either
    // way, but a consumer reading `.port` for a non-HTTP protocol (a raw TCP
    // ingest port) would otherwise get null for a port stated outright.
    expect(normalizeExternalUrl("http://x:80")?.port).toBe(80);
    expect(normalizeExternalUrl("https://x:443")?.port).toBe(443);
    expect(normalizeExternalUrl("[::1]:80")?.baseUrl).toBe("http://[::1]:80");
    // …and no port typed still means null.
    expect(normalizeExternalUrl("http://x")?.port).toBeNull();
  });

  it("returns an address usable as host:port", () => {
    expect(normalizeExternalUrl("http://10.0.0.5:8080")?.address).toBe(
      "10.0.0.5:8080",
    );
  });
});
