// The managed/self-hosted seam.
//
// A container-backed plugin reaches its service in one of two ways: through a
// container signalk-container manages for it, or over the network at an address
// the operator supplied ("self-hosted"). The transport half of those two is
// identical — a base URL in, an HTTP client out — but every consumer currently
// re-derives the mode branch, the empty-URL guard and the readiness wait.
//
// Scope note: "self-hosted" means a SERVICE on another host, never a container
// ENGINE on another host. signalk-container talks to local unix sockets only
// and throws on a tcp:// endpoint, so there is no remote-engine mode to model.

import type { ManagedContainer } from "./managed-container.js";
import type { FetchLike } from "./http.js";
import { waitForHttpReady } from "./http.js";
import { retryForever, type RetryForeverOptions } from "./retry.js";
import { ContainerHelperError } from "./util.js";
import { normalizeExternalUrl } from "./url.js";

export type EndpointMode = "managed" | "external";

export interface ResolvedEndpoint {
  mode: EndpointMode;
  /** Scheme-ful base with no trailing slash — append absolute paths to it. */
  baseUrl: string;
  /**
   * `host:port` — as the container manager reports it in managed mode, or as
   * the operator's URL resolved to in self-hosted mode. A bare `host` when no
   * port was given and none was defaulted. Never null in practice today; the
   * type keeps the door open for a manager that cannot answer.
   */
  address: string | null;
  /** The container, in managed mode only — null when self-hosted. */
  container: ManagedContainer | null;
}

export interface ResolveEndpointOptions {
  /**
   * The raw config value. `undefined` MUST mean managed: Signal K calls
   * `start()` with `{}` when a plugin is enabled without ever saving its form,
   * and treating that as self-hosted would break every such install.
   */
  managed: boolean | undefined;
  /** Raw operator input; normalised internally. Self-hosted mode only. */
  externalUrl?: string;
  /** Required in managed mode. Pass one that has already been started. */
  container?: ManagedContainer;
  /** Container port to resolve in managed mode. */
  port?: number;
  /** Product noun for error copy, e.g. "backup-server". */
  productName: string;
  /** Config key named in the empty-URL error. Default "externalUrl". */
  urlFieldName?: string;
  /** Port assumed when the external URL carries none. */
  defaultPort?: number;
}

/**
 * Whether the plugin owns its container's lifecycle.
 *
 * `undefined` means managed — Signal K hands `plugin.start()` an empty object
 * when a plugin is enabled without its form ever being saved, so a plain
 * `Boolean(managed)` would silently flip those installs into self-hosted mode
 * with an empty URL: a plugin that used to just work now errors on enable.
 *
 * Exported because most call sites are route handlers and status fields that
 * only need the mode question, not a resolved endpoint. Naming the rule makes
 * it greppable and keeps the UI and the runtime from drifting apart.
 */
export function isManagedMode(managed: boolean | undefined): boolean {
  return managed !== false;
}

/**
 * Resolve the base URL for whichever mode the config selects.
 *
 * Throws `ContainerHelperError` rather than returning a failure union: every
 * consumer's existing branch is `setPluginError(...); return`, and throwing
 * lets `startSafely` do that uniformly. `reported` is left false so the
 * message — which matches the copy the plugins already show — is surfaced.
 *
 * Readiness is NOT waited for here; that is `waitForEndpointReady`, so the
 * retry policy stays a caller decision.
 */
export async function resolveEndpoint(
  options: ResolveEndpointOptions,
): Promise<ResolvedEndpoint> {
  const {
    managed,
    externalUrl,
    container,
    port,
    productName,
    urlFieldName = "externalUrl",
    defaultPort,
  } = options;

  if (!isManagedMode(managed)) {
    const normalized = normalizeExternalUrl(externalUrl, { defaultPort });
    if (!normalized) {
      // The empty and malformed cases get different copy: one is "you haven't
      // finished configuring", the other "what you typed cannot work".
      const typed = typeof externalUrl === "string" ? externalUrl.trim() : "";
      throw typed
        ? new ContainerHelperError(
            "external-url-invalid",
            `${productName}: ${urlFieldName} is not a valid http(s) URL: "${typed}". ` +
              `Expected something like http://192.168.1.50:3010.`,
          )
        : new ContainerHelperError(
            "external-url-missing",
            `managedContainer is disabled but ${urlFieldName} is empty. ` +
              `Set ${urlFieldName} in plugin config.`,
          );
    }
    return {
      mode: "external",
      baseUrl: normalized.baseUrl,
      address: normalized.address,
      container: null,
    };
  }

  if (!container) {
    throw new ContainerHelperError(
      "invalid-option",
      `${productName}: resolveEndpoint requires a ManagedContainer in managed mode.`,
    );
  }
  if (typeof port !== "number") {
    throw new ContainerHelperError(
      "invalid-option",
      `${productName}: resolveEndpoint requires a port in managed mode.`,
    );
  }

  // resolveAddress never throws — it already absorbs the case where
  // resolveContainerAddress rejects because ensureRunning has not run yet.
  const address = await container.resolveAddress(port);
  if (!address) {
    throw new ContainerHelperError(
      "address-unresolved",
      `Could not resolve address for ${productName} port ${port}. ` +
        `Declare the port in signalkAccessiblePorts.`,
    );
  }

  return {
    mode: "managed",
    baseUrl: `http://${address}`,
    address,
    container,
  };
}

export interface EndpointReadyOptions {
  /** Probe path appended to the base URL. Default "/". */
  path?: string;
  /** Deadline for one readiness attempt. Default 15_000. */
  maxMs?: number;
  /** Delay between polls within an attempt. */
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /**
   * When present, wrap the readiness wait in `retryForever` with these
   * options. ABSENT MEANS ONE ATTEMPT, then throw.
   *
   * Not defaulted on, and that is deliberate: the reference plugins genuinely
   * differ here — one retries forever because an unattended boat must heal
   * itself, another reports the error once and waits for the operator. Baking
   * either in would change the other's behaviour under cover of a refactor.
   */
  retry?: RetryForeverOptions;
}

/**
 * Wait until the endpoint answers 2xx. Same call in both modes — the mode
 * difference is already spent by the time there is a base URL.
 */
export async function waitForEndpointReady(
  endpoint: ResolvedEndpoint,
  options: EndpointReadyOptions = {},
): Promise<void> {
  const { path = "/", retry, ...wait } = options;
  const url = `${endpoint.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const attempt = () =>
    waitForHttpReady(url, {
      maxMs: wait.maxMs ?? 15_000,
      intervalMs: wait.intervalMs,
      requestTimeoutMs: wait.requestTimeoutMs,
      fetchImpl: wait.fetchImpl,
      signal: wait.signal,
    });

  if (!retry) {
    await attempt();
    return;
  }
  await retryForever(attempt, retry);
}

/** Convenience for status fields and route guards. */
export function describeEndpoint(endpoint: ResolvedEndpoint): string {
  return endpoint.mode === "managed"
    ? `managed container at ${endpoint.baseUrl}`
    : `external service at ${endpoint.baseUrl}`;
}
