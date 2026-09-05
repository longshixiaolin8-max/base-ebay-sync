export interface FxRateResult {
  fxRateUsdPerJpy: number;
  source: string;
  fetchedAt: Date;
}

const FX_API_URL = "https://api.frankfurter.app/latest?from=JPY&to=USD";

/**
 * Item #4 of the third hardening round ("価格の動的整合"). Fetches a real, live JPY->USD
 * rate from a free, no-API-key public FX service (Frankfurter, backed by European Central
 * Bank reference rates) rather than a hardcoded currency constant. Callers should fall back
 * to a last-resort static rate only if this call itself fails -- never invent a rate.
 */
export async function fetchFxRate(): Promise<FxRateResult> {
  const res = await fetch(FX_API_URL);
  if (!res.ok) throw new Error(`FX rate API error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { rates?: { USD?: number } };
  const rate = json.rates?.USD;
  if (typeof rate !== "number" || !(rate > 0)) {
    throw new Error(`FX rate API returned no usable USD rate: ${JSON.stringify(json)}`);
  }
  return { fxRateUsdPerJpy: rate, source: "frankfurter.app (ECB reference rates)", fetchedAt: new Date() };
}
