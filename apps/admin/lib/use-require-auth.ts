"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "./amplify-config";

/** Redirects to /login when there is no active Cognito session. */
export function useRequireAuth(): { ready: boolean } {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureAmplifyConfigured();
    fetchAuthSession()
      .then((session) => {
        if (!session.tokens) {
          router.replace("/login");
        } else {
          setReady(true);
        }
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  return { ready };
}
