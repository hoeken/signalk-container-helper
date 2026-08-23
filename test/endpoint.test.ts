import { describe, it, expect, vi } from "vitest";
import {
  isManagedMode,
  resolveEndpoint,
  waitForEndpointReady,
  describeEndpoint,
  type ResolvedEndpoint,
} from "../src/endpoint.js";
import { ContainerHelperError } from "../src/util.js";
import type { ManagedContainer } from "../src/managed-container.js";
import { okFetch, flakyFetch } from "./fixtures.js";

/** Minimal ManagedContainer stand-in: resolveEndpoint only calls one method. */
function fakeContainer(address: string | null): ManagedContainer {
  return {
    resolveAddress: vi.fn(async () => address),
  } as unknown as ManagedContainer;
}

describe("isManagedMode", () => {
  it("treats undefined as MANAGED", () => {
    // The regression this whole rule exists for: Signal K calls start() with
    // {} when a plugin is enabled without its form ever being saved. Reading
    // that as self-hosted would break every such install.
    expect(isManagedMode(undefined)).toBe(true);
  });

  it("treats true as managed and false as self-hosted", () => {
    expect(isManagedMode(true)).toBe(true);
    expect(isManagedMode(false)).toBe(false);
  });
});

describe("resolveEndpoint — managed", () => {
  it("resolves the container address into a base URL", async () => {
    const container = fakeContainer("127.0.0.1:9000");
    const ep = await resolveEndpoint({
      managed: true,
      container,
      port: 9000,
      productName: "QuestDB",
    });
    expect(ep).toEqual({
      mode: "managed",
      baseUrl: "http://127.0.0.1:9000",
      address: "127.0.0.1:9000",
      container,
    });
  });

  it("takes the managed path when managedContainer is undefined", async () => {
    const ep = await resolveEndpoint({
      managed: undefined,
      container: fakeContainer("127.0.0.1:9000"),
      port: 9000,
      productName: "QuestDB",
    });
    expect(ep.mode).toBe("managed");
  });

  it("handles a container-DNS address, not just loopback", async () => {
    const ep = await resolveEndpoint({
      managed: true,
      container: fakeContainer("sk-questdb:9000"),
      port: 9000,
      productName: "QuestDB",
    });
    expect(ep.baseUrl).toBe("http://sk-questdb:9000");
  });

  it("throws address-unresolved when the manager cannot resolve", async () => {
    await expect(
      resolveEndpoint({
        managed: true,
        container: fakeContainer(null),
        port: 9000,
        productName: "QuestDB",
      }),
    ).rejects.toMatchObject({ code: "address-unresolved" });
  });

  it("throws invalid-option when the container or port is missing", async () => {
    await expect(
      resolveEndpoint({ managed: true, port: 9000, productName: "X" }),
    ).rejects.toMatchObject({ code: "invalid-option" });
    await expect(
      resolveEndpoint({
        managed: true,
        container: fakeContainer("127.0.0.1:1"),
        productName: "X",
      }),
    ).rejects.toMatchObject({ code: "invalid-option" });
  });
});

