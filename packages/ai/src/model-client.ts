/** Minimal provider abstraction so the generation pipeline doesn't care whether the
 *  configured backend is OpenAI or Amazon Bedrock. */
export interface AIModelClient {
  /** Sends system+user prompts, returns the raw parsed JSON the model produced. */
  generateJson(prompt: { system: string; user: string }): Promise<unknown>;
}

class ModelResponseParseError extends Error {
  constructor(raw: string, cause: unknown) {
    super(`Model response was not valid JSON: ${String(cause)}. Raw: ${raw.slice(0, 500)}`);
    this.name = "ModelResponseParseError";
  }
}

export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new ModelResponseParseError(trimmed, err);
  }
}

export interface OpenAIModelClientConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/** Uses OpenAI's Chat Completions API with JSON mode. */
export class OpenAIModelClient implements AIModelClient {
  constructor(private readonly config: OpenAIModelClientConfig) {}

  async generateJson(prompt: { system: string; user: string }): Promise<unknown> {
    const res = await fetch(`${this.config.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = json.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI response contained no message content");
    return parseModelJson(content);
  }
}

export interface BedrockModelClientConfig {
  modelId?: string;
  region?: string;
}

/** Uses Amazon Bedrock's Anthropic Claude Messages API. */
export class BedrockModelClient implements AIModelClient {
  constructor(private readonly config: BedrockModelClientConfig = {}) {}

  async generateJson(prompt: { system: string; user: string }): Promise<unknown> {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({ region: this.config.region });
    const command = new InvokeModelCommand({
      modelId: this.config.modelId ?? "anthropic.claude-3-5-sonnet-20241022-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 2000,
        temperature: 0.2,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
    });
    const res = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(res.body)) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = payload.content.find((block) => block.type === "text")?.text;
    if (!text) throw new Error("Bedrock response contained no text content");
    return parseModelJson(text);
  }
}

export type AIProvider = "openai" | "bedrock";

export function createAIModelClient(env: {
  AI_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  BEDROCK_MODEL_ID?: string;
  AWS_REGION?: string;
}): AIModelClient {
  const provider = (env.AI_PROVIDER as AIProvider | undefined) ?? "bedrock";
  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    return new OpenAIModelClient({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
  }
  return new BedrockModelClient({ modelId: env.BEDROCK_MODEL_ID, region: env.AWS_REGION });
}
