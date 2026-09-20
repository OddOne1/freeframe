"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useUploadStore } from "@/stores/upload-store";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { CommandPalette } from "@/components/layout/command-palette";
import { UploadsPanel } from "@/components/layout/uploads-panel";
import { UploadSSEBridge } from "@/components/layout/upload-sse-bridge";
import {
  AccountSetupGate,
  accountSetupOutstanding,
} from "@/components/auth/account-setup-gate";
import { cn } from "@/lib/utils";

/**
 * Everything the dashboard chrome does that needs a browser.
 *
 * Split out of app/(dashboard)/layout.tsx in §178: that file is now an
 * async server component, so it can fetch branding before first paint and
 * hand it down. Nothing below changed in the move.
 */
export function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(true);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const { fetchUser, user } = useAuthStore();
  const { fetchHistory } = useUploadStore();

  // §200 — read from /auth/me, which computes it server-side from the stored
  // data. This is presentation: middleware/account_gate.py already answers
  // 403 to every protected route while it is true, so the purpose here is to
  // show the person WHY nothing loads and give them the two forms, rather
  // than to enforce anything.
  const gated = accountSetupOutstanding(user);

  // Hide header on asset viewer pages — the viewer has its own top bar
  const isAssetViewer = /\/projects\/[^/]+\/assets\/[^/]+/.test(pathname);

  React.useEffect(() => {
    fetchUser();
    fetchHistory();
  }, [fetchUser, fetchHistory]);

  // Global keyboard shortcut for command palette
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (gated && user) {
    // Rendered INSTEAD of the whole shell, not inside it. The sidebar and
    // header are navigation into an app that answers 403 to everything, and
    // the uploads panel would keep polling endpoints it cannot reach —
    // showing them would be an interface that does not work rather than an
    // explanation of why.
    return (
      <div className="h-screen overflow-hidden bg-bg-primary">
        <AccountSetupGate user={user} />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />

      {/* Main content area */}
      <main
        className={cn(
          "flex flex-1 flex-col overflow-hidden transition-[margin] duration-200 ease-spring",
          sidebarCollapsed ? "ml-[52px]" : "ml-[192px]",
        )}
      >
        {!isAssetViewer && <Header onSearchOpen={() => setCommandOpen(true)} />}

        <div className="relative flex-1 overflow-y-auto">{children}</div>
      </main>

      <UploadsPanel />
      <UploadSSEBridge />
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
