// Only the public contact address is embedded in the statically exported frontend.
// Keep the operator's legal name, physical address and phone out of public build variables.
export const LEGAL_INFO = {
  email: process.env.NEXT_PUBLIC_LEGAL_EMAIL?.trim() || "",
};

export const DISCLOSURE_SUBJECT = "特定商取引法に基づく事業者情報の開示請求";
export const TERMS_VERSION = "2026-10-03";
export const PRIVACY_VERSION = "2026-10-11";
