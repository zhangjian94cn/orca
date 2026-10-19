import { app, ipcMain } from 'electron'
import type {
  MachineActionResult,
  MachineProviderKey,
  MachineTarget
} from '../../shared/machine-inventory'
import { MachineProviderError, type MachineLifetime } from '../../shared/machine-provider-protocol'
import { createDesktopMachineService } from '../machines/desktop-machine-service'
import type { Store } from '../persistence'
import type { PluginService } from '../plugins/plugin-service'

const CHANNELS = [
  'machines:snapshots',
  'machines:list',
  'machines:get',
  'machines:create',
  'machines:cancelCreate',
  'machines:sleep',
  'machines:wake',
  'machines:archive',
  'machines:delete',
  'machines:connect'
] as const

/** Every action is refused while the experimental flag is off, so nothing runs a provider. */
async function act<T>(store: Store, action: () => Promise<T> | T): Promise<MachineActionResult<T>> {
  if (store.getSettings().experimentalEphemeralVms !== true) {
    return { ok: false, code: 'unsupported', message: 'Machines are not enabled.' }
  }
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof MachineProviderError ? error.code : 'unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function registerMachineHandlers(store: Store, pluginService?: PluginService): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const service = createDesktopMachineService(app.getPath('userData'), pluginService)
  const onTarget =
    (run: (key: MachineProviderKey, machineId: string) => Promise<unknown>) =>
    (_event: unknown, args: MachineTarget) =>
      act(store, () => run(args.providerKey, args.machineId))

  ipcMain.handle('machines:snapshots', () => act(store, () => service.snapshots()))
  ipcMain.handle(
    'machines:list',
    (_event, args: { providerKey: MachineProviderKey; maxAgeMs?: number; force?: boolean }) =>
      act(store, () =>
        service.list(args.providerKey, { maxAgeMs: args.maxAgeMs, force: args.force })
      )
  )
  ipcMain.handle(
    'machines:get',
    onTarget((key, id) => service.get(key, id))
  )
  ipcMain.handle(
    'machines:create',
    (
      _event,
      args: {
        providerKey: MachineProviderKey
        operationId: string
        name: string
        lifetime: MachineLifetime
        ttlSeconds?: number
        image?: string
      }
    ) =>
      act(store, () =>
        service.create(
          args.providerKey,
          {
            name: args.name,
            lifetime: args.lifetime,
            ...(args.ttlSeconds !== undefined ? { ttlSeconds: args.ttlSeconds } : {}),
            ...(args.image !== undefined ? { image: args.image } : {})
          },
          { operationId: args.operationId }
        )
      )
  )
  ipcMain.handle('machines:cancelCreate', (_event, args: { operationId: string }) =>
    service.cancelCreate(args.operationId)
  )
  ipcMain.handle(
    'machines:sleep',
    onTarget((key, id) => service.sleep(key, id))
  )
  ipcMain.handle(
    'machines:wake',
    onTarget((key, id) => service.wake(key, id))
  )
  ipcMain.handle(
    'machines:archive',
    onTarget((key, id) => service.archive(key, id))
  )
  ipcMain.handle(
    'machines:delete',
    onTarget((key, id) => service.delete(key, id))
  )
  ipcMain.handle(
    'machines:connect',
    onTarget((key, id) => service.connect(key, id))
  )
}
