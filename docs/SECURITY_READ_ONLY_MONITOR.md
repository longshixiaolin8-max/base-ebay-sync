# On-demand Security Copilot — CloudWatch source (read-only)

Status: optional manual diagnostic tool, **not deployed and not scheduled**.

Prerequisites: AWS CLI v2, a profile authorized for `cloudwatch:GetMetricData` in the intended region, Node 22, and workspace install/build. This uses only six **fixed-name** `AiEcPlatform / SecurityDenials` aggregate metrics; never raw CloudWatch Logs, OAuth secrets, IPs, passwords, Stripe details, customer data or model prompts. All metric names are hardcoded.

Run from repo root:

```sh
pnpm install --frozen-lockfile
pnpm build
AWS_PROFILE=security-audit AWS_REGION=us-east-2 pnpm security:report
```

The script asks CloudWatch for the last **completed five-minute interval**, validates the returned structure, and prints deterministic incident findings. Exit codes: 0=no threshold breaches, 1=one or more findings, 2=query/parsing failure. A zero metric might mean no attacks or that logging is **not deployed**; independently check Lambda invocation + custom metric presence, and don't claim a clean security posture based on empty series.

This CLI may incur small CloudWatch metric retrieval charges. It never calls Bedrock/OpenAI, schedules another run, or changes IAM/WAF/tenants/products/Stripe. IAM may scope `cloudwatch:GetMetricData` to `Resource:"*"` because this AWS action has no per-metric resource-level scope; enforce human principal access via identity policies/SCPs. See AWS pricing and security review before giving an operator the credentials.

Do not attach this script to a scheduled workflow automatically. For continuous alerting, six CloudWatch alarms already exist in MonitoringStack and will forward to the incident SNS topic **after approved deployment**. Verify subscription and alarm test in dev first.

Known limitations: only counter-based detection for six event classes; not GuardDuty findings, security scans or WAF request analysis; lack of data is not an all-clear. Optional model interpretation is implemented separately in `explainSecurityReport` but never enabled here because an LLM is not an access control decision-maker.

Official API: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudwatch/command/GetMetricDataCommand/
