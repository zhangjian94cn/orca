import { MachineProviderError, type ProviderMachine } from '../../shared/machine-provider-protocol'
import type {
  MachineProviderFailure,
  MachineProviderInventory,
  MachineProviderKey,
  MachineRecord
} from '../../shared/machine-inventory'

export function findRecord(
  inventory: MachineProviderInventory,
  machineId: string
): MachineRecord | undefined {
  return inventory.machines.find((record) => record.id === machineId)
}

export function requireRecord(
  inventory: MachineProviderInventory,
  machineId: string
): MachineRecord {
  const record = findRecord(inventory, machineId)
  if (!record) {
    throw new MachineProviderError('not-found', `No machine ${machineId}.`)
  }
  return record
}

/** Undefined patch fields drop out when the store is serialized. */
export function patchRecord(
  inventory: MachineProviderInventory,
  machineId: string,
  patch: Partial<MachineRecord>
): MachineRecord {
  const existing = requireRecord(inventory, machineId)
  const next: MachineRecord = { ...existing, ...patch }
  inventory.machines = inventory.machines.map((entry) => (entry === existing ? next : entry))
  return next
}

export function applyMachine(
  inventory: MachineProviderInventory,
  providerKey: MachineProviderKey,
  machine: ProviderMachine,
  now: number
): MachineRecord {
  const existing = findRecord(inventory, machine.id)
  // Providers may stop reporting the create key once running; keep it for reconcile.
  const creatingOperationId = machine.creatingOperationId ?? existing?.creatingOperationId
  const record: MachineRecord = {
    ...machine,
    providerKey,
    lastSeenAt: now,
    ...(creatingOperationId ? { creatingOperationId } : {}),
    ...(existing?.sshTargetId ? { sshTargetId: existing.sshTargetId } : {}),
    ...(existing?.runtimeEnvironmentId
      ? { runtimeEnvironmentId: existing.runtimeEnvironmentId }
      : {})
  }
  inventory.machines = existing
    ? inventory.machines.map((entry) => (entry === existing ? record : entry))
    : [...inventory.machines, record]
  return record
}

export function applyInventory(
  inventory: MachineProviderInventory,
  providerKey: MachineProviderKey,
  machines: readonly ProviderMachine[],
  now: number
): void {
  const listed = new Set(machines.map((machine) => machine.id))
  for (const machine of machines) {
    applyMachine(inventory, providerKey, machine, now)
  }
  // Absent from a successful list: gone. Rows nothing points at are simply dropped.
  inventory.machines = inventory.machines.flatMap((record) =>
    listed.has(record.id)
      ? [record]
      : record.sshTargetId || record.runtimeEnvironmentId
        ? [{ ...record, state: 'gone' as const, access: undefined }]
        : []
  )
  const created = new Set(inventory.machines.map((machine) => machine.creatingOperationId))
  inventory.pendingCreates = inventory.pendingCreates.filter(
    (pending) => !created.has(pending.operationId)
  )
  inventory.listedAt = now
  inventory.lastFailure = undefined
}

/** Loss of contact: the machine may well still exist, so it is unreachable, never gone. */
export function markUnreachable(
  inventory: MachineProviderInventory,
  machineId: string,
  error: unknown
): void {
  const record = findRecord(inventory, machineId)
  if (record && record.state !== 'gone') {
    patchRecord(inventory, machineId, { state: 'unreachable', lastError: messageOf(error) })
  }
}

export function markGone(inventory: MachineProviderInventory, machineId: string): MachineRecord {
  return patchRecord(inventory, machineId, { state: 'gone', access: undefined })
}

export function dropPendingCreate(inventory: MachineProviderInventory, operationId: string): void {
  inventory.pendingCreates = inventory.pendingCreates.filter(
    (pending) => pending.operationId !== operationId
  )
}

/** Pairing codes are credentials; clients only need to know the access kind. */
export function redactPairingCode(record: MachineRecord): MachineRecord {
  return record.access?.kind === 'orca-server'
    ? { ...record, access: { ...record.access, pairingCode: '' } }
    : record
}

export function failureOf(error: unknown, at: number): MachineProviderFailure {
  return {
    code: error instanceof MachineProviderError ? error.code : 'unavailable',
    message: messageOf(error),
    at
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
