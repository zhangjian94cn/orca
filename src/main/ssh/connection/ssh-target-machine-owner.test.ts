import { describe, expect, it } from 'vitest'
import {
  getLegacyManagedOrcadOwnerEnvironmentId,
  isEphemeralRuntimeSshOwner,
  managedOrcadServerName
} from '../../../shared/managed-orcad-ssh-owner'
import type { SshTarget } from '../../../shared/ssh-types'
import { normalizeSshTarget } from '../../persistence/leasing-ssh-ptys/ssh-normalization'
import { isRuntimeOwnedSshTarget } from './ssh-connection-store'

// Persisted by this build. Builds before the machine owner only knew `on-demand-runtime` and read
// owner.runtimeId unguarded, so the owner must keep that field for a downgrade.
const PERSISTED_MACHINE_TARGET: SshTarget = {
  id: 'machine-0123456789abcdef0123',
  label: 'omarchy-dev',
  host: 'omarchy',
  port: 42200,
  username: 'dev',
  configHost: 'omarchy',
  source: 'manual',
  generation: 7,
  owner: {
    type: 'machine',
    runtimeId: 'machine-0123456789abcdef0123',
    providerKey: 'plugin:acme.omarchy/omarchy',
    machineId: 'sbx-1',
    hostKeyFingerprints: [`SHA256:${'A'.repeat(43)}`]
  }
}

describe('machine-owned SSH targets on load', () => {
  it('survive normalization with the owner intact', () => {
    expect(normalizeSshTarget(PERSISTED_MACHINE_TARGET).owner).toEqual(
      PERSISTED_MACHINE_TARGET.owner
    )
  })

  it('stay hidden from SSH host lists and keep normal host-key pinning', () => {
    const target = normalizeSshTarget(PERSISTED_MACHINE_TARGET)
    expect(isRuntimeOwnedSshTarget(target)).toBe(true)
    // Not ephemeral: an unknown key is checked and recorded instead of accepted silently.
    expect(isEphemeralRuntimeSshOwner(target.owner)).toBe(false)
    expect(getLegacyManagedOrcadOwnerEnvironmentId(target.owner)).toBeNull()
    expect(managedOrcadServerName(target)).toBe('omarchy-dev')
  })

  it('read safely through the pre-machine owner shape an older build expects', () => {
    // What an older build sees: only `type` and `runtimeId` are typed, and both are strings.
    const legacyView: { type: string; runtimeId: string } | undefined =
      PERSISTED_MACHINE_TARGET.owner
    expect(legacyView?.runtimeId.startsWith('managed-orcad:')).toBe(false)
    expect(legacyView?.type).not.toBe('on-demand-runtime')
  })
})
