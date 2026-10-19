import type {
  MachineConnection,
  MachineProviderKey,
  MachineRecord
} from '../../shared/machine-inventory'
import {
  MachineProviderError,
  type MachineAccess,
  type ProviderMachine
} from '../../shared/machine-provider-protocol'
import {
  connectMachineOrcaServer,
  connectMachineSsh,
  machineEndpointChanged,
  machineSshTargetId,
  type MachinePairing,
  type MachineSshConnectResult,
  type MachineSshTargets
} from './machine-connect'
import { findRecord, markUnreachable, patchRecord } from './machine-inventory-records'
import type { MachineProviderClient, MachineProviderEntry } from './machine-provider-client'

type MachineFetch = (
  providerKey: MachineProviderKey,
  machineId: string,
  onStderr?: (chunk: string) => void
) => Promise<{ record: MachineRecord; machine?: ProviderMachine }>

/**
 * Connects a machine's access. A failure never removes its SSH target; it marks the machine
 * unreachable, and a failure on cached access asks the provider once in case the machine moved.
 */
// A provider reports running when its container starts, before sshd accepts; dial again briefly.
const FRESH_START_WINDOW_MS = 60_000
const FRESH_START_RETRY_DELAYS_MS = [2_000, 6_000, 12_000]

export class MachineConnectFlow {
  private readonly startedAt = new Map<string, number>()

  constructor(
    private readonly client: MachineProviderClient,
    private readonly deps: {
      sshTargets: MachineSshTargets
      pairing: MachinePairing
      delay: (ms: number) => Promise<void>
    },
    private readonly fetch: MachineFetch
  ) {}

  /** A machine just created or woken; its first connects tolerate sshd still starting. */
  noteStarted(record: MachineRecord): void {
    if (record.state === 'running') {
      this.startedAt.set(`${record.providerKey}\0${record.id}`, this.client.now())
    }
  }

  async connect(
    providerKey: MachineProviderKey,
    machineId: string,
    operationId?: string
  ): Promise<MachineConnection> {
    const provider = this.client.provider(providerKey)
    const onStderr = this.client.progress(provider, 'connect', operationId, machineId)
    const cached = findRecord(this.client.inventory(providerKey), machineId)
    // Cached ssh access is reused; pairing codes are never stored, so orca-server always asks.
    const reusable = cached?.state === 'running' && cached.access?.kind === 'ssh' ? cached : null
    const live = reusable ? null : await this.fetch(providerKey, machineId, onStderr)
    try {
      return await this.connectTo(provider, live?.record ?? reusable, live?.machine?.access, cached)
    } catch (error) {
      if (reusable) {
        // The machine may have come back on a new endpoint; ask once, retry only if it moved.
        const fresh = await this.fetch(providerKey, machineId, onStderr).catch(() => null)
        if (fresh?.machine && machineEndpointChanged(reusable.access, fresh.machine.access)) {
          return this.connectOrMark(provider, fresh.record, fresh.machine.access, cached)
        }
      }
      // The target stays: worktrees are keyed to it and the next connect may succeed.
      this.client.commit(provider, (inventory) => markUnreachable(inventory, machineId, error))
      throw error
    }
  }

  private async connectOrMark(
    provider: MachineProviderEntry,
    record: MachineRecord,
    access: MachineAccess | undefined,
    previous: MachineRecord | undefined
  ): Promise<MachineConnection> {
    try {
      return await this.connectTo(provider, record, access, previous)
    } catch (error) {
      this.client.commit(provider, (inventory) => markUnreachable(inventory, record.id, error))
      throw error
    }
  }

  private async connectTo(
    provider: MachineProviderEntry,
    record: MachineRecord | null,
    liveAccess: MachineAccess | undefined,
    previous: MachineRecord | undefined
  ): Promise<MachineConnection> {
    const access = liveAccess ?? record?.access
    if (!record || record.state !== 'running' || !access) {
      throw new MachineProviderError(
        'unavailable',
        `${record?.name ?? 'The machine'} is ${record?.state ?? 'unknown'}.`
      )
    }
    const patch = (fields: Partial<MachineRecord>): void => {
      this.client.commit(provider, (inventory) => patchRecord(inventory, record.id, fields))
    }
    if (access.kind === 'ssh') {
      // Recorded before connecting: the target exists from here on, even if this connect fails.
      patch({ sshTargetId: machineSshTargetId(provider.providerKey, record.id) })
      const result = await this.dialSsh(record, access)
      patch({ lastError: undefined })
      return { kind: 'ssh', ...result }
    }
    const result = await connectMachineOrcaServer(
      this.deps.pairing,
      { ...record, runtimeEnvironmentId: previous?.runtimeEnvironmentId },
      access,
      previous?.pairingCodeSha256
    )
    patch({ runtimeEnvironmentId: result.runtimeEnvironmentId, lastError: undefined })
    return { kind: 'orca-server', ...result }
  }

  private async dialSsh(
    record: MachineRecord,
    access: Extract<MachineAccess, { kind: 'ssh' }>
  ): Promise<MachineSshConnectResult> {
    const started = this.startedAt.get(`${record.providerKey}\0${record.id}`)
    const fresh = started !== undefined && this.client.now() - started < FRESH_START_WINDOW_MS
    const delays = fresh ? FRESH_START_RETRY_DELAYS_MS : []
    for (let attempt = 0; ; attempt++) {
      try {
        return await connectMachineSsh(this.deps.sshTargets, record, access)
      } catch (error) {
        // A refused host key is a verdict, not a slow start.
        const delay = delays[attempt]
        if (delay === undefined || /Host key verification failed/.test(String(error))) {
          throw error
        }
        await this.deps.delay(delay)
      }
    }
  }
}
