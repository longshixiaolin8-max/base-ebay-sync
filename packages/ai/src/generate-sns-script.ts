import { SnsScriptDraft } from "@ai-ec/core";
import { AIOutputValidationError } from "./guardrail.js";
import type { AIModelClient } from "./model-client.js";
import { buildSnsScriptPrompt, type SourceProductFacts } from "./prompt.js";

/** Item #6 of the commercial-features round ("SNS管理" -- AI台本生成). Output is a script
 *  only; nothing here creates a video or posts anything. */
export async function generateSnsScript(modelClient: AIModelClient, source: SourceProductFacts): Promise<SnsScriptDraft> {
  const prompt = buildSnsScriptPrompt(source);
  const raw = await modelClient.generateJson(prompt);
  const parsed = SnsScriptDraft.safeParse(raw);
  if (!parsed.success) {
    throw new AIOutputValidationError(parsed.error);
  }
  return parsed.data;
}
