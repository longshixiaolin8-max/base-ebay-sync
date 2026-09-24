export interface PlatformConfig {
  envName: string;
  /** Email address that receives CloudWatch alarm notifications (DLQ depth, Lambda errors). */
  alarmEmail?: string;
  /** AI backend: "bedrock" (default, no external API key needed) or "openai". */
  aiProvider: "bedrock" | "openai";
  /** Monthly AWS Budgets threshold (whole account, USD) that triggers an alarm-topic
   *  notification. AWS Budgets' first two budgets per account are free. */
  monthlyBudgetUsd: number;
}

export function loadConfig(
  envName: string,
  alarmEmail?: string,
  aiProvider?: string,
  monthlyBudgetUsd?: string,
): PlatformConfig {
  return {
    envName,
    alarmEmail,
    aiProvider: aiProvider === "openai" ? "openai" : "bedrock",
    monthlyBudgetUsd: monthlyBudgetUsd ? Number(monthlyBudgetUsd) : 50,
  };
}
