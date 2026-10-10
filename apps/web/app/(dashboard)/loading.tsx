import * as React from 'react'
import { Skeleton, SkeletonGrid, SkeletonText } from '@/components/shared/skeleton'

export default function DashboardLoading() {
  return (
    <div className="flex h-dvh overflow-hidden bg-bg-primary">
      {/* Sidebar placeholder */}
      <aside className="fixed left-0 top-0 hidden h-dvh w-60 flex-col border-r border-border bg-bg-secondary md:flex">
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-3">
          <Skeleton className="h-7 w-7 rounded-md" />
          <Skeleton className="h-4 w-24" />
        </div>

        {/* Nav items */}
        <nav className="flex-1 space-y-1 px-1.5 py-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-2">
              <Skeleton className="h-4 w-4 shrink-0" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </nav>

        {/* Bottom user area */}
        <div className="border-t border-border p-2">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
            <div className="flex flex-col gap-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2.5 w-28" />
            </div>
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <main className="ml-60 flex flex-1 flex-col overflow-hidden">
        {/* Header placeholder */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-bg-primary px-4">
          <Skeleton className="h-8 w-64 rounded-lg" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </header>

        {/* Content skeleton */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Page title */}
          <div className="space-y-2">
            <SkeletonText width="w-48" className="h-6" />
            <SkeletonText width="w-80" className="h-4" />
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-border bg-bg-secondary p-4 space-y-3"
              >
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-7 w-16" />
              </div>
            ))}
          </div>

          {/* Content grid */}
          <SkeletonGrid count={6} />
        </div>
      </main>
    </div>
  )
}
