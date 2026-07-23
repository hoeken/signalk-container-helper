import type { AppLike, ContainerManagerApi, UpdateCheckResult } from './types'
import { getContainerManager, waitForContainerManager } from './manager'
import { buildVersionSource, type VersionSourceSpec } from './version-source'
import { errMsg } from './util'

export interface AdoptedContainerOptions {
  app: AppLike
  /** Your plugin id — update-service registration key. */
  pluginId: string
  /**
   * The container's name for display/registration. Adopted containers are
   * usually NOT namespace-prefixed (systemd/Quadlet-managed peers), so
   * manager.getState() cannot see them — probe their HTTP health directly
   * (see probeHttpHealth) instead.
   */
  containerName: string
  /** Image repo without tag. */
  image: string
  /** The tag the deployment pins (e.g. "latest"); string or live getter. */
  currentTag: string | (() => string)
  /**
   * Ask the running app for its honest version (e.g. GET /api/health
   * .version). Preferred over currentTag by the update comparator —
   * essential when currentTag is floating.
   */
  currentVersion?: () => Promise<string | null>
  versionSource: VersionSourceSpec
  /** e.g. "24h" (default), "1h" minimum. */
  checkInterval?: string
  /** Budget for waiting on signalk-container + runtime. Default 30_000. */
  managerTimeoutMs?: number
  /** Poll interval while waiting for the manager global. Default 500. */
  managerPollIntervalMs?: number
}

/**
 * "Adopt, don't manage" integration — the signalk-doctor / signalk-updater
 * archetype. The container's lifecycle is owned elsewhere (systemd Quadlet,
 * external host); the plugin only enrolls it with signalk-container's
 * update-detection service and probes its health over HTTP.
 */
export class AdoptedContainer {
  readonly options: AdoptedContainerOptions
  manager: ContainerManagerApi | undefined

  private registered = false

  constructor(options: AdoptedContainerOptions) {
    this.options = options
  }

  /**
   * Wait for the manager, then register for update detection. Returns false
   * (after setPluginError with an actionable message) when signalk-container
   * or a runtime never becomes available — the plugin can continue degraded.
   * Never throws.
   */
  async register(): Promise<boolean> {
    const {
      app,
      pluginId,
      containerName,
      image,
      currentTag,
      currentVersion,
      versionSource,
      checkInterval,
      managerTimeoutMs = 30_000,
      managerPollIntervalMs = 500
    } = this.options

    const { manager, runtime } = await waitForContainerManager({
      timeoutMs: managerTimeoutMs,
      intervalMs: managerPollIntervalMs
    })
    if (!manager) {
      app.setPluginError(
        'signalk-container is not loaded — install it and restart the server. Update detection is disabled without it.'
      )
      return false
    }
    if (!runtime) {
      app.setPluginError(
        'No container runtime detected (Podman or Docker) — update detection is disabled.'
      )
      return false
    }
    this.manager = manager

    try {
      manager.updates.register({
        pluginId,
        containerName,
        image,
        currentTag: typeof currentTag === 'function' ? currentTag : () => currentTag,
        currentVersion,
        checkInterval,
        versionSource: buildVersionSource(manager.updates, versionSource)
      })
      this.registered = true
      return true
    } catch (err) {
      app.setPluginError(`update registration failed: ${errMsg(err)}`)
      return false
    }
  }

  /** Best-effort deregistration for plugin.stop(). Never throws. */
  unregister(): void {
    if (!this.registered) return
    try {
      ;(this.manager ?? getContainerManager())?.updates.unregister(this.options.pluginId)
    } catch (err) {
      this.options.app.debug(`updates.unregister failed: ${errMsg(err)}`)
    }
    this.registered = false
  }

  /** updates.checkOne — null when the manager is unavailable. */
  async checkForUpdate(): Promise<UpdateCheckResult | null> {
    const manager = this.manager ?? getContainerManager()
    if (!manager) return null
    return manager.updates.checkOne(this.options.pluginId)
  }
}
