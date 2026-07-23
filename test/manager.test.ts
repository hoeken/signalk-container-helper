import { afterEach, describe, expect, it, vi } from 'vitest'
import { getContainerManager, waitForContainerManager } from '../src/manager.js'
import { clearManager, installManager, makeManager, RUNTIME } from './fixtures.js'

afterEach(() => {
  clearManager()
})

describe('getContainerManager', () => {
  it('returns undefined when the global is absent', () => {
    expect(getContainerManager()).toBeUndefined()
  })

  it('returns the installed manager', () => {
    const manager = makeManager()
    installManager(manager)
    expect(getContainerManager()).toBe(manager)
  })
})

describe('waitForContainerManager', () => {
  it('resolves immediately when manager and runtime are ready', async () => {
    const manager = makeManager()
    installManager(manager)
    const result = await waitForContainerManager({ timeoutMs: 100, intervalMs: 5 })
    expect(result.manager).toBe(manager)
    expect(result.runtime).toEqual(RUNTIME)
  })

  it('polls until a late manager appears', async () => {
    const manager = makeManager()
    setTimeout(() => installManager(manager), 30)
    const result = await waitForContainerManager({ timeoutMs: 2_000, intervalMs: 5 })
    expect(result.manager).toBe(manager)
    expect(result.runtime).toEqual(RUNTIME)
  })

  it('gives up when no manager ever appears', async () => {
    const onWaiting = vi.fn()
    const result = await waitForContainerManager({ timeoutMs: 40, intervalMs: 5, onWaiting })
    expect(result.manager).toBeUndefined()
    expect(result.runtime).toBeNull()
    expect(onWaiting).toHaveBeenCalledWith('manager')
  })

  it('uses whenReady when the runtime settles asynchronously', async () => {
    const manager = makeManager()
    let runtime: typeof RUNTIME | null = null
    manager.getRuntime = vi.fn(() => runtime) as never
    manager.whenReady = vi.fn(async () => {
      runtime = RUNTIME
    }) as never
    installManager(manager)
    const result = await waitForContainerManager({ timeoutMs: 500, intervalMs: 5 })
    expect(manager.whenReady).toHaveBeenCalled()
    expect(result.runtime).toEqual(RUNTIME)
  })

  it('reports runtime failure distinctly (manager present, runtime null)', async () => {
    const manager = makeManager({ runtime: null })
    installManager(manager)
    const result = await waitForContainerManager({ timeoutMs: 60, intervalMs: 5 })
    expect(result.manager).toBe(manager)
    expect(result.runtime).toBeNull()
  })

  it('falls back to polling getRuntime when whenReady is missing (pre-1.6.0)', async () => {
    const manager = makeManager()
    let runtime: typeof RUNTIME | null = null
    manager.getRuntime = vi.fn(() => runtime) as never
    ;(manager as { whenReady?: unknown }).whenReady = undefined
    installManager(manager)
    setTimeout(() => {
      runtime = RUNTIME
    }, 25)
    const result = await waitForContainerManager({ timeoutMs: 2_000, intervalMs: 5 })
    expect(result.runtime).toEqual(RUNTIME)
  })
})
