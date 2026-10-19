// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const readRuntimeFileContentMock = vi.hoisted(() => vi.fn())
const store = vi.hoisted(() => ({ getState: (): object => ({}) }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: readRuntimeFileContentMock
}))
vi.mock('@/lib/connection-context', () => ({
  // Why: the floating workspace is always client-local; other owners are still loading.
  getConnectionIdForFile: (worktreeId: string) =>
    worktreeId === 'global-floating-terminal' ? null : undefined
}))
vi.mock('./editor-model-owner', () => ({ getEditorModelOwnerKey: () => '' }))

import { useAppStore } from '@/store'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { getDiskBaselineSignature } from './diff-content-signature'
import { ORCA_EDITOR_FILE_RELOADED_EVENT } from './editor-autosave'
import { toEditorModelUri } from './editor-model-uri'
import { isProgrammaticContentSyncInFlight } from './monaco-programmatic-sync'
import {
  discardDraftAndReloadContent,
  getMountedEditModel,
  keepTabEditsOverExternalChange,
  reloadMountedModelFromDisk
} from './external-file-change-actions'

const file: OpenFile = {
  id: 'file-1',
  filePath: '/repo/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  mode: 'edit',
  isDirty: true,
  externalMutation: 'changed'
}
const modelKey = toEditorModelUri(file.filePath)

const clearEditorDraft = vi.fn()
const markFileDirty = vi.fn()
const setExternalMutation = vi.fn()
const setLastKnownDiskSignature = vi.fn()
let openFiles: OpenFile[] = [file]

function mockStore(): void {
  store.getState = () => ({
    clearEditorDraft,
    markFileDirty,
    setExternalMutation,
    setLastKnownDiskSignature,
    editorDrafts: {},
    openFiles,
    settings: {}
  })
}

function deferredRead(): (content: string) => void {
  let resolve: (value: { content: string; isBinary: boolean }) => void = () => undefined
  readRuntimeFileContentMock.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  return (content) => resolve({ content, isBinary: false })
}

let model: monaco.editor.ITextModel
let unregister: () => void

beforeEach(() => {
  vi.clearAllMocks()
  openFiles = [file]
  mockStore()
  readRuntimeFileContentMock.mockResolvedValue({ content: 'disk text', isBinary: false })
  unregister = editorModelRegistry.register(monaco)
  model = monaco.editor.createModel('draft text', 'plaintext', monaco.Uri.parse(modelKey))
  vi.spyOn(model, 'isAttachedToEditor').mockReturnValue(true)
})

afterEach(() => {
  model.dispose()
  unregister()
})

function mounted(): NonNullable<ReturnType<typeof getMountedEditModel>> {
  const result = getMountedEditModel(file, useAppStore.getState())
  expect(result?.model).toBe(model)
  return result!
}

describe('reloadMountedModelFromDisk', () => {
  it('applies the disk text as one undoable edit, so Cmd+Z restores the draft', async () => {
    const reloadedEvents: unknown[] = []
    const onReloaded = (event: Event): void => {
      reloadedEvents.push(event instanceof CustomEvent ? event.detail : undefined)
    }
    window.addEventListener(ORCA_EDITOR_FILE_RELOADED_EVENT, onReloaded)
    const programmaticDuringEdit: boolean[] = []
    model.onDidChangeContent(() =>
      programmaticDuringEdit.push(isProgrammaticContentSyncInFlight(modelKey))
    )

    await expect(reloadMountedModelFromDisk(file, mounted())).resolves.toBe(true)
    window.removeEventListener(ORCA_EDITOR_FILE_RELOADED_EVENT, onReloaded)

    expect(model.getValue()).toBe('disk text')
    // Why: split panes share this model; one edit marked programmatic means every pane's
    // bridge ignores the echo and the panels adopt the text from one event.
    expect(programmaticDuringEdit).toEqual([true])
    expect(reloadedEvents).toEqual([{ fileId: 'file-1', content: 'disk text' }])
    expect(setLastKnownDiskSignature).toHaveBeenCalledWith(
      'file-1',
      getDiskBaselineSignature('disk text')
    )
    expect(clearEditorDraft).toHaveBeenCalledWith('file-1')
    expect(markFileDirty).toHaveBeenCalledWith('file-1', false)
    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)

    await model.undo()
    expect(model.getValue()).toBe('draft text')
  })

  it('drops the result when the user typed during the read', async () => {
    const resolveRead = deferredRead()
    const pending = reloadMountedModelFromDisk(file, mounted())
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: 'draft text, more typing' }],
      () => null
    )
    resolveRead('disk text')

    await expect(pending).resolves.toBe(false)
    expect(model.getValue()).toBe('draft text, more typing')
    expect(clearEditorDraft).not.toHaveBeenCalled()
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('drops the result when the conflict was resolved during the read', async () => {
    const resolveRead = deferredRead()
    const pending = reloadMountedModelFromDisk(file, mounted())
    openFiles = [{ ...file, isDirty: false, externalMutation: undefined }]
    resolveRead('disk text')

    await expect(pending).resolves.toBe(false)
    expect(model.getValue()).toBe('draft text')
    expect(setLastKnownDiskSignature).not.toHaveBeenCalled()
  })

  it('drops a binary disk read', async () => {
    readRuntimeFileContentMock.mockResolvedValue({ content: '', isBinary: true })

    await expect(reloadMountedModelFromDisk(file, mounted())).resolves.toBe(false)
    expect(model.getValue()).toBe('draft text')
  })
})

