import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedContainer } from '../src/managed-container'
import { ContainerHelperError } from '../src/util'
import type { ContainerConfig } from '../src/types'
import {
  clearManager,
  installManager,
  makeApp,
  makeManager,
  okFetch
} from './fixtures'

afterEach(() => {
  clearManager()
})

const IMAGE = 'ghcr.io/example/service'

function makeContainer(overrides: Partial<ConstructorParameters<typeof ManagedContainer>[0]> = {}) {
  const app = makeApp()
  const buildConfig = vi.fn(
    (tag: string): ContainerConfig => ({
      image: IMAGE,
      tag,
      restart: 'unless-stopped',
      signalkAccessiblePorts: [9000]
    })
  )
  const container = new ManagedContainer({
    app,
    pluginId: 'test-plugin',
    name: 'test-service',
    image: IMAGE,
    buildConfig,
    managerTimeoutMs: 100,
    managerPollIntervalMs: 5,
    ...overrides
  })
  return { app, buildConfig, container }
}

describe('ManagedContainer.start', () => {
  it('runs ensureRunning with the built config and default tag', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container, buildConfig } = makeContainer()

    const result = await container.start()

    expect(buildConfig).toHaveBeenCalledWith('latest')
    expect(manager.ensureRunning).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ image: IMAGE, tag: 'latest' }),
      undefined
    )
    expect(result.tag).toBe('latest')
    expect(result.address).toBeNull()
    expect(container.lastStartedTag).toBe('latest')
  })

  it('passes ensureOptions through', async () => {
    const manager = makeManager()
    installManager(manager)
    const onVolumeIssue = vi.fn()
    const { container } = makeContainer({ ensureOptions: { onVolumeIssue } })

    await container.start('1.0.0')

    expect(manager.ensureRunning).toHaveBeenCalledWith(
      'test-service',
      expect.anything(),
      { onVolumeIssue }
    )
  })

  it('applies resolveTag mapping (auto → pinned)', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container, buildConfig } = makeContainer({
      resolveTag: (t) => (t === 'auto' ? '2.5.0' : t)
    })

    const result = await container.start('auto')

    expect(buildConfig).toHaveBeenCalledWith('2.5.0')
    expect(result.tag).toBe('2.5.0')
  })

  it('self-heals via recreate when the live image differs', async () => {
    const manager = makeManager({
      containers: [
        {
          name: 'sk-test-service',
          unprefixedName: 'test-service',
          image: `${IMAGE}:0.9.0`,
          state: 'running'
        }
      ]
    })
    installManager(manager)
    const { container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.recreate).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ tag: '1.0.0' }),
      undefined
    )
    expect(manager.ensureRunning).not.toHaveBeenCalled()
  })

  it('skips self-heal when the live image matches', async () => {
    const manager = makeManager({
      containers: [
        {
          name: 'sk-test-service',
          unprefixedName: 'test-service',
          image: `${IMAGE}:1.0.0`,
          state: 'running'
        }
      ]
    })
    installManager(manager)
    const { container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.recreate).not.toHaveBeenCalled()
    expect(manager.ensureRunning).toHaveBeenCalled()
  })

  it('matches by name suffix (any namespace) when unprefixedName is absent', async () => {
    // The drifted image (0.1.0 vs requested 1.0.0) means the self-heal only
    // fires recreate if this container was actually found by suffix match.
    const manager = makeManager({
      containers: [{ name: 'sk-test-service', image: `${IMAGE}:0.1.0`, state: 'running' }]
    })
    installManager(manager)
    const { container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.recreate).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ image: IMAGE, tag: '1.0.0' }),
      undefined
    )
  })

  it('matches under a non-default namespace (e.g. devpod-) without unprefixedName', async () => {
    // A hard-coded `sk-` guess would miss this container entirely and skip
    // the self-heal recreate. Suffix matching finds it regardless of prefix.
    const manager = makeManager({
      containers: [{ name: 'devpod-test-service', image: `${IMAGE}:0.1.0`, state: 'running' }]
    })
    installManager(manager)
    const { container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.recreate).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ tag: '1.0.0' }),
      undefined
    )
  })

  it('prefers unprefixedName over a suffix-matching decoy, regardless of order', async () => {
    // Decoy (suffix match, no unprefixedName) already at the desired image
    // appears FIRST; the real container (unprefixedName) has a drifted image.
    // Correct precedence recreates; picking the decoy would skip recreate.
    const manager = makeManager({
      containers: [
        { name: 'other-test-service', image: `${IMAGE}:1.0.0`, state: 'running' },
        {
          name: 'devpod-test-service',
          unprefixedName: 'test-service',
          image: `${IMAGE}:0.1.0`,
          state: 'running'
        }
      ]
    })
    installManager(manager)
    const { container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.recreate).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ tag: '1.0.0' }),
      undefined
    )
  })

  it('treats a failed self-heal probe as non-fatal and falls back to ensureRunning', async () => {
    const manager = makeManager()
    manager.listContainers = vi.fn(async () => {
      throw new Error('list failed')
    }) as never
    installManager(manager)
    const { app, container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.ensureRunning).toHaveBeenCalled()
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('self-heal probe failed'))
  })

  it('works against managers without recreate (pre-1.12.0)', async () => {
    const manager = makeManager({ withRecreate: false })
    installManager(manager)
    const { container } = makeContainer()

    await container.start('1.0.0')

    expect(manager.ensureRunning).toHaveBeenCalled()
  })

  it('reports and throws manager-unavailable when the global never appears', async () => {
    const { app, container } = makeContainer()

    const err = await container.start().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ContainerHelperError)
    expect((err as ContainerHelperError).code).toBe('manager-unavailable')
    expect((err as ContainerHelperError).reported).toBe(true)
    expect(app.setPluginError).toHaveBeenCalledWith(expect.stringContaining('signalk-container'))
  })

  it('reports and throws no-runtime when detection failed', async () => {
    installManager(makeManager({ runtime: null }))
    const { app, container } = makeContainer()

    const err = await container.start().catch((e: unknown) => e)

    expect((err as ContainerHelperError).code).toBe('no-runtime')
    expect(app.setPluginError).toHaveBeenCalledWith(expect.stringContaining('runtime'))
  })

  it('rejects invalid tags before touching the runtime', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container } = makeContainer()

    const err = await container.start('bad;tag').catch((e: unknown) => e)

    expect((err as ContainerHelperError).code).toBe('invalid-tag')
    expect(manager.ensureRunning).not.toHaveBeenCalled()
  })

  it('registers with the update service using a live default currentTag', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container } = makeContainer({
      updates: { versionSource: { githubReleases: 'example/service' } }
    })

    await container.start('1.0.0')

    expect(manager.updates.register).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'test-plugin',
        containerName: 'test-service',
        image: IMAGE
      })
    )
    const reg = (manager.updates.register as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      currentTag: () => string
    }
    expect(reg.currentTag()).toBe('1.0.0')
    expect(manager.updates.sources.githubReleases).toHaveBeenCalledWith('example/service', {})
  })

  it('treats update registration failure as non-fatal', async () => {
    const manager = makeManager()
    manager.updates.register = vi.fn(() => {
      throw new Error('nope')
    }) as never
    installManager(manager)
    const { app, container } = makeContainer({
      updates: { versionSource: { dockerHubTags: 'example/service' } }
    })

    await expect(container.start('1.0.0')).resolves.toBeTruthy()
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('updates.register failed'))
  })

  it('resolves the address and waits for HTTP readiness when configured', async () => {
    const manager = makeManager({ resolveAddress: '127.0.0.1:9010' })
    installManager(manager)
    const fetchImpl = okFetch()
    const { container } = makeContainer({
      readiness: { port: 9000, path: '/api/health', maxMs: 200, intervalMs: 5 },
      fetchImpl
    })

    const result = await container.start('1.0.0')

    expect(manager.resolveContainerAddress).toHaveBeenCalledWith('test-service', 9000)
    expect(result.address).toBe('http://127.0.0.1:9010')
    expect(container.address).toBe('http://127.0.0.1:9010')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9010/api/health',
      expect.anything()
    )
  })

  it('falls back to listContainers port parsing when the resolver returns null', async () => {
    const manager = makeManager({
      resolveAddress: null,
      containers: [
        {
          name: 'sk-test-service',
          unprefixedName: 'test-service',
          image: `${IMAGE}:1.0.0`,
          state: 'running',
          ports: ['127.0.0.1:39000->9000/tcp', '0.0.0.0:8080->8080/tcp']
        }
      ]
    })
    installManager(manager)
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 200, intervalMs: 5 },
      fetchImpl: okFetch()
    })

    const result = await container.start('1.0.0')

    expect(result.address).toBe('http://127.0.0.1:39000')
  })

  it('throws address-unresolved when no address can be found', async () => {
    const manager = makeManager({ resolveAddress: null, containers: [] })
    installManager(manager)
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 50, intervalMs: 5 },
      fetchImpl: okFetch()
    })

    const err = await container.start('1.0.0').catch((e: unknown) => e)

    expect((err as ContainerHelperError).code).toBe('address-unresolved')
  })

  it('throws not-ready when the app never answers', async () => {
    const manager = makeManager()
    installManager(manager)
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const { container } = makeContainer({
      readiness: { port: 9000, maxMs: 30, intervalMs: 5 },
      fetchImpl
    })

    const err = await container.start('1.0.0').catch((e: unknown) => e)

    expect((err as ContainerHelperError).code).toBe('not-ready')
  })
})

