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
  UpdateServiceApi as CanonicalUpdateServiceApi,
  NofileLimits as CanonicalNofileLimits,
  SelfDeploymentResult as CanonicalSelfDeploymentResult,
  SelfDeploymentStatus as CanonicalSelfDeploymentStatus,
} from "signalk-container/types";
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
  UpdateServiceApi,
  NofileLimits,
  SelfDeploymentResult,
  SelfDeploymentStatus,
} from "../src/types.js";

// Exact structural equality: resolves to `true` only when A and B are
// mutually assignable, `false` otherwise.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// `Expect<T>` only accepts `true`; feeding it a `false` (types differ) or a
// non-assignable pair is a COMPILE ERROR — that is what makes drift fail CI.
type Expect<T extends true> = T;
type Assignable<Sub extends Super, Super = Sub> = Sub;

// --- Persisted data shapes: MUST be byte-identical. A mismatch would ---
// --- silently corrupt manifest reads across the boundary.            ---
export type _Manifest = Expect<
  Equals<ConsumerManifest, CanonicalConsumerManifest>
>;
export type _History = Expect<Equals<HistoryEntry, CanonicalHistoryEntry>>;
export type _State = Expect<Equals<ContainerState, CanonicalContainerState>>;

// --- The helper's ConsumerManifest inlines the per-container entry;   ---
// --- assert that inlined shape equals the canonical named entry.      ---
export type _Entry = Expect<
  Equals<
    ConsumerManifest["containers"][string],
    CanonicalContainerManifestEntry
  >
>;

// --- Directional shapes: our types only need to be compatible in the ---
// --- direction data actually flows across the manager boundary. A    ---
// --- non-assignable pair violates the `Sub extends Super` bound.      ---
// ContainerConfig flows INTO signalk-container (ensureRunning input).
// Pending-release members mirrored AHEAD of the installed devDep
// (`devices`/`groupAdd`, signalk-container 1.24.0 vs ^1.23.2 here) are
// covered by this direction as-is: extra OPTIONAL properties never break
// Sub-to-Super assignability, and older managers ignore the unknown keys
// at runtime. Once the 1.24.0 types publish, the same assertion starts
// checking those members' shapes for real — no exclusion needed.
export type _Config = Assignable<ContainerConfig, CanonicalContainerConfig>;
// ContainerInfo flows OUT of signalk-container (listContainers result).
export type _Info = Assignable<CanonicalContainerInfo, ContainerInfo>;
// VolumeIssue flows OUT (onVolumeIssue callback payload).
export type _Volume = Assignable<CanonicalVolumeIssue, VolumeIssue>;
// ContainerResourceLimits flows INTO signalk-container (config input).
export type _Limits = Assignable<
  ContainerResourceLimits,
  CanonicalContainerResourceLimits
>;

// --- Update-service types (signalk-container/types 1.23.1+). The value ---
// --- data shapes are asserted byte-identical; the enums too.          ---
export type _UpdateReason = Expect<Equals<UpdateReason, CanonicalUpdateReason>>;
export type _TagKind = Expect<Equals<TagKind, CanonicalTagKind>>;
// getContainerNofile's return shape (signalk-container 1.25.3+). Mirrored so
// consumers can feature-detect the probe without redeclaring the type — a
// gap here is what pushes a plugin back to hand-written interfaces.
export type _NofileLimits = Expect<Equals<NofileLimits, CanonicalNofileLimits>>;
// The doctor's verdict. This mirror carried only status/remediation behind an
// index signature, so `isContainerized` — the field the probe exists for —
// typed as `unknown` while the interface looked complete. Nothing failed,
// because nothing asserted it (see #27).
export type _SelfDeploymentStatus = Expect<
  Equals<SelfDeploymentStatus, CanonicalSelfDeploymentStatus>
>;
export type _SelfDeploymentResult = Expect<
  Equals<SelfDeploymentResult, CanonicalSelfDeploymentResult>
>;
export type _VersionSourceResult = Expect<
  Equals<VersionSourceResult, CanonicalVersionSourceResult>
>;
// VersionSource is directional, not equal: its `fetch(runtime)` parameter is
// ContainerRuntimeInfo, which our mirror intentionally softens (the
// deprecated `isPodmanDockerShim` is optional here, required upstream). A
// consumer SUPPLIES a VersionSource and signalk-container CALLS it, so ours
// must be assignable to the canonical one.
export type _VersionSource = Assignable<VersionSource, CanonicalVersionSource>;
// UpdateRegistration flows INTO the service (register input): ours must be
// assignable to canonical. UpdateCheckResult flows OUT (checkOne result):
// canonical must be assignable to ours.
export type _UpdateRegistration = Assignable<
  UpdateRegistration,
  CanonicalUpdateRegistration
>;
export type _UpdateCheckResult = Assignable<
  CanonicalUpdateCheckResult,
  UpdateCheckResult
>;
// UpdateServiceApi is asserted directionally, not equal, because it embeds
// ContainerRuntimeInfo — via `sources.*(): VersionSource` whose
// `fetch(runtime)` parameter is ContainerRuntimeInfo, and via
// `register(reg: UpdateRegistration)` whose versionSource does the same. Our
// mirror intentionally softens ContainerRuntimeInfo (the deprecated
// `isPodmanDockerShim` is optional here, required upstream; upstream's
// deprecated `remoteSocketUrl` is omitted here), so exact equality can never
// hold and shouldn't be forced. We assert the canonical service is USABLE
// through ours instead — a consumer calling the declared surface type-checks.
// (The `token` option gap that once also blocked equality was fixed in
// signalk-container 1.23.2.)
export type _UpdateServiceApi = Assignable<
  CanonicalUpdateServiceApi,
  UpdateServiceApi
>;
