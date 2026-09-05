import { StaleProductSuggestion } from "@ai-ec/core";
import { AIOutputValidationError } from "./guardrail.js";
import type { AIModelClient } from "./model-client.js";
import { buildStaleProductSuggestionPrompt, type SourceProductFacts } from "./prompt.js";

/**
 * Item #5 of the commercial-features round ("滞留商品管理" -- AI改善提案). Purely a
 * merchandising-tactics suggestion for a human to act on -- never applied automatically. Any
 * resulting price change or re-listing still goes through this platform's existing
 * human-approval gates (ebay-sync-worker's publish()/update(), the admin UI's approval step).
 */
export async function suggestStaleProductImprovement(
  modelClient: AIModelClient,
  source: SourceProductFacts,
  daysListed: number,
): Promise<StaleProductSuggestion> {
  const prompt = buildStaleProductSuggestionPrompt(source, daysListed);
  const raw = await modelClient.generateJson(prompt);
  const parsed = StaleProductSuggestion.safeParse(raw);
  if (!parsed.success) {
    throw new AIOutputValidationError(parsed.error);
  }
  return parsed.data;
}