describe('ManagedContainer.stop', () => {
  it('unregisters updates then stops (not removes) the container', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container } = makeContainer({
      updates: { versionSource: { githubReleases: 'example/service' } }
    })
    await container.start('1.0.0')

    await container.stop()

    expect(manager.updates.unregister).toHaveBeenCalledWith('test-plugin')
    expect(manager.stop).toHaveBeenCalledWith('test-service')
    expect(manager.remove).not.toHaveBeenCalled()
    expect(container.address).toBeNull()
  })

  it('never throws, even when everything fails', async () => {
    const manager = makeManager()
    manager.stop = vi.fn(async () => {
      throw new Error('already stopped')
    }) as never
    installManager(manager)
    const { app, container } = makeContainer()
    await container.start('1.0.0')

    await expect(container.stop()).resolves.toBeUndefined()
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('container stop failed'))
  })

  it('is a no-op without a manager', async () => {
    const { container } = makeContainer()
    await expect(container.stop()).resolves.toBeUndefined()
  })
})

describe('ManagedContainer.applyUpdate', () => {
  it('uses recreate when available', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container } = makeContainer()
    await container.start('1.0.0')

    const result = await container.applyUpdate('2.0.0')

    expect(manager.recreate).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ tag: '2.0.0' }),
      undefined
    )
    expect(manager.pullImage).not.toHaveBeenCalled()
    expect(result.tag).toBe('2.0.0')
    expect(container.lastStartedTag).toBe('2.0.0')
  })

  it('falls back to pull + remove + ensureRunning pre-1.12.0', async () => {
    const manager = makeManager({ withRecreate: false })
    installManager(manager)
    const { container } = makeContainer()
    await container.start('1.0.0')
    ;(manager.ensureRunning as ReturnType<typeof vi.fn>).mockClear()

    await container.applyUpdate('2.0.0')

    expect(manager.pullImage).toHaveBeenCalledWith(`${IMAGE}:2.0.0`)
    expect(manager.remove).toHaveBeenCalledWith('test-service')
    expect(manager.ensureRunning).toHaveBeenCalledWith(
      'test-service',
      expect.objectContaining({ tag: '2.0.0' }),
      undefined
    )
  })

  it('surfaces the recreate-limbo error when the legacy path strands the container', async () => {
    const manager = makeManager({ withRecreate: false })
    installManager(manager)
    const { app, container } = makeContainer()
    await container.start('1.0.0')
    manager.ensureRunning = vi.fn(async () => {
      throw new Error('create failed')
    }) as never

    const err = await container.applyUpdate('2.0.0').catch((e: unknown) => e)

    expect((err as ContainerHelperError).code).toBe('recreate-limbo')
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining('Container removed but recreation failed')
    )
  })

  it('validates the tag', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container } = makeContainer()
    await container.start('1.0.0')

    const err = await container.applyUpdate('$(evil)').catch((e: unknown) => e)
    expect((err as ContainerHelperError).code).toBe('invalid-tag')
    expect(manager.recreate).not.toHaveBeenCalled()
  })
})

