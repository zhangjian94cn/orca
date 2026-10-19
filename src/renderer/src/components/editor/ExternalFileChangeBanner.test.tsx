// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

const store = vi.hoisted(() => ({ state: {} }))
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
const actions = vi.hoisted(() => ({
  discardDraftAndReloadContent: vi.fn(),
  getMountedEditModel: vi.fn(),
  keepTabEditsOverExternalChange: vi.fn(),
  reloadMountedModelFromDisk: vi.fn()
}))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('./external-file-change-actions', () => actions)
vi.mock('./editor-external-change-telemetry', () => ({
  trackExternalChangeConflictAction: vi.fn()
}))

import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'

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

const confirm = vi.fn()
let root: Root | null = null
let container: HTMLDivElement | null = null

function renderBanner(reloadContent = vi.fn()): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <ConfirmationDialogContext.Provider value={confirm}>
        <ExternalFileChangeBanner
          file={file}
          currentContent="buffer"
          reloadContent={reloadContent}
        />
      </ConfirmationDialogContext.Provider>
    )
  })
}

async function clickReload(): Promise<void> {
  const button = [...(container?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent === 'Reload from Disk'
  )
  await act(async () => {
    button?.click()
  })
}

describe('ExternalFileChangeBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.state = { openFiles: [file] }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('renders the overwrite warning, all three actions, and an alert role', () => {
    const html = renderToStaticMarkup(
      <ConfirmationDialogContext.Provider value={confirm}>
        <ExternalFileChangeBanner file={file} currentContent="buffer" reloadContent={vi.fn()} />
      </ConfirmationDialogContext.Provider>
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('changed on disk')
    expect(html).toContain('Saving will overwrite')
    expect(html).toContain('Compare')
    expect(html).toContain('Reload from Disk')
    expect(html).toContain('Keep My Edits')
  })

  it('reloads a mounted editor as an undoable edit, with no confirmation or toast', async () => {
    const mounted = { model: {}, modelKey: 'file:///repo/notes.md' }
    actions.getMountedEditModel.mockReturnValue(mounted)
    actions.reloadMountedModelFromDisk.mockResolvedValue(true)
    const reloadContent = vi.fn()
    renderBanner(reloadContent)

    await clickReload()

    expect(actions.reloadMountedModelFromDisk).toHaveBeenCalledWith(file, mounted)
    expect(confirm).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
    expect(reloadContent).not.toHaveBeenCalled()
    expect(actions.discardDraftAndReloadContent).not.toHaveBeenCalled()
  })

  it('asks before discarding the draft on surfaces with no editor undo', async () => {
    actions.getMountedEditModel.mockReturnValue(null)
    confirm.mockResolvedValue(true)
    const reloadContent = vi.fn()
    renderBanner(reloadContent)

    await clickReload()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(actions.discardDraftAndReloadContent).toHaveBeenCalledWith(file, reloadContent)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('keeps the draft when the user cancels the confirmation', async () => {
    actions.getMountedEditModel.mockReturnValue(null)
    confirm.mockResolvedValue(false)
    renderBanner()

    await clickReload()

    expect(actions.discardDraftAndReloadContent).not.toHaveBeenCalled()
  })
})
