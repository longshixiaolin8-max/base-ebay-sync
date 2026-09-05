import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { PlatformConfig } from "./config.js";

export interface MonitoringStackProps extends cdk.StackProps {
  config: PlatformConfig;
  dlqs: sqs.Queue[];
  workerFns: nodejs.NodejsFunction[];
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `ai-ec-platform-${props.config.envName}-alarms`,
    });
    if (props.config.alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.config.alarmEmail));
    }

    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `ai-ec-platform-${props.config.envName}`,
    });

    for (const dlq of props.dlqs) {
      const metric = dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) });
      const alarm = new cloudwatch.Alarm(this, `${dlq.node.id}DepthAlarm`, {
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `Messages landed in ${dlq.node.id} — a sync job exhausted its retries and needs review in the admin dashboard.`,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({ title: dlq.node.id, left: [metric], width: 12 }),
      );
    }

    for (const fn of props.workerFns) {
      const errorMetric = fn.metricErrors({ period: cdk.Duration.minutes(5) });
      const alarm = new cloudwatch.Alarm(this, `${fn.node.id}ErrorAlarm`, {
        metric: errorMetric,
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `${fn.node.id} errored 5+ times in 5 minutes.`,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${fn.node.id} errors/invocations`,
          left: [errorMetric, fn.metricInvocations({ period: cdk.Duration.minutes(5) })],
          width: 12,
        }),
      );
    }

    // Direct-notification gap (user's follow-up ask): a caught-and-retried failure like the
    // Bedrock daily-token-quota outage completes every Lambda invocation "successfully" --
    // caught, logged to sync_errors, no exception escapes -- so it never trips the per-function
    // Errors alarm above. recordSyncError/isChannelIsolated now also emit an EMF custom metric
    // (see @ai-ec/lambda-shared's metrics.ts) specifically so a failure of this shape still
    // reaches the same SNS topic / email subscription. One pair of alarms per known channel,
    // since a metric's dimension values must be static at synth time.
    for (const channel of ["base", "ebay"] as const) {
      const syncErrorMetric = new cloudwatch.Metric({
        namespace: "AiEcPlatform",
        metricName: "SyncErrors",
        dimensionsMap: { Channel: channel },
        statistic: "Sum",
        // A persistent-but-slow-retry failure (confirmed live: the Bedrock daily-token-quota
        // outage re-fails roughly every 12min, since that's the SQS message's visibility
        // timeout, not every invocation) rarely stacks up 3 hits inside a 15min window. A
        // longer period is what actually catches "this has been failing for a while" rather
        // than only a fast-retrying failure.
        period: cdk.Duration.minutes(60),
      });
      const syncErrorAlarm = new cloudwatch.Alarm(this, `${channel}SyncErrorAlarm`, {
        metric: syncErrorMetric,
        threshold: 2,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${channel} recorded 2+ sync errors in the last hour (see sync_errors / the admin sync-trace view for which).`,
      });
      syncErrorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

      const isolatedMetric = new cloudwatch.Metric({
        namespace: "AiEcPlatform",
        metricName: "ChannelIsolated",
        dimensionsMap: { Channel: channel },
        statistic: "Sum",
        period: cdk.Duration.minutes(15),
      });
      const isolatedAlarm = new cloudwatch.Alarm(this, `${channel}IsolatedAlarm`, {
        metric: isolatedMetric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${channel} entered channel isolation (auth failure or rate-limiting) -- polling/publishing is being skipped until it recovers.`,
      });
      isolatedAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${channel}: sync errors / isolation`,
          left: [syncErrorMetric, isolatedMetric],
          width: 12,
        }),
      );
    }
  }
}
