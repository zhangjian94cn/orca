import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ORCAD_MIGRATION_BLOB_CHUNK_BYTES,
  type OrcadMigrationBlobDescriptor
} from '../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationEditorDraft } from '../shared/orcad-migration/orcad-migration-editor-drafts'
import type { OrcadMigrationManifest } from '../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedOpenFile } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import {
  commitStagedOrcadMigrationCatalogDurably,
  getOrcadMigrationCatalogState
} from './runtime/orcad-migration-catalog-import'
import {
  DORMANT_WORKTREE_ID,
  dormantState,
  manifest
} from './persistence-orcad-migration-catalog-fixture'
import { createStore, readDataFile, testState, writeDataFile } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

type Store = ReturnType<typeof createStore>

const FILE_A = '/srv/repo-1-worktree/src/a.ts'
const FILE_B = '/srv/repo-1-worktree/src/b.ts'

function openFile(filePath: string, dirtyDraftContent?: string): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/srv/repo-1-worktree/'.length),
    worktreeId: DORMANT_WORKTREE_ID,
    language: 'typescript',
    ...(dirtyDraftContent === undefined ? {} : { dirtyDraftContent })
  }
}

function encodeDrafts(drafts: OrcadMigrationEditorDraft[]): {
  bytes: Buffer
  descriptor: OrcadMigrationBlobDescriptor
} {
  const bytes = Buffer.from(JSON.stringify({ version: 1, drafts }))
  return {
    bytes,
    descriptor: {
      blobKind: 'editor-drafts',
      key: 'drafts',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

/** A capable desktop's manifest: FILE_A's draft shed into the blob, FILE_B clean. */
function declaredManifest(
  declared: OrcadMigrationBlobDescriptor | null,
  entries = [{ worktreeKey: DORMANT_WORKTREE_ID, filePath: FILE_A }]
): OrcadMigrationManifest {
  const dormant = dormantState()
  dormant.workspaceSession = {
    ...dormant.workspaceSession!,
    openFilesByWorktree: { [DORMANT_WORKTREE_ID]: [openFile(FILE_A), openFile(FILE_B)] }
  }
  if (declared) {
    dormant.editorDraftsBlob = {
      sha256: declared.sha256,
      byteLength: declared.byteLength,
      entries
    }
  }
  const base = manifest()
  return manifest({ payload: { ...base.payload, dormantState: dormant } })
}

function stageBlob(
  store: Store,
  input: OrcadMigrationManifest,
  blob: ReturnType<typeof encodeDrafts>
) {
  for (let offset = 0; offset < blob.bytes.length; offset += ORCAD_MIGRATION_BLOB_CHUNK_BYTES) {
    store.stageOrcadMigrationBlobChunk({
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      blob: blob.descriptor,
      offset,
      bytesBase64: blob.bytes
        .subarray(offset, offset + ORCAD_MIGRATION_BLOB_CHUNK_BYTES)
        .toString('base64')
    })
  }
}

function receivedDraftsPath(input: OrcadMigrationManifest): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'editor-drafts',
    key: 'drafts'
  })
}

function draftOf(store: Store, filePath: string): string | undefined {
  return store
    .getWorkspaceSession()
    .openFilesByWorktree?.[DORMANT_WORKTREE_ID]?.find((file) => file.filePath === filePath)
    ?.dirtyDraftContent
}

function setDestinationFiles(store: Store, files: PersistedOpenFile[]): void {
  store.setWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: { [DORMANT_WORKTREE_ID]: files }
  })
}

function commitDurably(store: Store, input: OrcadMigrationManifest) {
  return commitStagedOrcadMigrationCatalogDurably({
    store,
    manifest: input,
    onDurableCommit: () => {}
  })
}

const DRAFT_A = { worktreeKey: DORMANT_WORKTREE_ID, filePath: FILE_A, content: 'unsaved A\n' }

