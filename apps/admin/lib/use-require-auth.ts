"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "./amplify-config";
import { apiGet } from "./api-client";

interface BillingStatus {
  status: "pending_payment" | "active" | "past_due" | "canceled_grace" | "canceled";
}

interface OAuthStatus {
  base: boolean;
  ebay: boolean;
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
 *
 * A brand-new, paid-up tenant that hasn't connected BASE/eBay yet is additionally sent to
 * /onboarding instead of whatever protected page it happened to land on -- previously a
 * first-time sign-in went straight to /dashboard, an all-zeros screen with no indication
 * that "導入設定" in the sidebar is the actual next step. Only checked once billing is
 * confirmed 'active' (not on a fail-open guess, and not for 'canceled_grace', which is
 * winding down rather than getting started), and only gates BASE/eBay connection itself --
 * the onboarding wizard's later steps (business policies, linking existing listings) are
 * optional/lower-urgency and don't force a redirect away from other pages.
 */
export function useRequireAuth(): { ready: boolean } {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const normalizedPath = pathname?.replace(/\/$/, "");
  const onBillingPage = normalizedPath === "/billing";
  const onOnboardingPage = normalizedPath === "/onboarding";

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
        let confirmedActive = false;
        try {
          const billing = await apiGet<BillingStatus>("/admin/billing/status");
          if (billing.status !== "active" && billing.status !== "canceled_grace") {
            router.replace("/billing");
            return;
          }
          confirmedActive = billing.status === "active";
        } catch {
          // fail open -- see doc comment above.
        }
        if (confirmedActive && !onOnboardingPage) {
          try {
            const oauth = await apiGet<OAuthStatus>("/admin/oauth/status");
            if (!oauth.base || !oauth.ebay) {
              router.replace("/onboarding");
              return;
            }
          } catch {
            // fail open -- same reasoning as the billing check above.
          }
        }
        setReady(true);
      })
      .catch(() => router.replace("/login"));
  }, [router, onBillingPage, onOnboardingPage]);

  return { ready };
}
