import type { UpdateServiceApi, VersionSource } from "./types.js";

/**
 * Declarative version-source description, resolved against
 * `manager.updates.sources` at registration time so callers don't need the
 * manager in hand while declaring their options.
 */
export type VersionSourceSpec =
  | {
      /** GitHub repo, e.g. "questdb/questdb". */
      githubReleases: string;
      allowPrerelease?: boolean;
      tagPrefix?: string;
      /** Personal access token — lifts the 60/hr anonymous rate limit. */
      token?: string;
    }
  | {
      /** Docker Hub image, e.g. "questdb/questdb". */
      dockerHubTags: string;
      filter?: (tag: string) => boolean;
    }
  | {
      /** Bring your own VersionSource implementation. */
      custom: VersionSource;
    };

export function buildVersionSource(
  updates: UpdateServiceApi,
  spec: VersionSourceSpec,
): VersionSource {
  if ("custom" in spec) {
    return spec.custom;
  }
  if ("githubReleases" in spec) {
    const { githubReleases, ...options } = spec;
    return updates.sources.githubReleases(githubReleases, options);
  }
  const { dockerHubTags, ...options } = spec;
  return updates.sources.dockerHubTags(dockerHubTags, options);
}
