/**
 * Protects expensive N+1 dashboard DB queries from untrusted URL parameters.
 * Return null for invalid input instead of silently widening a query.
 */
export function boundedDashboardLimit(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d{0,3}$/.test(raw)) return null;
  const value = Number(raw);
  return value <= max ? value : null;
}
