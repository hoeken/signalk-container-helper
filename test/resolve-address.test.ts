import { describe, it, expect, vi } from "vitest";
import {
  matchContainerInfo,
  matchesLegacyName,
  resolveContainerEndpoint,
} from "../src/resolve-address.js";
import type { ContainerInfo, ContainerManagerApi } from "../src/types.js";

const info = (over: Partial<ContainerInfo>): ContainerInfo =>
  ({
    name: "sk-x",
    image: "img",
    state: "running",
    created: 0,
    ports: [],
    ...over,
  }) as ContainerInfo;

function managerWith(
  resolve: () => Promise<string | null>,
  list: ContainerInfo[] = [],
): ContainerManagerApi {
  return {
    resolveContainerAddress: vi.fn(resolve),
    listContainers: vi.fn(async () => list),
  } as unknown as ContainerManagerApi;
}

describe("matchesLegacyName", () => {
  it("accepts any lowercase-alphanumeric namespace, not just sk-", () => {
    // A hardcoded `sk-` breaks under SIGNALK_CONTAINER_NAMESPACE, which is
    // exactly the bug the hand-rolled copies carried.
    expect(matchesLegacyName("sk-questdb", "questdb")).toBe(true);
    expect(matchesLegacyName("devpod-questdb", "questdb")).toBe(true);
    expect(matchesLegacyName("questdb", "questdb")).toBe(true);
  });

  it("rejects a non-namespace prefix and a partial suffix", () => {
    expect(matchesLegacyName("my-stack-questdb", "questdb")).toBe(false);
    expect(matchesLegacyName("sk-questdb-old", "questdb")).toBe(false);
    expect(matchesLegacyName("sk-quest", "questdb")).toBe(false);
  });
});

describe("matchContainerInfo", () => {
  it("prefers an exact unprefixedName match regardless of list order", () => {
    const list = [
      info({ name: "sk-questdb", unprefixedName: undefined }),
      info({ name: "devpod-questdb", unprefixedName: "questdb" }),
    ];
    expect(matchContainerInfo(list, "questdb")?.name).toBe("devpod-questdb");
  });

  it("falls back to legacy matching when unprefixedName is absent", () => {
    const list = [info({ name: "sk-questdb", unprefixedName: undefined })];
    expect(matchContainerInfo(list, "questdb")?.name).toBe("sk-questdb");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchContainerInfo([info({ name: "sk-other" })], "questdb")).toBe(
      undefined,
    );
  });
});

describe("resolveContainerEndpoint", () => {
  it("returns the resolver's answer when it has one", async () => {
    const m = managerWith(async () => "127.0.0.1:9000");
    expect(await resolveContainerEndpoint(m, "questdb", 9000)).toBe(
      "127.0.0.1:9000",
    );
  });

  it("falls back to port bindings when the resolver THROWS", async () => {
    // resolveContainerAddress throws when the port was declared but
    // ensureRunning has not run yet — a caller ordering startup differently
    // must degrade, not fail.
    const m = managerWith(async () => {
      throw new Error("call ensureRunning() first");
    }, [
      info({ unprefixedName: "questdb", ports: ["0.0.0.0:33001->9000/tcp"] }),
    ]);
    expect(await resolveContainerEndpoint(m, "questdb", 9000)).toBe(
      "0.0.0.0:33001",
    );
  });

  it("falls back when the resolver returns null (stale cache)", async () => {
    const m = managerWith(
      async () => null,
      [
        info({
          unprefixedName: "questdb",
          ports: ["127.0.0.1:9999->9000/tcp"],
        }),
      ],
    );
    expect(await resolveContainerEndpoint(m, "questdb", 9000)).toBe(
      "127.0.0.1:9999",
    );
  });

  it("only matches the requested port", async () => {
    const m = managerWith(
      async () => null,
      [
        info({
          unprefixedName: "questdb",
          ports: ["127.0.0.1:1111->8812/tcp", "127.0.0.1:2222->9000/tcp"],
        }),
      ],
    );
    expect(await resolveContainerEndpoint(m, "questdb", 9000)).toBe(
      "127.0.0.1:2222",
    );
  });

  it("returns null with no manager, and never throws", async () => {
    expect(
      await resolveContainerEndpoint(undefined, "questdb", 9000),
    ).toBeNull();
    const broken = {
      resolveContainerAddress: async () => {
        throw new Error("boom");
      },
      listContainers: async () => {
        throw new Error("also boom");
      },
    } as unknown as ContainerManagerApi;
    expect(await resolveContainerEndpoint(broken, "questdb", 9000)).toBeNull();
  });

  it("degrades on a manager missing either method", async () => {
    // Feature detection is the norm across this ecosystem; an older manager
    // may not have both. Neither absence may throw.
    const noList = {
      resolveContainerAddress: async () => null,
    } as unknown as ContainerManagerApi;
    expect(await resolveContainerEndpoint(noList, "x", 9000)).toBeNull();

    const noResolve = {
      listContainers: async () => [
        info({ unprefixedName: "x", ports: ["127.0.0.1:7777->9000/tcp"] }),
      ],
    } as unknown as ContainerManagerApi;
    expect(await resolveContainerEndpoint(noResolve, "x", 9000)).toBe(
      "127.0.0.1:7777",
    );
  });

  it("does not match a port that merely ends with the requested digits", async () => {
    // 19000 must not satisfy a request for 9000.
    const m = managerWith(
      async () => null,
      [info({ unprefixedName: "x", ports: ["127.0.0.1:2222->19000/tcp"] })],
    );
    expect(await resolveContainerEndpoint(m, "x", 9000)).toBeNull();
  });

  it("ignores a udp binding for the same port number", async () => {
    const m = managerWith(
      async () => null,
      [info({ unprefixedName: "x", ports: ["127.0.0.1:3333->9000/udp"] })],
    );
    expect(await resolveContainerEndpoint(m, "x", 9000)).toBeNull();
  });

  it("reports both failures through the debug sink", async () => {
    const debug = vi.fn();
    const broken = {
      resolveContainerAddress: async () => {
        throw new Error("boom");
      },
      listContainers: async () => {
        throw new Error("also boom");
      },
    } as unknown as ContainerManagerApi;
    await resolveContainerEndpoint(broken, "questdb", 9000, debug);
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
