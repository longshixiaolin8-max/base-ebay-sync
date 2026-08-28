export interface PlatformConfig {
  envName: string;
  /** Email address that receives CloudWatch alarm notifications (DLQ depth, Lambda errors). */
  alarmEmail?: string;
  /** AI backend: "bedrock" (default, no external API key needed) or "openai". */
  aiProvider: "bedrock" | "openai";
}

export function loadConfig(envName: string, alarmEmail?: string, aiProvider?: string): PlatformConfig {
  return {
    envName,
    alarmEmail,
    aiProvider: aiProvider === "openai" ? "openai" : "bedrock",
  };
}
