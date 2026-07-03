#Imports
import os
from aws_cdk import (
    Stack,
    Duration,
    CfnOutput,
    aws_lambda as lambda_,
    aws_lambda_event_sources as lambda_es,
    aws_apigateway as apigw,
    aws_iam as iam,
    aws_logs as logs,
    aws_cloudwatch as cw,
    aws_s3 as s3,
    aws_s3_notifications as s3n,
)
from constructs import Construct

BUCKET_NAME = "salmon-enumeration-ml-prod"
LANDING_PREFIX = "landing/"


class DjiAwsPipelineStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(scope, construct_id, **kwargs)

        # IAM user for dji-flighthub-sync with permissions to upload to S3
        dji_user = iam.User(self, "DjiSyncUser", user_name="dji-flighthub-sync")

        # IAM role for DJI FlightHub Sync to assume when uploading media to S3
        dji_role = iam.Role(
            self, "DjiSyncRole",
            role_name="dji-flighthub-sync-role",
            assumed_by=iam.ArnPrincipal(dji_user.user_arn),
            description="Assumed by DJI FlightHub Sync to upload media directly to S3",
        )

        dji_role.add_to_policy(iam.PolicyStatement(
            actions=["s3:PutObject"],
            resources=[f"arn:aws:s3:::{BUCKET_NAME}/{LANDING_PREFIX}*"],
        ))

        #DJI user permissions to assume the role and list/upload to S3
        dji_user.add_to_policy(iam.PolicyStatement(
            actions=["sts:AssumeRole"],
            resources=[dji_role.role_arn],
        ))

        dji_user.add_to_policy(iam.PolicyStatement(
            actions=["s3:ListBucket"],
            resources=[f"arn:aws:s3:::{BUCKET_NAME}"],
        ))
        dji_user.add_to_policy(iam.PolicyStatement(
            actions=[
                "s3:GetObject",
                "s3:GetObjectTagging",
                "s3:PutObjectTagging",
                "s3:PutObject",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts",
            ],
            resources=[f"arn:aws:s3:::{BUCKET_NAME}/*"],
        ))

        # Webhook Handler Lambda function with env variables
        handler = lambda_.Function(
            self, "WebhookHandler",
            function_name="dji-webhook-handler",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="webhook_handler.handler",
            code=lambda_.Code.from_asset("../lambda"),
            timeout=Duration.minutes(15),
            memory_size=1024,
            environment={
                "BUCKET_NAME": BUCKET_NAME,
                "LANDING_PREFIX": LANDING_PREFIX,
                "DJI_BASE_URL": "https://es-flight-api-us.djigate.com",
                "DJI_ORG_UUID": os.getenv("DJI_ORG_UUID", ""),
                "DJI_PROJECT_UUID": os.getenv("DJI_PROJECT_UUID", ""),
                "DJI_OPENAPI_KEY": os.getenv("DJI_OPENAPI_KEY", ""),
                "FRONTEND_API_URL": "https://salmon.projectkiwi.io",
                "FRONTEND_API_KEY": os.getenv("FRONTEND_API_KEY", ""),
                "FRONTEND_PROJECT_ID": os.getenv("FRONTEND_PROJECT_ID", ""),
            },
            log_retention=logs.RetentionDays.ONE_MONTH,
        )

        # Lambda IAM Permissions
        handler.add_to_role_policy(iam.PolicyStatement(
            actions=["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            resources=[f"arn:aws:s3:::{BUCKET_NAME}/*"],
        ))
        handler.add_to_role_policy(iam.PolicyStatement(
            actions=["s3:ListBucket"],
            resources=[f"arn:aws:s3:::{BUCKET_NAME}"],
        ))

        # API Gateway to recieve DJI FlightHub Sync webhooks and trigger the Lambda function
        api = apigw.RestApi(
            self, "WebhookApi",
            rest_api_name="dji-webhook-api",
            description="DJI FlightHub Sync webhook receiver",
            deploy_options=apigw.StageOptions(stage_name="prod"),
        )

        dji_resource = api.root.add_resource("dji")
        notify_resource = dji_resource.add_resource("notify")
        notify_resource.add_method(
            "POST",
            apigw.LambdaIntegration(
                handler,
                proxy=True,
                timeout=Duration.seconds(29),
            ),
        )

        # CloudWatch Dashboard – Alaska time, ERROR highlight
        log_group = handler.log_group

        dashboard = cw.Dashboard(
            self, "DjiPipelineDashboard",
            dashboard_name="DJI-Pipeline-Monitor",
            default_interval=Duration.hours(24),
        )

        error_metric_filter = logs.MetricFilter(
            self, "ErrorMetricFilter",
            log_group=log_group,
            filter_pattern=logs.FilterPattern.literal("ERROR"),
            metric_name="DjiWebhookErrors",
            metric_namespace="DjiPipeline",
        )

        dashboard.add_widgets(
            cw.LogQueryWidget(
                title="Lambda Logs (All)",
                log_group_names=[log_group.log_group_name],
                query_string=(
                    "fields datefloor(@timestamp, 1s) as ts, @message"
                    " | sort @timestamp desc"
                    " | limit 1000"
                ),
                width=24,
                height=8,
            ),
            cw.LogQueryWidget(
                title="Search Logs",
                log_group_names=[log_group.log_group_name],
                query_string=(
                    "fields datefloor(@timestamp, 1s) as ts, @message"
                    " | filter @message like /SEARCH_TERM/"
                    " | sort @timestamp desc"
                    " | limit 500"
                ),
                width=24,
                height=6,
            ),
            cw.LogQueryWidget(
                title="ERROR Logs Only",
                log_group_names=[log_group.log_group_name],
                query_string=(
                    "fields datefloor(@timestamp, 1s) as ts, @message"
                    " | filter @message like /ERROR/"
                    " | sort @timestamp desc"
                    " | limit 500"
                ),
                width=24,
                height=6,
            ),
            cw.GraphWidget(
                title="Error Count Over Time",
                left=[
                    error_metric_filter.metric(
                        statistic="Sum",
                        period=Duration.minutes(5),
                    ),
                ],
                width=12,
                height=6,
            ),
            cw.GraphWidget(
                title="Invocations & Duration",
                left=[
                    handler.metric_invocations(period=Duration.minutes(5)),
                ],
                right=[
                    handler.metric_duration(period=Duration.minutes(5)),
                ],
                width=12,
                height=6,
            ),
        )

        # ── Video Compression ────────────────────────────────────────────────────

        # FFmpeg Lambda Layer
        # Download the static Linux x86_64 FFmpeg binary and place it at:
        #   dji-pipeline/ffmpeg-layer/bin/ffmpeg
        # then redeploy. Get it from: https://johnvansickle.com/ffmpeg/
        ffmpeg_layer = lambda_.LayerVersion(
            self, "FfmpegLayer",
            code=lambda_.Code.from_asset("../ffmpeg-layer"),
            compatible_runtimes=[lambda_.Runtime.PYTHON_3_12],
            description="Static FFmpeg binary for video compression",
        )

        # Compression Lambda — triggered by S3 PutObject on video files
        compress_handler = lambda_.Function(
            self, "CompressVideoHandler",
            function_name="dji-compress-video",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="compress_video.handler",
            code=lambda_.Code.from_asset("../lambda"),
            timeout=Duration.minutes(15),
            memory_size=4096,
            ephemeral_storage_size=lambda_.Size.gibibytes(10),
            layers=[ffmpeg_layer],
            environment={
                "BUCKET_NAME": BUCKET_NAME,
                "FFMPEG_PATH": "/opt/bin/ffmpeg",
                "FRONTEND_API_URL": os.getenv("FRONTEND_API_URL", "https://salmon.projectkiwi.io"),
                "FRONTEND_API_KEY": os.getenv("FRONTEND_API_KEY", ""),
            },
            log_retention=logs.RetentionDays.ONE_MONTH,
        )

        compress_handler.add_to_role_policy(iam.PolicyStatement(
            actions=["s3:GetObject", "s3:PutObject"],
            resources=[f"arn:aws:s3:::{BUCKET_NAME}/*"],
        ))

        # S3 bucket reference (already exists — import by name)
        media_bucket = s3.Bucket.from_bucket_name(self, "MediaBucket", BUCKET_NAME)

        # Trigger compression for any uploaded video (exclude compressed/ prefix)
        for ext in [".mp4", ".MP4", ".mov", ".MOV"]:
            media_bucket.add_event_notification(
                s3.EventType.OBJECT_CREATED,
                s3n.LambdaDestination(compress_handler),
                s3.NotificationKeyFilter(suffix=ext),
            )

        # CloudWatch alarm for compression failures
        compress_error_filter = logs.MetricFilter(
            self, "CompressErrorFilter",
            log_group=compress_handler.log_group,
            filter_pattern=logs.FilterPattern.literal("COMPRESSION ERROR"),
            metric_name="VideoCompressionErrors",
            metric_namespace="DjiPipeline",
            default_value=0,
        )

        compression_alarm = cw.Alarm(
            self, "CompressionFailureAlarm",
            alarm_name="VideoCompressionFailed",
            alarm_description="One or more DJI videos failed to compress. Check the dji-compress-video Lambda logs.",
            metric=compress_error_filter.metric(
                statistic="Sum",
                period=Duration.minutes(5),
            ),
            threshold=1,
            evaluation_periods=1,
            comparison_operator=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treat_missing_data=cw.TreatMissingData.NOT_BREACHING,
        )

        dashboard.add_widgets(
            cw.AlarmWidget(
                title="Video Compression Failures",
                alarm=compression_alarm,
                width=12,
                height=4,
            ),
            cw.LogQueryWidget(
                title="Compression Error Logs",
                log_group_names=[compress_handler.log_group.log_group_name],
                query_string=(
                    "fields datefloor(@timestamp, 1s) as ts, @message"
                    " | filter @message like /COMPRESSION ERROR/"
                    " | sort @timestamp desc"
                    " | limit 200"
                ),
                width=12,
                height=4,
            ),
        )

        #Cfn Outputs
        CfnOutput(self, "WebhookUrl",
            value=f"{api.url}dji/notify",
            description="Paste this URL into DJI FlightHub Sync webhook config",
        )
        CfnOutput(self, "DjiRoleArn",
            value=dji_role.role_arn,
            description="IAM role ARN for DJI FlightHub Sync storage config",
        )
        CfnOutput(self, "DjiUserArn",
            value=dji_user.user_arn,
            description="Create an access key for this user in IAM console for DJI storage config",
        )
        CfnOutput(self, "BucketName",
            value=BUCKET_NAME,
        )
        CfnOutput(self, "LandingPrefix",
            value=LANDING_PREFIX,
            description="Configure DJI FlightHub Sync to upload into this prefix",
        )
