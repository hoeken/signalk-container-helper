import { describe, expect, it, vi } from 'vitest'
import {
  ContainerHelperError,
  errMsg,
  isValidImageTag,
  startSafely
} from '../src/util.js'
import { makeApp } from './fixtures.js'

describe('isValidImageTag', () => {
  it('accepts typical tags', () => {
    for (const tag of ['latest', '1.2.3', 'v1.2.3-rc.1', 'main', 'sha_2024', '9.0']) {
      expect(isValidImageTag(tag)).toBe(true)
    }
  })

  it('rejects dangerous or malformed values', () => {
    for (const tag of ['', ' ', 'a b', 'tag;rm -rf /', 'a/b', 'a:b', '$(x)', null, 42, 'x'.repeat(200)]) {
      expect(isValidImageTag(tag as never)).toBe(false)
    }
  })
})

describe('errMsg', () => {
  it('unwraps Error messages and stringifies the rest', () => {
    expect(errMsg(new Error('boom'))).toBe('boom')
    expect(errMsg('plain')).toBe('plain')
    expect(errMsg(42)).toBe('42')
  })
})

describe('startSafely', () => {
  it('reports unexpected errors via setPluginError', async () => {
    const app = makeApp()
    startSafely(app, async () => {
      throw new Error('kaboom')
    })
    await vi.waitFor(() => {
      expect(app.setPluginError).toHaveBeenCalledWith('Startup failed: kaboom')
    })
  })

  it('does not re-report ContainerHelperErrors already reported', async () => {
    const app = makeApp()
    startSafely(app, async () => {
      throw new ContainerHelperError('no-runtime', 'no runtime', true)
    })
    await vi.waitFor(() => {
      expect(app.debug).toHaveBeenCalled()
    })
    expect(app.setPluginError).not.toHaveBeenCalled()
  })

  it('re-reports ContainerHelperErrors not yet reported', async () => {
    const app = makeApp()
    startSafely(app, async () => {
      throw new ContainerHelperError('invalid-tag', 'bad tag', false)
    })
    await vi.waitFor(() => {
      expect(app.setPluginError).toHaveBeenCalledWith('Startup failed: bad tag')
    })
  })
})
