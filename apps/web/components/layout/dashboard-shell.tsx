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
import { useRightPanelViewportDefault } from "@/hooks/use-right-panel-viewport-default";
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
  // §224 — below `md` the sidebar is an off-canvas drawer rather than a
  // 52px rail, because 52px of a 390px screen is 13% of the width spent on
  // one icon. Separate from `sidebarCollapsed`, which is the desktop
  // rail/expanded preference and must survive a phone visit untouched.
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
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

  // §224 — once per load, and only when the viewport is narrow.
  useRightPanelViewportDefault();

  // A route change closes the drawer: tapping Projects should take you
  // there, not leave the nav sitting over the page you arrived at.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!mobileNavOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileNavOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

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
      <div className="h-dvh overflow-hidden bg-bg-primary">
        <AccountSetupGate user={user} />
      </div>
    );
  }

  return (
    // h-dvh, not h-screen: on iOS Safari `100vh` is the height the viewport
    // has with the toolbars HIDDEN, so a h-screen shell is taller than the
    // visible area and its bottom — which is where §224 puts the phone tab
    // bar — sits under the browser chrome (§224).
    <div className="flex h-dvh overflow-hidden bg-bg-primary">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      {/* Main content area */}
      <main
        className={cn(
          "flex flex-1 flex-col overflow-hidden transition-[margin] duration-200 ease-spring",
          // §224 — no left margin below `md`: the sidebar is off-canvas
          // there, so reserving a rail's width would leave a permanent
          // empty gutter. At `md`+ the margin is exactly what it was.
          "ml-0",
          sidebarCollapsed ? "md:ml-[52px]" : "md:ml-[192px]",
        )}
      >
        {!isAssetViewer && (
          <Header
            onSearchOpen={() => setCommandOpen(true)}
            onMobileNavOpen={() => setMobileNavOpen(true)}
          />
        )}

        <div className="relative flex-1 overflow-y-auto">{children}</div>
      </main>

      <UploadsPanel />
      <UploadSSEBridge />
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
