import os
import aws_cdk as cdk
from pipeline_stack import DjiAwsPipelineStack
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

app = cdk.App()

DjiAwsPipelineStack(
    app,
    "DjiAwsPipelineStack",
    env=cdk.Environment(
        account="437868225618",
        region="us-east-1",
    ),
)

app.synth()
