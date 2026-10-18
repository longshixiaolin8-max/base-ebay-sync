// Only the public contact address is embedded in the statically exported frontend.
// Keep the operator's legal name, physical address and phone out of public build variables.
export const LEGAL_INFO = {
  email: process.env.NEXT_PUBLIC_LEGAL_EMAIL?.trim() || "",
};

export const DISCLOSURE_SUBJECT = "特定商取引法に基づく事業者情報の開示請求";

// A production build with no disclosure-request mailbox configured is a real compliance gap
// (there would be no way to honor a 特定商取引法 disclosure request at all), so it's surfaced
// loudly in build/server logs rather than only being visible by clicking through to /legal.
if (process.env.NODE_ENV === "production" && !LEGAL_INFO.email) {
  console.error(
    "[legal-config] NEXT_PUBLIC_LEGAL_EMAIL is unset in a production build -- the /legal and " +
      "/privacy pages will show no way to request the required 特定商取引法 disclosure.",
  );
}

export const TERMS_VERSION = "2026-10-03";
export const PRIVACY_VERSION = "2026-10-11";