describe('ManagedContainer queries', () => {
  it('checkForUpdate proxies updates.checkOne and returns null without a manager', async () => {
    const { container } = makeContainer()
    expect(await container.checkForUpdate()).toBeNull()

    const manager = makeManager()
    installManager(manager)
    const result = await container.checkForUpdate()
    expect(result?.updateAvailable).toBe(true)
    expect(manager.updates.checkOne).toHaveBeenCalledWith('test-plugin')
  })

  it('getInfo returns state and live image, never throwing', async () => {
    const manager = makeManager({
      containers: [
        {
          name: 'sk-test-service',
          unprefixedName: 'test-service',
          image: `${IMAGE}:1.0.0`,
          state: 'running'
        }
      ]
    })
    installManager(manager)
    const { container } = makeContainer()

    expect(await container.getInfo()).toEqual({ state: 'running', image: `${IMAGE}:1.0.0` })
  })

  it('getInfo degrades to unknown without a manager', async () => {
    const { container } = makeContainer()
    expect(await container.getInfo()).toEqual({ state: 'unknown', image: '' })
  })

  it('getLogs feature-detects and returns null when unsupported', async () => {
    const manager = makeManager()
    installManager(manager)
    const { container } = makeContainer()
    expect(await container.getLogs({ tail: 50 })).toEqual(['line1', 'line2'])
    ;(manager as { getLogs?: unknown }).getLogs = undefined
    expect(await container.getLogs()).toBeNull()
  })
})

