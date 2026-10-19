/**
 * A machine provider plugin end to end against real Docker SSH hosts: consent shows its argv, then
 * create, connect with provider-pinned host keys, sleep, wake on a remapped port, and delete. The
 * composer, sidebar and pane journey stacks on this once the Machines UI lands.
 */
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import {
  DOCKER_MACHINE_PROVIDER_KEY,
  dockerMachineProviderEnv,
  installDockerMachineProvider,
  isDockerMachineRunning,
  machineSnapshot,
  prepareDockerMachineProvider,
  type DockerMachineProvider
} from './helpers/docker-machine-provider'
import { ORCAD_TEMPLATE, skipUnlessManagedDockerHost } from './helpers/orcad-managed-workspace'
import { waitForSessionReady } from './helpers/store'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The fixture provider drives the Docker CLI on POSIX hosts')
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE ?? '', ...dockerMachineProviderEnv() }
})

test('runs a provider machine through create, connect, sleep, wake and delete', async ({
  orcaPage
}) => {
  // The first connect deploys the machine's managed server.
  test.setTimeout(420_000)
  let provider: DockerMachineProvider | null = null
  try {
    provider = prepareDockerMachineProvider()
    await waitForSessionReady(orcaPage)
    await installDockerMachineProvider(orcaPage, provider.pluginDir)

    const operationId = randomUUID()
    const created = await orcaPage.evaluate(
      async ({ providerKey, operationId }) => {
        const chunks: string[] = []
        const stop = window.api.machines.onProgress((event) => {
          if (event.operationId === operationId) {
            chunks.push(event.chunk)
          }
        })
        try {
          const result = await window.api.machines.create({
            providerKey,
            operationId,
            name: 'e2e-machine',
            lifetime: 'temporary',
            ttlSeconds: 3600
          })
          return { result, progress: chunks.join('') }
        } finally {
          stop()
        }
      },
      { providerKey: DOCKER_MACHINE_PROVIDER_KEY, operationId }
    )
    if (!created.result.ok) {
      throw new Error(created.result.message)
    }
    const machine = created.result.value
    expect(machine).toMatchObject({ state: 'running', lifetime: 'temporary' })
    expect(created.progress).toContain('starting docker machine')
    const container = provider.containerFor(machine.id)
    expect(container).not.toBeNull()

    const connect = () =>
      orcaPage.evaluate((target) => window.api.machines.connect(target), {
        providerKey: DOCKER_MACHINE_PROVIDER_KEY,
        machineId: machine.id
      })
    // ssh2 accepts only the key the provider read from the container.
    await expect(connect()).resolves.toMatchObject({ ok: true, value: { kind: 'ssh' } })

    const slept = await orcaPage.evaluate((target) => window.api.machines.sleep(target), {
      providerKey: DOCKER_MACHINE_PROVIDER_KEY,
      machineId: machine.id
    })
    expect(slept).toMatchObject({ ok: true, value: { state: 'sleeping' } })
    expect(isDockerMachineRunning(container!)).toBe(false)

    const portBefore = machine.access?.kind === 'ssh' ? machine.access.port : null
    const woken = await orcaPage.evaluate((target) => window.api.machines.wake(target), {
      providerKey: DOCKER_MACHINE_PROVIDER_KEY,
      machineId: machine.id
    })
    expect(woken).toMatchObject({ ok: true, value: { state: 'running' } })
    // Docker remaps the port on start, so this connect moves the same target to a new endpoint.
    const portAfter =
      woken.ok && woken.value.access?.kind === 'ssh' ? woken.value.access.port : null
    expect(portAfter).not.toBe(portBefore)
    await expect(connect()).resolves.toMatchObject({ ok: true, value: { kind: 'ssh' } })

    const deleted = await orcaPage.evaluate((target) => window.api.machines.delete(target), {
      providerKey: DOCKER_MACHINE_PROVIDER_KEY,
      machineId: machine.id
    })
    expect(deleted).toMatchObject({ ok: true, value: { state: 'gone' } })
    expect(provider.containerFor(machine.id)).toBeNull()
    // A machine Orca deleted itself holds no target, so the next list drops its row.
    expect((await machineSnapshot(orcaPage))?.machines).toEqual([])
  } finally {
    provider?.cleanup()
  }
})
