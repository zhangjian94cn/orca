import {
  MachineProviderError,
  isConfirmedMachineTransition,
  type ProviderMachine
} from '../../shared/machine-provider-protocol'
import type {
  MachineConnection,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord
} from '../../shared/machine-inventory'
import { machineSshTargetId, type MachinePairing, type MachineSshTargets } from './machine-connect'
import { MachineConnectFlow } from './machine-connect-flow'
import { pollWhileMachineState } from './machine-state-polling'
import { MachineCreateFlow, isUnknownOutcome, type MachineCreateParams } from './machine-create'
import {
  applyInventory,
  applyMachine,
  failureOf,
  markGone,
  markUnreachable,
  patchRecord
} from './machine-inventory-records'
import {
  MachineProviderClient,
  type MachineProviderClientDeps,
  type MachineProviderEntry
} from './machine-provider-client'

const WAKE_POLL_LIMIT_MS = 180_000
const FAILURE_BACKOFF_MS = [30_000, 120_000, 600_000]

export type { MachineCreateParams } from './machine-create'
export type { MachineProviderEntry } from './machine-provider-client'

export type MachineServiceDeps = MachineProviderClientDeps & {
  sshTargets: MachineSshTargets
  pairing: MachinePairing
  removeSshTarget: (id: string) => Promise<void>
  delay?: (ms: number) => Promise<void>
}

type Mutation = 'sleep' | 'wake' | 'archive' | 'delete'

export class MachineService {
  private readonly client: MachineProviderClient
  private readonly creates: MachineCreateFlow
  private readonly connections: MachineConnectFlow
  private readonly listFlights = new Map<string, Promise<MachineProviderSnapshot>>()
  private readonly mutationFlights = new Map<
    string,
    { verb: Mutation; done: Promise<MachineRecord> }
  >()
  private readonly consecutiveFailures = new Map<string, number>()

  constructor(private readonly deps: MachineServiceDeps) {
    this.client = new MachineProviderClient(deps)
    this.creates = new MachineCreateFlow(this.client, {
      refresh: (providerKey) => this.list(providerKey, { force: true }),
      read: async (providerKey, machineId, onStderr) =>
        (await this.fetch(providerKey, machineId, onStderr)).record,
      delay: (ms) => this.delay(ms)
    })
    this.connections = new MachineConnectFlow(
      this.client,
      { ...deps, delay: (ms) => this.delay(ms) },
      (key, id, onStderr) => this.fetch(key, id, onStderr)
    )
  }

  /** Cached state only; never runs a provider. */
  snapshots(): MachineProviderSnapshot[] {
    return this.client.providers().map((provider) => this.client.snapshot(provider))
  }

  /** Per-provider single-flight; a failing provider backs off unless the caller forces it. */
  async list(
    providerKey: MachineProviderKey,
    options: { maxAgeMs?: number; force?: boolean } = {}
  ): Promise<MachineProviderSnapshot> {
    const provider = this.client.provider(providerKey)
    if (!options.force && this.isFresh(providerKey, options.maxAgeMs)) {
      return this.client.snapshot(provider)
    }
    const inFlight = this.listFlights.get(providerKey)
    if (inFlight && !options.force) {
      return inFlight
    }
    // A forced list must start after anything it follows (a create, a cancel), not join an older one.
    const start = inFlight
      ? inFlight.then(
          () => this.runList(provider),
          () => this.runList(provider)
        )
      : this.runList(provider)
    const flight = start.finally(() => {
      if (this.listFlights.get(providerKey) === flight) {
        this.listFlights.delete(providerKey)
      }
    })
    this.listFlights.set(providerKey, flight)
    return flight
  }

  async get(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return (await this.fetch(providerKey, machineId)).record
  }

  create(
    providerKey: MachineProviderKey,
    params: MachineCreateParams,
    options: { operationId?: string } = {}
  ): Promise<MachineRecord> {
    return this.creates
      .create(providerKey, params, options.operationId)
      .then((record) => this.started(record))
  }

  cancelCreate(operationId: string): boolean {
    return this.creates.cancel(operationId)
  }

