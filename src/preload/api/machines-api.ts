import type {
  MachineActionResult,
  MachineConnection,
  MachineProgressEvent,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord,
  MachineTarget
} from '../../shared/machine-inventory'
import type { MachineLifetime } from '../../shared/machine-provider-protocol'

export type MachinesApi = {
  /** Cached inventories; never runs a provider. */
  snapshots: () => Promise<MachineActionResult<MachineProviderSnapshot[]>>
  list: (args: {
    providerKey: MachineProviderKey
    maxAgeMs?: number
    force?: boolean
  }) => Promise<MachineActionResult<MachineProviderSnapshot>>
  get: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  create: (args: {
    providerKey: MachineProviderKey
    operationId: string
    name: string
    lifetime: MachineLifetime
    ttlSeconds?: number
    image?: string
  }) => Promise<MachineActionResult<MachineRecord>>
  cancelCreate: (args: { operationId: string }) => Promise<MachineActionResult<boolean>>
  sleep: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  /** `operationId` tags this wake's `onProgress` events. */
  wake: (
    args: MachineTarget & { operationId?: string }
  ) => Promise<MachineActionResult<MachineRecord>>
  archive: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  delete: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  connect: (
    args: MachineTarget & { operationId?: string }
  ) => Promise<MachineActionResult<MachineConnection>>
  onChanged: (callback: (snapshot: MachineProviderSnapshot) => void) => () => void
  /** Provider stderr for a create, wake or connect the UI tagged with an operationId. */
  onProgress: (callback: (event: MachineProgressEvent) => void) => () => void
}
