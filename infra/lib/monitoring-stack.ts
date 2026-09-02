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
  }
}
