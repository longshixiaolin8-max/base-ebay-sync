/** Client-side convenience only -- NEXT_PUBLIC_OPERATOR_EMAIL decides whether Sidebar shows
 *  the "/ops" nav link at all, nothing more. The real access control is admin-api's own
 *  requireOperator() check against the server-side OPERATOR_EMAIL env var; a non-operator
 *  who navigates to /ops directly regardless still gets every call 403'd. */
export function isOperatorEmail(email: string | null | undefined): boolean {
  const configured = process.env.NEXT_PUBLIC_OPERATOR_EMAIL;
  return Boolean(configured && email === configured);
}