describe('orcad migration editor drafts blob', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-drafts-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('applies an 8 MiB draft byte-identical inside the commit and releases the blob once durable', async () => {
    const content = `${'x'.repeat(8 * 1024 * 1024 - 7)}é\n\u0000end`
    const blob = encodeDrafts([{ ...DRAFT_A, content }])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect((await commitDurably(store, input)).state).toBe('committed')
    expect(draftOf(store, FILE_A)).toBe(content)
    expect(draftOf(store, FILE_B)).toBeUndefined()
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
    expect(draftOf(createStore(), FILE_A)).toBe(content)
  })

  it('refuses a declared blob that never arrived, whether or not the sender names its blobs', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_missing'
    )
    expect(() => store.commitStagedOrcadMigrationCatalog(input, { expectedBlobs: [] })).toThrow(
      'orcad_migration_editor_drafts_missing'
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
    expect(store.getRepos()).toEqual([])
  })

  it('refuses a drafts blob the manifest does not declare', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(null)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_undeclared'
    )
    expect(store.getRepos()).toEqual([])
  })

  it('refuses a draft for an entry the manifest did not shed', () => {
    const blob = encodeDrafts([
      DRAFT_A,
      { worktreeKey: DORMANT_WORKTREE_ID, filePath: FILE_B, content: 'extra' }
    ])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_set_mismatch'
    )
    expect(store.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      blobUploads: [{ ...blob.descriptor, receivedBytes: blob.descriptor.byteLength }]
    })
  })

  it('refuses bytes whose digest differs from the signed declaration', () => {
    const declared = encodeDrafts([DRAFT_A])
    const sent = encodeDrafts([{ ...DRAFT_A, content: 'tampered' }])
    const input = declaredManifest(declared.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, sent)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_digest_mismatch'
    )
    expect(store.getRepos()).toEqual([])
  })

  it('accepts a destination entry already holding the identical draft', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    setDestinationFiles(store, [openFile(FILE_A, DRAFT_A.content), openFile(FILE_B)])
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(store.commitStagedOrcadMigrationCatalog(input).state).toBe('committed')
    expect(draftOf(store, FILE_A)).toBe(DRAFT_A.content)
  })

  it('stages past a competing destination draft but refuses it at commit, keeping staging', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    setDestinationFiles(store, [openFile(FILE_A, 'destination edit'), openFile(FILE_B)])
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:openFilesByWorktree:${DORMANT_WORKTREE_ID}`
    )
    expect(draftOf(store, FILE_A)).toBe('destination edit')
    expect(store.getOrcadMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      blobUploads: [{ ...blob.descriptor, receivedBytes: blob.descriptor.byteLength }]
    })
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
  })

  it('refuses a destination draft edited between stage and commit', () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    setDestinationFiles(store, [openFile(FILE_A, DRAFT_A.content), openFile(FILE_B)])
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    setDestinationFiles(store, [openFile(FILE_A, 'edited after staging'), openFile(FILE_B)])

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:openFilesByWorktree:${DORMANT_WORKTREE_ID}`
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
  })

  it('re-applies the received drafts on a retry after the first commit was lost', async () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()
    store.commitStagedOrcadMigrationCatalog(input)
    writeDataFile(stagedDiskState)

    // Staging is gone: the first commit moved the blob, so only the received bytes remain.
    const restarted = createStore()
    expect(restarted.getOrcadMigrationCatalogState(input)).toMatchObject({ state: 'staged' })
    expect(restarted.getOrcadMigrationCatalogState(input)).not.toHaveProperty('blobUploads')
    expect(draftOf(restarted, FILE_A)).toBeUndefined()
    expect((await commitDurably(restarted, input)).state).toBe('committed')
    expect(draftOf(restarted, FILE_A)).toBe(DRAFT_A.content)
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
  })

  it('refuses a received-only retry whose bytes were damaged', async () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()
    store.commitStagedOrcadMigrationCatalog(input)
    writeDataFile(stagedDiskState)
    writeFileSync(receivedDraftsPath(input), Buffer.from('damaged'))

    const restarted = createStore()
    expect(() => restarted.commitStagedOrcadMigrationCatalog(input)).toThrow(
      'orcad_migration_editor_drafts_digest_mismatch'
    )
    expect(restarted.getOrcadMigrationCatalogState(input).state).toBe('staged')
  })

  it('keeps the received drafts through a failed flush and a state query, for the retry after restart', async () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    await store.flushPendingOrThrowAsync()
    const stagedDiskState = readDataFile()
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))

    await expect(commitDurably(store, input)).rejects.toThrow('disk full')
    // The in-memory receipt answers "committed" and runs the installers; the drafts file stays.
    expect(getOrcadMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedDraftsPath(input))).toBe(true)

    writeDataFile(stagedDiskState)
    const restarted = createStore()
    expect(restarted.getOrcadMigrationCatalogState(input).state).toBe('staged')
    expect((await commitDurably(restarted, input)).state).toBe('committed')
    expect(draftOf(createStore(), FILE_A)).toBe(DRAFT_A.content)
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
  })

  it('releases drafts left by a commit that did reach disk at the next store load', async () => {
    const blob = encodeDrafts([DRAFT_A])
    const input = declaredManifest(blob.descriptor)
    const store = createStore()
    store.stageOrcadMigrationCatalog(input)
    stageBlob(store, input, blob)
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    expect(getOrcadMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedDraftsPath(input))).toBe(true)

    const restarted = createStore()
    expect(existsSync(receivedDraftsPath(input))).toBe(false)
    expect(draftOf(restarted, FILE_A)).toBe(DRAFT_A.content)
  })
})
