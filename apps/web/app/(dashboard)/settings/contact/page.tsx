"use client";

import * as React from "react";
import useSWR from "swr";
import { LifeBuoy, Loader2, Mail } from "lucide-react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/shared/avatar";
import { EmptyState } from "@/components/shared/empty-state";

/** Matches ContactUserResponse in apps/api/schemas/auth.py -- deliberately
 *  narrower than the full User type, since GET /users/admins is callable by
 *  any authenticated user and returns only these four fields. */
interface ContactUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export default function ContactPage() {
  const { data: admins, isLoading, error } = useSWR<ContactUser[]>(
    "/users/admins",
    (key: string) => api.get<ContactUser[]>(key),
  );

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <LifeBuoy className="h-5 w-5 text-accent" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text-primary">Contact</h1>
          <p className="text-sm text-text-secondary">
            Need help? Reach out to one of the people below.
          </p>
        </div>
        {isLoading && (
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
        )}
      </div>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">
          Administrators
        </h2>

        {error ? (
          <EmptyState
            icon={LifeBuoy}
            title="Couldn't load contacts"
            description="Something went wrong fetching the administrator list. Try reloading the page."
          />
        ) : isLoading ? (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-[68px] rounded-lg border border-border bg-bg-secondary animate-pulse"
              />
            ))}
          </div>
        ) : !admins || admins.length === 0 ? (
          <EmptyState
            icon={LifeBuoy}
            title="No administrators listed"
            description="There are no active administrators to contact right now."
          />
        ) : (
          <div className="space-y-3">
            {admins.map((admin) => (
              <div
                key={admin.id}
                className="flex items-center gap-3 p-4 rounded-lg border border-border bg-bg-secondary"
              >
                <Avatar
                  src={admin.avatar_url}
                  name={admin.name}
                  colorSeed={admin.id}
                  size="lg"
                />
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-text-primary truncate">
                    {admin.name}
                  </h3>
                  <a
                    href={`mailto:${admin.email}`}
                    className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-accent transition-colors"
                  >
                    <Mail className="h-3 w-3 shrink-0" />
                    <span className="truncate">{admin.email}</span>
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