describe('getMountedEditModel', () => {
  it('ignores a retained model no code editor shows (rich markdown, preview)', () => {
    vi.mocked(model.isAttachedToEditor).mockReturnValue(false)
    expect(getMountedEditModel(file, useAppStore.getState())).toBeNull()
  })

  it('ignores non-edit tabs, whose diff models rotate on reload', () => {
    expect(getMountedEditModel({ ...file, mode: 'diff' }, useAppStore.getState())).toBeNull()
  })
})

describe('discardDraftAndReloadContent', () => {
  it('clears the draft, dirty flag, and mark before refetching content', () => {
    const calls: string[] = []
    clearEditorDraft.mockImplementation(() => calls.push('clearEditorDraft'))
    markFileDirty.mockImplementation(() => calls.push('markFileDirty'))
    setExternalMutation.mockImplementation(() => calls.push('setExternalMutation'))
    const reloadContent = vi.fn(() => calls.push('reloadContent'))

    discardDraftAndReloadContent(file, reloadContent)

    expect(reloadContent).toHaveBeenCalledWith(file)
    // Why: the draft shadows loaded content, so the refetch must come last.
    expect(calls).toEqual([
      'clearEditorDraft',
      'markFileDirty',
      'setExternalMutation',
      'reloadContent'
    ])
  })
})

describe('keepTabEditsOverExternalChange', () => {
  async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('clears the mark without touching the draft or dirty flag', () => {
    keepTabEditsOverExternalChange(file)

    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)
    expect(clearEditorDraft).not.toHaveBeenCalled()
    expect(markFileDirty).not.toHaveBeenCalled()
  })

  it('advances the disk baseline so the dismissal survives restart', async () => {
    readRuntimeFileContentMock.mockResolvedValue({ content: 'agent content', isBinary: false })
    openFiles = [{ ...file, externalMutation: undefined }]

    keepTabEditsOverExternalChange(file)
    await flush()

    expect(setLastKnownDiskSignature).toHaveBeenCalledWith(
      'file-1',
      getDiskBaselineSignature('agent content')
    )
  })

  it('does not stamp a baseline over a newer conflict', async () => {
    readRuntimeFileContentMock.mockResolvedValue({ content: 'even newer', isBinary: false })

    keepTabEditsOverExternalChange(file)
    await flush()

    expect(setLastKnownDiskSignature).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a floating-workspace tab, as the file the user named',
      'global-floating-terminal',
      'user-file'
    ],
    ['a project tab, inside its root', 'wt-1', undefined]
  ])('reads %s', async (_label, worktreeId, kind) => {
    const tab: OpenFile = { ...file, worktreeId }
    openFiles = [tab]

    keepTabEditsOverExternalChange(tab)
    await flush()

    expect(readRuntimeFileContentMock.mock.calls[0]?.[0]?.access?.kind).toBe(kind)
  })
})
