import * as cdk from 'aws-cdk-lib';
import { BootstrapStack } from './stacks/bootstrap-stack';

const app = new cdk.App();

new BootstrapStack(app, 'GatewayNodeBootstrap', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Gateway-node bootstrap control plane',
});

app.synth();
