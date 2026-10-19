import React, { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { ExternalFileChangeCompareDialog } from './ExternalFileChangeCompareDialog'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import {
  discardDraftAndReloadContent,
  getMountedEditModel,
  keepTabEditsOverExternalChange,
  reloadMountedModelFromDisk
} from './external-file-change-actions'

// Why: when an external process (usually an agent) rewrites a file while the
// tab holds unsaved edits, the reload pipeline preserves the buffer and marks
// the tab externalMutation='changed' (issue #7265). This banner is the
// recovery path — without it the tab is silently stale until close/reopen and
// the next save clobbers the newer disk content unannounced.

export function ExternalFileChangeBanner({
  file,
  currentContent,
  reloadContent
}: {
  file: OpenFile
  /** The tab's live buffer (draft if dirty) — what "Keep My Edits" keeps. */
  currentContent: string
  /** Refetches the tab's content — file body for edit tabs, diff body for
   *  unstaged diff tabs. */
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const [compareOpen, setCompareOpen] = useState(false)
  const confirm = useConfirmationDialog()

  const handleReload = async (): Promise<void> => {
    trackExternalChangeConflictAction(file, 'reload')
    const mounted = getMountedEditModel(file, useAppStore.getState())
    if (mounted) {
      // Why: Cmd+Z in the editor brings the edits back, so no confirmation or undo toast.
      await reloadMountedModelFromDisk(file, mounted).catch((err: unknown) => {
        toast.error(
          translate(
            'auto.components.editor.ExternalFileChangeBanner.reloadFailed',
            'Could not reload from disk'
          ),
          { description: err instanceof Error ? err.message : String(err) }
        )
      })
      return
    }
    // Why: rich, preview, notebook, CSV and diff views have no undo across a reload — ask first.
    const confirmed = await confirm({
      title: translate(
        'auto.components.editor.ExternalFileChangeBanner.discardTitle',
        'Discard your unsaved edits?'
      ),
      description: translate(
        'auto.components.editor.ExternalFileChangeBanner.discardDescription',
        "{{value0}} will be replaced with the version on disk. This view can't undo it.",
        { value0: file.relativePath }
      ),
      confirmLabel: translate(
        'auto.components.editor.ExternalFileChangeBanner.3fa2b8d417',
        'Reload from Disk'
      ),
      confirmVariant: 'destructive',
      ignoresOpeningGesture: true
    })
    if (
      confirmed &&
      useAppStore.getState().openFiles.find((openFile) => openFile.id === file.id)
        ?.externalMutation === 'changed'
    ) {
      discardDraftAndReloadContent(file, reloadContent)
    }
  }
  const handleKeepEdits = (): void => {
    trackExternalChangeConflictAction(file, 'keep')
    keepTabEditsOverExternalChange(file)
  }
  const handleCompare = (): void => {
    trackExternalChangeConflictAction(file, 'compare')
    setCompareOpen(true)
  }

  return (
    // Why: role=alert because the banner appears asynchronously (an agent
    // rewrote the file) — screen readers must announce it unprompted.
    <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {/* Why: wraps instead of truncating — the overwrite warning at the
              end of the sentence is the part the user must not lose. */}
          <span className="min-w-0 font-medium text-foreground">
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.7c41e90d12',
              'This file changed on disk while you have unsaved edits. Saving will overwrite the newer disk content.'
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" variant="outline" onClick={handleCompare}>
            {translate('auto.components.editor.ExternalFileChangeBanner.90b2ce7d43', 'Compare')}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => void handleReload()}>
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.3fa2b8d417',
              'Reload from Disk'
            )}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={handleKeepEdits}>
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.a95d02c644',
              'Keep My Edits'
            )}
          </Button>
        </div>
      </div>
      {compareOpen && (
        <ExternalFileChangeCompareDialog
          file={file}
          currentContent={currentContent}
          open={compareOpen}
          onOpenChange={setCompareOpen}
          onReload={() => void handleReload()}
          onKeepEdits={handleKeepEdits}
        />
      )}
    </div>
  )
}
