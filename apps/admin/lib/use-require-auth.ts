"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "./amplify-config";
import { apiGet } from "./api-client";

interface BillingStatus {
  status: "pending_payment" | "active" | "past_due" | "canceled";
}

/**
 * Redirects to /login when there is no active Cognito session, and to /billing when the
 * tenant's own billing status isn't 'active' (Phase 2 of the SaaS conversion) -- the one
 * central chokepoint every protected page already calls, so this covers all of them without
 * per-page changes. A failure fetching billing status itself (network/5xx, as opposed to a
 * clean "not active" answer) fails open rather than locking the operator out on a transient
 * error; the existing real tenant is unaffected either way since its status is 'active'.
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
          if (billing.status !== "active") {
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
