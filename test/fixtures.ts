import { vi } from 'vitest'
import type {
  AppLike,
  ContainerInfo,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  UpdateCheckResult,
  VersionSource
} from '../src/types.js'

export const RUNTIME: ContainerRuntimeInfo = {
  runtime: 'podman',
  version: '5.4.2',
  isRootless: true
}

export function makeApp() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn()
  } satisfies AppLike & Record<string, ReturnType<typeof vi.fn>>
}

export const FAKE_SOURCE: VersionSource = {
  fetch: async () => ({ kind: 'version', latest: '1.2.3' })
}

export function makeCheckResult(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    pluginId: 'test-plugin',
    containerName: 'test-service',
    runningTag: '1.0.0',
    tagKind: 'semver',
    currentVersion: '1.0.0',
    latestVersion: '1.2.3',
    updateAvailable: true,
    reason: 'newer-version',
    checkedAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    fromCache: false,
    ...overrides
  }
}

export interface FakeManagerSetup {
  runtime?: ContainerRuntimeInfo | null
  containers?: ContainerInfo[]
  /** Include the optional recreate method (1.12.0+). Default true. */
  withRecreate?: boolean
  resolveAddress?: string | null
}

/** A fully-mocked ContainerManagerApi backed by vi.fn()s. */
export function makeManager(setup: FakeManagerSetup = {}) {
  const {
    runtime = RUNTIME,
    containers = [],
    withRecreate = true,
    resolveAddress = '127.0.0.1:9000'
  } = setup

  const manager = {
    getRuntime: vi.fn(() => runtime),
    whenReady: vi.fn(async () => {}),
    pullImage: vi.fn(async () => {}),
    imageExists: vi.fn(async () => true),
    getImageDigest: vi.fn(async () => null),
    ensureRunning: vi.fn(async () => {}),
    ...(withRecreate ? { recreate: vi.fn(async () => {}) } : {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getState: vi.fn(async () => 'running' as const),
    listContainers: vi.fn(async () => containers),
    updateResources: vi.fn(async () => ({ method: 'live' as const })),
    getResources: vi.fn(() => ({})),
    resolveContainerAddress: vi.fn(async () => resolveAddress),
    runJob: vi.fn(async () => ({
      id: 'job-1',
      status: 'completed' as const,
      image: 'x',
      command: [],
      log: [],
      createdAt: new Date().toISOString()
    })),
    getLogs: vi.fn(async () => ['line1', 'line2']),
    cleanupOrphanedJobs: vi.fn(async () => ({ reaped: [] })),
    prune: vi.fn(async () => ({ imagesRemoved: 0, spaceReclaimed: '0 B' })),
    updates: {
      register: vi.fn(),
      unregister: vi.fn(),
      checkOne: vi.fn(async () => makeCheckResult()),
      checkAll: vi.fn(async () => []),
      getLastResult: vi.fn(() => null),
      sources: {
        githubReleases: vi.fn(() => FAKE_SOURCE),
        dockerHubTags: vi.fn(() => FAKE_SOURCE)
      }
    }
  }
  return manager as unknown as ContainerManagerApi & typeof manager
}

export function installManager(manager: ContainerManagerApi | undefined): void {
  ;(globalThis as { __signalk_containerManager?: ContainerManagerApi }).__signalk_containerManager =
    manager
}

export function clearManager(): void {
  delete (globalThis as { __signalk_containerManager?: ContainerManagerApi })
    .__signalk_containerManager
}

/** fetchImpl that answers ok for every request. */
export function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
}

/** fetchImpl that fails `failures` times, then answers ok. */
export function flakyFetch(failures: number) {
  let count = 0
  return vi.fn(async () => {
    if (count++ < failures) throw new Error('ECONNREFUSED')
    return { ok: true, status: 200, json: async () => ({}) }
  })
}
