export const LEGAL_INFO = {
  operatorName: process.env.NEXT_PUBLIC_LEGAL_OPERATOR_NAME ?? "未設定",
  address: process.env.NEXT_PUBLIC_LEGAL_ADDRESS ?? "未設定",
  phone: process.env.NEXT_PUBLIC_LEGAL_PHONE ?? "未設定",
  email: process.env.NEXT_PUBLIC_LEGAL_EMAIL ?? "未設定",
};

// This is 特定商取引法 disclosure copy -- a production build that silently ships "未設定" for
// any of these fields is a real compliance gap, not just a cosmetic placeholder, so it's
// surfaced loudly in build/server logs rather than only being visible by clicking through to
// /legal in a browser.
if (process.env.NODE_ENV === "production" && Object.values(LEGAL_INFO).some((v) => v === "未設定")) {
  console.error(
    "[legal-config] One or more NEXT_PUBLIC_LEGAL_* environment variables are unset in a " +
      "production build -- the /legal page will show \"未設定\" for required 特定商取引法 disclosure fields.",
  );
}

export const TERMS_VERSION = "2026-10-03";
export const PRIVACY_VERSION = "2026-10-03";
