// Type-level contract test. This file is checked by `tsc` (via the
// `typecheck` script and vitest's typecheck mode), NOT executed — the
// assertions below fail COMPILATION if this library's hand-written type
// mirror drifts from signalk-container's published `signalk-container/types`
// surface (1.23.0+). Consumers of this library take no transitive
// signalk-container dependency, because the mirror stays defined locally in
// src/types.ts; only this dev-time check imports the canonical types.
import type {
  ConsumerManifest as CanonicalConsumerManifest,
  ContainerManifestEntry as CanonicalContainerManifestEntry,
  HistoryEntry as CanonicalHistoryEntry,
  ContainerConfig as CanonicalContainerConfig,
  ContainerInfo as CanonicalContainerInfo,
  ContainerState as CanonicalContainerState,
  VolumeIssue as CanonicalVolumeIssue,
  ContainerResourceLimits as CanonicalContainerResourceLimits,
  UpdateRegistration as CanonicalUpdateRegistration,
  UpdateCheckResult as CanonicalUpdateCheckResult,
  UpdateReason as CanonicalUpdateReason,
  TagKind as CanonicalTagKind,
  VersionSource as CanonicalVersionSource,
  VersionSourceResult as CanonicalVersionSourceResult,
  UpdateServiceApi as CanonicalUpdateServiceApi
} from 'signalk-container/types'
import type {
  ConsumerManifest,
  HistoryEntry,
  ContainerConfig,
  ContainerInfo,
  ContainerState,
  VolumeIssue,
  ContainerResourceLimits,
  UpdateRegistration,
  UpdateCheckResult,
  UpdateReason,
  TagKind,
  VersionSource,
  VersionSourceResult,
  UpdateServiceApi
} from '../src/types.js'

// Exact structural equality: resolves to `true` only when A and B are
// mutually assignable, `false` otherwise.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

// `Expect<T>` only accepts `true`; feeding it a `false` (types differ) or a
// non-assignable pair is a COMPILE ERROR — that is what makes drift fail CI.
type Expect<T extends true> = T
type Assignable<Sub extends Super, Super = Sub> = Sub

// --- Persisted data shapes: MUST be byte-identical. A mismatch would ---
// --- silently corrupt manifest reads across the boundary.            ---
export type _Manifest = Expect<Equals<ConsumerManifest, CanonicalConsumerManifest>>
export type _History = Expect<Equals<HistoryEntry, CanonicalHistoryEntry>>
export type _State = Expect<Equals<ContainerState, CanonicalContainerState>>

// --- The helper's ConsumerManifest inlines the per-container entry;   ---
// --- assert that inlined shape equals the canonical named entry.      ---
export type _Entry = Expect<
  Equals<ConsumerManifest['containers'][string], CanonicalContainerManifestEntry>
>

// --- Directional shapes: our types only need to be compatible in the ---
// --- direction data actually flows across the manager boundary. A    ---
// --- non-assignable pair violates the `Sub extends Super` bound.      ---
// ContainerConfig flows INTO signalk-container (ensureRunning input).
export type _Config = Assignable<ContainerConfig, CanonicalContainerConfig>
// ContainerInfo flows OUT of signalk-container (listContainers result).
export type _Info = Assignable<CanonicalContainerInfo, ContainerInfo>
// VolumeIssue flows OUT (onVolumeIssue callback payload).
export type _Volume = Assignable<CanonicalVolumeIssue, VolumeIssue>
// ContainerResourceLimits flows INTO signalk-container (config input).
export type _Limits = Assignable<
  ContainerResourceLimits,
  CanonicalContainerResourceLimits
>

// --- Update-service types (signalk-container/types 1.23.1+). The value ---
// --- data shapes are asserted byte-identical; the enums too.          ---
export type _UpdateReason = Expect<Equals<UpdateReason, CanonicalUpdateReason>>
export type _TagKind = Expect<Equals<TagKind, CanonicalTagKind>>
export type _VersionSourceResult = Expect<
  Equals<VersionSourceResult, CanonicalVersionSourceResult>
>
// VersionSource is directional, not equal: its `fetch(runtime)` parameter is
// ContainerRuntimeInfo, which our mirror intentionally softens (the
// deprecated `isPodmanDockerShim` is optional here, required upstream). A
// consumer SUPPLIES a VersionSource and signalk-container CALLS it, so ours
// must be assignable to the canonical one.
export type _VersionSource = Assignable<VersionSource, CanonicalVersionSource>
// UpdateRegistration flows INTO the service (register input): ours must be
// assignable to canonical. UpdateCheckResult flows OUT (checkOne result):
// canonical must be assignable to ours.
export type _UpdateRegistration = Assignable<
  UpdateRegistration,
  CanonicalUpdateRegistration
>
export type _UpdateCheckResult = Assignable<
  CanonicalUpdateCheckResult,
  UpdateCheckResult
>
// UpdateServiceApi is NOT asserted equal on purpose: our mirror types
// `sources.githubReleases(repo, { …, token })`, matching the real
// implementation (GithubReleasesOptions accepts `token`), but signalk-
// container's *interface* under-declares that option (it re-inlines a stale
// `{ allowPrerelease?, tagPrefix? }` subset). So our type is a correct
// superset. We assert the canonical service is USABLE through ours — a
// consumer that only calls the declared surface still type-checks — rather
// than force a false equality. See signalk-container updates/types.ts.
export type _UpdateServiceApi = Assignable<
  CanonicalUpdateServiceApi,
  UpdateServiceApi
>
