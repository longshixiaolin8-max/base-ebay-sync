"use client";

import { Amplify } from "aws-amplify";

let configured = false;

/**
 * Cognito User Pool id/client id and the API base URL are public identifiers (not
 * secrets) — they're safe as NEXT_PUBLIC_* build-time env vars set in Amplify Hosting's
 * build settings, not in Secrets Manager or GitHub.
 */
export function ensureAmplifyConfigured(): void {
  if (configured) return;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID!,
        userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID!,
      },
    },
  });
  configured = true;
}

export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL!;
}
