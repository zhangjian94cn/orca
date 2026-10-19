import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import type { MachineInventoryStore } from '../../shared/machine-inventory'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

const MACHINE_INVENTORY_FILE = 'orca-machines.json'
const MAX_MACHINE_INVENTORY_BYTES = 4 * 1024 * 1024

// Shallow on purpose: this build wrote the rows, and unknown fields from a newer build must survive.
const storeSchema = z.object({
  version: z.literal(1),
  providers: z.record(
    z.string(),
    z
      .object({
        machines: z.array(z.object({ id: z.string(), providerKey: z.string() }).passthrough()),
        pendingCreates: z.array(z.object({ operationId: z.string() }).passthrough())
      })
      .passthrough()
  )
})

export function getMachineInventoryStorePath(userDataPath: string): string {
  return join(userDataPath, MACHINE_INVENTORY_FILE)
}

export function emptyMachineInventoryStore(): MachineInventoryStore {
  return { version: 1, providers: {} }
}

export function readMachineInventoryStore(userDataPath: string): MachineInventoryStore {
  try {
    const { buffer } = readNodeFileSyncWithinLimit(
      getMachineInventoryStorePath(userDataPath),
      MAX_MACHINE_INVENTORY_BYTES,
      { regularFileOnly: true }
    )
    const parsed = storeSchema.safeParse(JSON.parse(buffer.toString('utf8')))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this module writes the file, from a MachineInventoryStore; the schema checks the shape every reader indexes into.
    return parsed.success ? (parsed.data as MachineInventoryStore) : emptyMachineInventoryStore()
  } catch {
    // Missing or unreadable: rows are a cache of provider state and refill on the next list.
    return emptyMachineInventoryStore()
  }
}

export function writeMachineInventoryStore(
  userDataPath: string,
  store: MachineInventoryStore
): void {
  writeSecureJsonFileWithinLimit(
    getMachineInventoryStorePath(userDataPath),
    store,
    MAX_MACHINE_INVENTORY_BYTES,
    { durable: true }
  )
}
