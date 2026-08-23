import { describe, it, expect, vi } from "vitest";
import {
  matchContainerInfo,
  matchesLegacyName,
  resolveContainerAddress,
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

describe("resolveContainerAddress", () => {
  it("returns the resolver's answer when it has one", async () => {
    const m = managerWith(async () => "127.0.0.1:9000");
    expect(await resolveContainerAddress(m, "questdb", 9000)).toBe(
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
    expect(await resolveContainerAddress(m, "questdb", 9000)).toBe(
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
    expect(await resolveContainerAddress(m, "questdb", 9000)).toBe(
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
    expect(await resolveContainerAddress(m, "questdb", 9000)).toBe(
      "127.0.0.1:2222",
    );
  });

  it("returns null with no manager, and never throws", async () => {
    expect(
      await resolveContainerAddress(undefined, "questdb", 9000),
    ).toBeNull();
    const broken = {
      resolveContainerAddress: async () => {
        throw new Error("boom");
      },
      listContainers: async () => {
        throw new Error("also boom");
      },
    } as unknown as ContainerManagerApi;
    expect(await resolveContainerAddress(broken, "questdb", 9000)).toBeNull();
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
    await resolveContainerAddress(broken, "questdb", 9000, debug);
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
