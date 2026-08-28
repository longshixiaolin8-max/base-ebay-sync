"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { ensureAmplifyConfigured, getApiBaseUrl } from "./amplify-config";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  ensureAmplifyConfigured();
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new ApiError(401, "Not signed in");
  }

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || res.statusText);
  }
  return res;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await authorizedFetch(path, { method: "GET" });
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await authorizedFetch(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  return res.json() as Promise<T>;
}
