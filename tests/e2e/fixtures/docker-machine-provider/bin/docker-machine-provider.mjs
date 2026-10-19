// E2E machine provider (protocolVersion 1). Each machine is a container of the Docker SSH host
// image, labelled with its id and create operationId; sleep stops it and wake starts it, which
// remaps its SSH port, so Orca's endpoint-change path runs. Configured by the spec through env:
// ORCA_E2E_MACHINE_IMAGE, ORCA_E2E_MACHINE_RUN_ID, ORCA_E2E_MACHINE_IDENTITY_FILE, and
// ORCA_E2E_SSH_TARGET_HOST (defaults to 127.0.0.1).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECT_ROOT = '/root/work'
const [verb, , , machineId] = process.argv.slice(2)
const runId = process.env.ORCA_E2E_MACHINE_RUN_ID ?? 'default'
const host = process.env.ORCA_E2E_SSH_TARGET_HOST?.trim() || '127.0.0.1'
const contextId = `docker:${runId}`
const request = JSON.parse(readFileSync(0, 'utf8') || '{}')
const label = (key) => `orca.e2e.machine.${key}`

function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function respond(body, exitCode = 0) {
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      operationId: request.operationId,
      contextId,
      now: new Date().toISOString(),
      ...body
    })
  )
  process.exitCode = exitCode
}

function containers() {
  const ids = docker('ps', '-aq', '--filter', `label=${label('run')}=${runId}`)
  return ids ? JSON.parse(docker('inspect', ...ids.split('\n'))) : []
}

function find(id) {
  return containers().find((container) => container.Config.Labels[label('id')] === id)
}

function view(container) {
  const labels = container.Config.Labels
  const running = container.State.Running
  const machine = {
    id: labels[label('id')],
    name: labels[label('name')],
    lifetime: labels[label('lifetime')],
    state: running ? 'running' : 'sleeping',
    createdAt: labels[label('createdAt')],
    creatingOperationId: labels[label('operationId')],
    detail: 'Docker SSH host',
    ...(labels[label('expiresAt')] ? { expiresAt: labels[label('expiresAt')] } : {})
  }
  if (!running) {
    return machine
  }
  const port = Number(docker('port', container.Id, '22/tcp').split('\n')[0].split(':').at(-1))
  // The comment field is dropped: Orca pins "<type> <base64>" only.
  const hostKey = docker('exec', container.Id, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')
    .split(' ')
    .slice(0, 2)
    .join(' ')
  return {
    ...machine,
    access: {
      kind: 'ssh',
      host,
      port,
      user: 'root',
      projectRoot: PROJECT_ROOT,
      hostKeys: [hostKey]
    }
  }
}

// The e2e HOME starts with no SSH key; a real user's key would already be there.
function installClientKey() {
  const target = join(homedir(), '.ssh', 'id_ed25519')
  if (!existsSync(target)) {
    mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 })
    copyFileSync(process.env.ORCA_E2E_MACHINE_IDENTITY_FILE, target)
    execFileSync('chmod', ['600', target])
  }
}

function create() {
  const existing = containers().find(
    (container) => container.Config.Labels[label('operationId')] === request.operationId
  )
  if (existing) {
    return respond({ kind: 'machine', machine: view(existing) })
  }
  installClientKey()
  process.stderr.write('starting docker machine\n')
  const params = request.params ?? {}
  const id = `dm-${randomUUID().slice(0, 8)}`
  const createdAt = new Date()
  const expiresAt =
    params.lifetime === 'temporary'
      ? new Date(createdAt.getTime() + (params.ttlSeconds ?? 3600) * 1000).toISOString()
      : ''
  const publicKey = readFileSync(`${process.env.ORCA_E2E_MACHINE_IDENTITY_FILE}.pub`, 'utf8').trim()
  docker(
    'run',
    '-d',
    '--name',
    `orca-e2e-machine-${id}`,
    '-p',
    `${host === '127.0.0.1' ? host : '0.0.0.0'}::22`,
    '--label',
    `${label('run')}=${runId}`,
    '--label',
    `${label('id')}=${id}`,
    '--label',
    `${label('name')}=${params.name ?? id}`,
    '--label',
    `${label('lifetime')}=${params.lifetime ?? 'persistent'}`,
    '--label',
    `${label('createdAt')}=${createdAt.toISOString()}`,
    '--label',
    `${label('expiresAt')}=${expiresAt}`,
    '--label',
    `${label('operationId')}=${request.operationId}`,
    '-e',
    `AUTHORIZED_KEY=${publicKey}`,
    process.env.ORCA_E2E_MACHINE_IMAGE,
    'bash',
    '-lc',
    [
      'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys',
      'chmod 600 /root/.ssh/authorized_keys',
      `mkdir -p ${PROJECT_ROOT}`,
      'git config --global user.email e2e@test.local',
      'git config --global user.name "Orca Machine E2E"',
      'exec /usr/sbin/sshd -D -e'
    ].join(' && ')
  )
  process.stderr.write('docker machine running\n')
  respond({ kind: 'machine', machine: view(find(id)) })
}

function targeted(action) {
  const container = find(machineId)
  if (!container) {
    return respond({ kind: 'error', code: 'not-found', message: `no machine ${machineId}` }, 4)
  }
  return action(container)
}

switch (verb) {
  case 'capabilities':
    respond({
      kind: 'capabilities',
      capabilities: {
        verbs: ['create', 'get', 'sleep', 'wake', 'delete'],
        lifetimes: ['persistent', 'temporary'],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 86400,
        contextId,
        contextLabel: 'Docker (e2e)'
      }
    })
    break
  case 'list':
    respond({ kind: 'inventory', machines: containers().map(view) })
    break
  case 'create':
    create()
    break
  case 'get':
    targeted((container) => respond({ kind: 'machine', machine: view(container) }))
    break
  case 'sleep':
    targeted((container) => {
      docker('stop', '-t', '1', container.Id)
      respond({ kind: 'machine', machine: view(find(machineId)) })
    })
    break
  case 'wake':
    targeted((container) => {
      process.stderr.write('starting docker machine\n')
      docker('start', container.Id)
      respond({ kind: 'machine', machine: view(find(machineId)) })
    })
    break
  case 'delete':
    targeted((container) => {
      docker('rm', '-f', container.Id)
      respond({ kind: 'error', code: 'not-found', message: 'deleted' }, 4)
    })
    break
  default:
    respond({ kind: 'error', code: 'unsupported', message: `unknown verb ${verb}` }, 2)
}