  sleep(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'sleep')
  }

  /** `operationId` tags the wake's stderr progress events. */
  wake(
    providerKey: MachineProviderKey,
    machineId: string,
    options: { operationId?: string } = {}
  ): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'wake', options.operationId).then((record) =>
      this.started(record)
    )
  }

  archive(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'archive')
  }

  delete(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'delete')
  }

  connect(
    providerKey: MachineProviderKey,
    machineId: string,
    options: { operationId?: string } = {}
  ): Promise<MachineConnection> {
    return this.connections.connect(providerKey, machineId, options.operationId)
  }

  /** One provider read; the raw answer carries what records never keep (pairing codes). */
  async fetch(
    providerKey: MachineProviderKey,
    machineId: string,
    onStderr?: (chunk: string) => void
  ): Promise<{ record: MachineRecord; machine?: ProviderMachine }> {
    const provider = this.client.provider(providerKey)
    let machine: ProviderMachine
    try {
      machine = await this.client.callForMachine(provider, 'get', { machineId, onStderr })
    } catch (error) {
      if (error instanceof MachineProviderError && error.code === 'not-found') {
        return {
          record: this.client.commit(provider, (inventory) => markGone(inventory, machineId))
        }
      }
      this.client.commit(provider, (inventory) => markUnreachable(inventory, machineId, error))
      throw error
    }
    const record = this.client.commit(provider, (inventory) =>
      applyMachine(inventory, providerKey, machine, this.client.now())
    )
    return { record, machine }
  }

  private async runList(provider: MachineProviderEntry): Promise<MachineProviderSnapshot> {
    const key = provider.providerKey
    try {
      const response = await this.client.call(provider, 'list')
      if (response.kind !== 'inventory') {
        throw new MachineProviderError('invalid-response', 'list did not return an inventory.')
      }
      this.consecutiveFailures.delete(key)
      this.client.commit(provider, (inventory) =>
        applyInventory(inventory, key, response.machines, this.client.now())
      )
    } catch (error) {
      this.consecutiveFailures.set(key, (this.consecutiveFailures.get(key) ?? 0) + 1)
      this.client.commit(provider, (inventory) => {
        inventory.lastFailure = failureOf(error, this.client.now())
        for (const machine of inventory.machines) {
          markUnreachable(inventory, machine.id, error)
        }
      })
    }
    return this.client.snapshot(provider)
  }

  /** Per-machine single-flight: a repeat joins, a different action is refused. */
  private mutate(
    providerKey: MachineProviderKey,
    machineId: string,
    verb: Mutation,
    operationId?: string
  ): Promise<MachineRecord> {
    const flightKey = `${providerKey}\0${machineId}`
    const inFlight = this.mutationFlights.get(flightKey)
    if (inFlight) {
      return inFlight.verb === verb
        ? inFlight.done
        : Promise.reject(
            new MachineProviderError('conflict', `Another action is running on ${machineId}.`)
          )
    }
    const done = this.runMutation(providerKey, machineId, verb, operationId).finally(() =>
      this.mutationFlights.delete(flightKey)
    )
    this.mutationFlights.set(flightKey, { verb, done })
    return done
  }

  private async runMutation(
    providerKey: MachineProviderKey,
    machineId: string,
    verb: Mutation,
    operationId: string | undefined
  ): Promise<MachineRecord> {
    const provider = this.client.provider(providerKey)
    const onStderr =
      verb === 'wake' ? this.client.progress(provider, 'wake', operationId, machineId) : undefined
    if (!(await this.client.capabilities(provider)).verbs.includes(verb)) {
      throw new MachineProviderError('unsupported', `${provider.name} does not support ${verb}.`)
    }
    let machine: ProviderMachine
    try {
      machine = await this.client.callForMachine(provider, verb, { machineId, onStderr })
    } catch (error) {
      if (
        verb === 'delete' &&
        error instanceof MachineProviderError &&
        error.code === 'not-found'
      ) {
        return this.finishDelete(provider, machineId)
      }
      if (!isUnknownOutcome(error)) {
        throw error
      }
      return this.reconcile(provider, machineId, verb, error)
    }
    if (!isConfirmedMachineTransition(verb, machine.state)) {
      return this.reconcile(provider, machineId, verb, `${verb} reported ${machine.state}.`)
    }
    if (verb === 'delete') {
      return this.finishDelete(provider, machineId)
    }
    const record = this.client.commit(provider, (inventory) =>
      applyMachine(inventory, providerKey, machine, this.client.now())
    )
    return pollWhileMachineState(record, 'waking', {
      read: async () => (await this.fetch(providerKey, machineId, onStderr)).record,
      delay: (ms) => this.delay(ms),
      now: () => this.client.now(),
      deadline: this.client.now() + WAKE_POLL_LIMIT_MS
    })
  }

  /** "Checking what happened": one read, never a re-run of the mutation. */
  private async reconcile(
    provider: MachineProviderEntry,
    machineId: string,
    verb: Mutation,
    reason: unknown
  ): Promise<MachineRecord> {
    this.client.commit(provider, (inventory) => markUnreachable(inventory, machineId, reason))
    const record = await this.get(provider.providerKey, machineId)
    // A delete the read confirms still owes its cleanup.
    return verb === 'delete' && (record.state === 'gone' || record.state === 'unknown')
      ? this.finishDelete(provider, machineId)
      : record
  }

  private async finishDelete(
    provider: MachineProviderEntry,
    machineId: string
  ): Promise<MachineRecord> {
    // Explicit delete is the one path that removes the machine's SSH target.
    await this.deps
      .removeSshTarget(machineSshTargetId(provider.providerKey, machineId))
      .catch(() => undefined)
    return this.client.commit(provider, (inventory) => {
      markGone(inventory, machineId)
      return patchRecord(inventory, machineId, { sshTargetId: undefined })
    })
  }

  private isFresh(providerKey: MachineProviderKey, maxAgeMs: number | undefined): boolean {
    const inventory = this.client.inventory(providerKey)
    const now = this.client.now()
    const failures = this.consecutiveFailures.get(providerKey) ?? 0
    if (failures > 0 && inventory.lastFailure) {
      const backoff = FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1] ?? 0
      return now - inventory.lastFailure.at < backoff
    }
    return (
      maxAgeMs !== undefined &&
      inventory.listedAt !== undefined &&
      now - inventory.listedAt < maxAgeMs
    )
  }

  private started(record: MachineRecord): MachineRecord {
    this.connections.noteStarted(record)
    return record
  }

  private delay(ms: number): Promise<void> {
    return this.deps.delay
      ? this.deps.delay(ms)
      : new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
  }
}
