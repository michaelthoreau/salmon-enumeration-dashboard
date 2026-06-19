#Imports
import os
from aws_cdk import (
    Stack,
    Duration,
    CfnOutput,
    aws_lambda as lambda_,
    aws_apigateway as apigw,
    aws_iam as iam,
    aws_logs as logs,
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
