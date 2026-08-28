import type { AIGeneratedListing } from "@ai-ec/core";
import { enforceGuardrails } from "./guardrail.js";
import type { AIModelClient } from "./model-client.js";
import { buildGenerationPrompt, type SourceProductFacts } from "./prompt.js";

export async function generateEbayListing(
  modelClient: AIModelClient,
  source: SourceProductFacts,
): Promise<AIGeneratedListing> {
  const prompt = buildGenerationPrompt(source);
  const raw = await modelClient.generateJson(prompt);
  return enforceGuardrails(raw, source);
}
