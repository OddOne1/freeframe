'use client'

import * as React from 'react'
import { CloudUpload, Film, Music, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  fromDirectoryInput,
  readDroppedEntries,
  type DroppedFile,
} from '@/lib/read-dropped-entries'

interface UploadZoneProps {
  /** Every file, with the folder path it came from. A loose file has an
   *  empty path — the caller decides what to do with structure (§49). */
  onFilesSelected: (files: DroppedFile[]) => void
  className?: string
}

export function UploadZone({ onFilesSelected, className }: UploadZoneProps) {
  const [isDragging, setIsDragging] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const folderInputRef = React.useRef<HTMLInputElement>(null)

  /** Loose files, from the plain picker or a flat drop. */
  const handleFiles = React.useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      onFilesSelected(Array.from(files).map((file) => ({ file, path: [] })))
    },
    [onFilesSelected],
  )

  const handleFolderInput = React.useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      onFilesSelected(fromDirectoryInput(Array.from(files)))
    },
    [onFilesSelected],
  )

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set false when leaving the outer element
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    // `items` first: a dropped folder is only visible through
    // webkitGetAsEntry, and `.files` flattens it to nothing usable — which
    // is exactly why dropping a folder used to stall the uploader (§49).
    const dropped = await readDroppedEntries(e.dataTransfer)
    if (dropped !== null) {
      if (dropped.length > 0) onFilesSelected(dropped)
      return
    }
    // Kept for browsers that do not populate `items`.
    handleFiles(e.dataTransfer.files)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors',
        isDragging
          ? 'border-accent bg-accent-muted/30'
          : 'border-border bg-bg-secondary hover:border-border-focus hover:bg-bg-tertiary',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        /* Sidecar extensions are listed too: the picker greys out anything not
           named here, so without them a CDL or DJI telemetry file could only be
           added by dragging it in. Kept in sync with SIDECAR_EXTENSION_RE in
           stores/upload-store.ts. */
        accept="video/*,audio/*,image/*,application/mxf,.mxf,.mov,.mts,.m2ts,.braw,.r3d,.ari,.arri,.dng,.cine,.dpx,.exr,.cdl,.cc,.ccc,.ale,.xml,.srt,.cpi,.nksc,.rmd,.bim,.cif"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = '' // let the same selection be re-picked
        }}
      />
      {/* A second input, because one control cannot offer both: Windows'
          webkitdirectory picker blocks file selection and the plain picker
          blocks folders (§48-REVISED — WeTransfer ships the same split). */}
      <input
        ref={folderInputRef}
        type="file"
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        multiple
        className="hidden"
        onChange={(e) => {
          handleFolderInput(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Frame.io-style cloud icon */}
      <div className="flex flex-col items-center justify-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-bg-tertiary text-text-tertiary">
          <CloudUpload className="h-10 w-10" />
        </div>
      </div>

      {/* Text */}
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-sm text-text-secondary">
          Drag files and folders to upload.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }}
          >
            Add files
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click() }}
          >
            Add folder
          </button>
        </div>
      </div>
    </div>
  )
}
