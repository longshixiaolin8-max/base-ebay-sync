import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

const sesClient = new SESv2Client({});

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyText: string;
}

/**
 * Sends a plain-text transactional email via Amazon SES v2. Same "CDK provisions the
 * capability, a human fills in the real configuration after deploy" pattern this platform
 * already uses for BASE/eBay/Stripe/OpenAI credentials (see secrets-stack.ts) -- here the
 * missing piece isn't a secret but SES's own domain/address verification, which needs real
 * DNS access this deploy can't automate. SES_FROM_EMAIL must be set to a verified identity
 * (see README's email delivery setup notes) before this can actually deliver anything; until
 * then it throws a clear, specific error rather than silently no-op'ing, so a caller that
 * forgets to catch it fails loudly in testing instead of "working" with nothing ever sent.
 *
 * Deliberately no retry/queue here -- every call site treats a failed send as best-effort
 * (caught, logged, never allowed to fail the business transaction that triggered it), so a
 * transient SES error just means one notification email is missed, not a stuck job.
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error("SES_FROM_EMAIL is not configured -- see README's email delivery setup notes before this can send anything");
  }
  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: fromEmail,
      Destination: { ToAddresses: [input.to] },
      Content: { Simple: { Subject: { Data: input.subject, Charset: "UTF-8" }, Body: { Text: { Data: input.bodyText, Charset: "UTF-8" } } } },
    }),
  );
}
