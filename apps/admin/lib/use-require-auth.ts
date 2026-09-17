"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "./amplify-config";
import { apiGet } from "./api-client";

interface BillingStatus {
  status: "pending_payment" | "active" | "past_due" | "canceled_grace" | "canceled";
}

/**
 * Redirects to /login when there is no active Cognito session, and to /billing when the
 * tenant's own billing status isn't 'active' (Phase 2 of the SaaS conversion) -- the one
 * central chokepoint every protected page already calls, so this covers all of them without
 * per-page changes. A failure fetching billing status itself (network/5xx, as opposed to a
 * clean "not active" answer) fails open rather than locking the operator out on a transient
 * error; the existing real tenant is unaffected either way since its status is 'active'.
 *
 * 'canceled_grace' is deliberately NOT redirected here: the whole point of that status is
 * that the tenant keeps read-only access to every page (so it can still view/export its own
 * data), not just the billing page -- admin-api's own gate is what actually enforces
 * read-only (any write 402s), this is just the client-side routing.
 */
export function useRequireAuth(): { ready: boolean } {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const onBillingPage = pathname?.replace(/\/$/, "") === "/billing";

  useEffect(() => {
    ensureAmplifyConfigured();
    fetchAuthSession()
      .then(async (session) => {
        if (!session.tokens) {
          router.replace("/login");
          return;
        }
        if (onBillingPage) {
          setReady(true);
          return;
        }
        try {
          const billing = await apiGet<BillingStatus>("/admin/billing/status");
          if (billing.status !== "active" && billing.status !== "canceled_grace") {
            router.replace("/billing");
            return;
          }
        } catch {
          // fail open -- see doc comment above.
        }
        setReady(true);
      })
      .catch(() => router.replace("/login"));
  }, [router, onBillingPage]);

  return { ready };
}
