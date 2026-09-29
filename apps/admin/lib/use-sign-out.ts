"use client";

import { signOut } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Shared between Sidebar and Topbar's user menu -- both need the same
 *  sign-out-then-redirect-to-/login behavior with its own loading flag. */
export function useSignOut(): { signingOut: boolean; handleSignOut: () => Promise<void> } {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      router.replace("/login");
    }
  }

  return { signingOut, handleSignOut };
}