describe("resolveEndpoint — managed via containerName", () => {
  // Not every plugin hands its lifecycle to ManagedContainer: two of the three
  // reference plugins call ensureRunning directly, and address resolution
  // needs no lifecycle at all.
  const managerWith = (
    resolve: () => Promise<string | null>,
    list: unknown[] = [],
  ) =>
    ({
      resolveContainerAddress: vi.fn(resolve),
      listContainers: vi.fn(async () => list),
    }) as never;

  it("resolves without a ManagedContainer", async () => {
    const ep = await resolveEndpoint({
      managed: true,
      containerName: "tailscale",
      manager: managerWith(async () => "127.0.0.1:3020"),
      port: 3020,
      productName: "T",
    });
    expect(ep.mode).toBe("managed");
    expect(ep.baseUrl).toBe("http://127.0.0.1:3020");
    // No ManagedContainer was passed, so there is none to hand back.
    expect(ep.container).toBeNull();
  });

  it("falls back to port bindings under a non-default namespace", async () => {
    // A hand-rolled `sk-${name}` match misses this; unprefixedName does not.
    const ep = await resolveEndpoint({
      managed: true,
      containerName: "tailscale",
      manager: managerWith(
        async () => null,
        [
          {
            name: "devpod-tailscale",
            unprefixedName: "tailscale",
            ports: ["127.0.0.1:9999->3020/tcp"],
          },
        ],
      ),
      port: 3020,
      productName: "T",
    });
    expect(ep.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("throws address-unresolved when nothing answers", async () => {
    await expect(
      resolveEndpoint({
        managed: true,
        containerName: "tailscale",
        manager: managerWith(async () => null),
        port: 3020,
        productName: "T",
      }),
    ).rejects.toMatchObject({ code: "address-unresolved" });
  });

  it("requires one of container or containerName", async () => {
    await expect(
      resolveEndpoint({ managed: true, port: 3020, productName: "T" }),
    ).rejects.toMatchObject({ code: "invalid-option" });
  });
});

describe("resolveEndpoint — self-hosted", () => {
  it("normalises the operator URL", async () => {
    const ep = await resolveEndpoint({
      managed: false,
      externalUrl: "  192.168.1.50:3010/  ",
      productName: "backup-server",
    });
    expect(ep.mode).toBe("external");
    expect(ep.baseUrl).toBe("http://192.168.1.50:3010");
    expect(ep.container).toBeNull();
  });

  it("keeps the message the plugins already show for an empty URL", async () => {
    // Pinned verbatim so the migration is provably non-regressive in the copy
    // an operator sees.
    const err = await resolveEndpoint({
      managed: false,
      externalUrl: "   ",
      productName: "backup-server",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContainerHelperError);
    expect((err as ContainerHelperError).code).toBe("external-url-missing");
    expect((err as Error).message).toContain(
      "managedContainer is disabled but externalUrl is empty",
    );
  });

  it("names a custom url field in the empty-URL error", async () => {
    const err = await resolveEndpoint({
      managed: false,
      urlFieldName: "serverUrl",
      productName: "X",
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("serverUrl is empty");
  });

  it("distinguishes malformed from missing", async () => {
    await expect(
      resolveEndpoint({
        managed: false,
        externalUrl: "ftp://nope",
        productName: "X",
      }),
    ).rejects.toMatchObject({ code: "external-url-invalid" });
  });

  it("applies defaultPort when the URL carries none", async () => {
    const ep = await resolveEndpoint({
      managed: false,
      externalUrl: "http://nas.local",
      defaultPort: 3020,
      productName: "X",
    });
    expect(ep.baseUrl).toBe("http://nas.local:3020");
  });
});

describe("waitForEndpointReady", () => {
  const ep: ResolvedEndpoint = {
    mode: "external",
    baseUrl: "http://x:3010",
    address: "x:3010",
    container: null,
  };

  it("probes baseUrl + path", async () => {
    const fetchImpl = okFetch();
    await waitForEndpointReady(ep, { path: "/api/health", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://x:3010/api/health",
      expect.anything(),
    );
  });

  it("tolerates a path with no leading slash", async () => {
    const fetchImpl = okFetch();
    await waitForEndpointReady(ep, { path: "api/health", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://x:3010/api/health",
      expect.anything(),
    );
  });

  it("makes ONE attempt and throws when no retry is configured", async () => {
    // Preserving the report-once-and-wait behaviour of the plugins that do
    // not retry; defaulting retry on would silently change them.
    await expect(
      waitForEndpointReady(ep, {
        fetchImpl: flakyFetch(99),
        maxMs: 20,
        intervalMs: 5,
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow(/did not become ready/);
  });

  it("retries when asked, reporting each failed attempt", async () => {
    // maxMs 0 makes each waitForHttpReady attempt give up after a single
    // failed probe, so the flaky failures surface as retryForever attempts
    // rather than being absorbed inside one readiness wait.
    const onAttemptFailed = vi.fn();
    const fetchImpl = flakyFetch(2);
    await waitForEndpointReady(ep, {
      fetchImpl,
      maxMs: 0,
      intervalMs: 1,
      requestTimeoutMs: 5,
      retry: { minDelayMs: 1, maxDelayMs: 2, onAttemptFailed },
    });
    expect(onAttemptFailed).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("surfaces an abort as AbortError, not as a readiness failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await waitForEndpointReady(ep, {
      fetchImpl: okFetch(),
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("describeEndpoint", () => {
  it("names the mode", () => {
    expect(
      describeEndpoint({
        mode: "managed",
        baseUrl: "http://a:1",
        address: "a:1",
        container: null,
      }),
    ).toContain("managed container");
    expect(
      describeEndpoint({
        mode: "external",
        baseUrl: "http://a:1",
        address: "a:1",
        container: null,
      }),
    ).toContain("external service");
  });
});
