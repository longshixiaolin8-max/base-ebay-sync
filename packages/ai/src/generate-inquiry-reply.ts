import { InquiryReplyDraft } from "@ai-ec/core";
import { AIOutputValidationError } from "./guardrail.js";
import type { AIModelClient } from "./model-client.js";
import { buildInquiryReplyPrompt } from "./prompt.js";

export async function generateInquiryReply(
  modelClient: AIModelClient,
  context: { productTitle: string; productFacts: string; inquiryText: string },
) {
  const prompt = buildInquiryReplyPrompt(context);
  const raw = await modelClient.generateJson(prompt);
  const parsed = InquiryReplyDraft.safeParse(raw);
  if (!parsed.success) {
    throw new AIOutputValidationError(parsed.error);
  }
  return parsed.data;
}