describe('ManagedContainer.registerUpdateRoutes', () => {
  function makeRouter() {
    const routes = new Map<string, (req: unknown, res: unknown) => unknown>()
    return {
      routes,
      get: vi.fn((path: string, handler: never) => routes.set(`GET ${path}`, handler)),
      post: vi.fn((path: string, handler: never) => routes.set(`POST ${path}`, handler))
    }
  }

  function makeRes() {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code
        return res
      },
      json(body: unknown) {
        res.body = body
      }
    }
    return res
  }

  it('mounts check and apply routes on the default base path', () => {
    const { container } = makeContainer()
    const router = makeRouter()
    container.registerUpdateRoutes(router as never)
    expect(router.routes.has('GET /api/update/check')).toBe(true)
    expect(router.routes.has('POST /api/update/apply')).toBe(true)
  })

  it('check returns 503 without a manager and the result with one', async () => {
    const { container } = makeContainer()
    const router = makeRouter()
    container.registerUpdateRoutes(router as never)
    const handler = router.routes.get('GET /api/update/check')!

    const res503 = makeRes()
    await handler({}, res503)
    expect(res503.statusCode).toBe(503)

    installManager(makeManager())
    const resOk = makeRes()
    await handler({}, resOk)
    expect(resOk.statusCode).toBe(200)
    expect((resOk.body as { updateAvailable: boolean }).updateAvailable).toBe(true)
  })

  it('apply recreates with the requested tag and reports both tags to onApplied', async () => {
    const manager = makeManager()
    installManager(manager)
    const onApplied = vi.fn()
    const { container } = makeContainer({
      resolveTag: (t) => (t === 'auto' ? '3.0.0' : t)
    })
    await container.start('1.0.0')
    const router = makeRouter()
    container.registerUpdateRoutes(router as never, { onApplied })
    const handler = router.routes.get('POST /api/update/apply')!

    const res = makeRes()
    await handler({ body: { tag: 'auto' } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true, tag: '3.0.0' })
    expect(onApplied).toHaveBeenCalledWith('auto', '3.0.0')
  })

  it('apply rejects invalid tags with 400', async () => {
    installManager(makeManager())
    const { container } = makeContainer()
    const router = makeRouter()
    container.registerUpdateRoutes(router as never)
    const handler = router.routes.get('POST /api/update/apply')!

    const res = makeRes()
    await handler({ body: { tag: 'bad tag!' } }, res)
    expect(res.statusCode).toBe(400)
  })

  it('apply surfaces failures as 500 with the error message', async () => {
    const manager = makeManager()
    manager.recreate = vi.fn(async () => {
      throw new Error('pull failed')
    }) as never
    installManager(manager)
    const { app, container } = makeContainer()
    await container.start('1.0.0')
    const router = makeRouter()
    container.registerUpdateRoutes(router as never)
    const handler = router.routes.get('POST /api/update/apply')!

    const res = makeRes()
    await handler({ body: { tag: '2.0.0' } }, res)

    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toContain('pull failed')
    expect(app.setPluginError).toHaveBeenCalledWith(expect.stringContaining('Update failed'))
  })
})
