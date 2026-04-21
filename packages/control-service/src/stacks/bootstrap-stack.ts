import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

/**
 * BootstrapStack — core AWS primitives for gateway-node bootstrap.
 *
 * Resources provisioned:
 *   - S3 bucket:        stores compose bundles, systemd units, and manifest files
 *   - DynamoDB table:   records node enrollment state and last-applied revision
 *   - SSM Parameter:    stores the current desired-state manifest path
 *   - KMS key:          used to encrypt secrets at rest and sign enrollment tokens
 *   - Secrets Manager:  placeholder secret showing the secret-ref pattern
 *   - IAM role:         node-agent assume-role, grants minimal S3/SSM/Secrets read
 *   - Lambda functions: enroll, activate, manifest, heartbeat handlers
 *   - API Gateway:      REST API exposing the four Lambda functions
 */
export class BootstrapStack extends cdk.Stack {
  public readonly artifactBucket: s3.Bucket;
  public readonly enrollmentTable: dynamodb.Table;
  public readonly nodeAgentRole: iam.Role;
  public readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // KMS key — encrypts S3 objects, DynamoDB, and Secrets Manager secrets
    // -----------------------------------------------------------------------
    const bootstrapKey = new kms.Key(this, 'BootstrapKey', {
      description: 'gateway-node-bootstrap encryption key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------------
    // S3 — artifact storage: compose bundles, unit files, manifest snapshots
    // -----------------------------------------------------------------------
    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `gateway-node-bootstrap-artifacts-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: bootstrapKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------------
    // DynamoDB — node enrollment records
    //   PK: nodeId (physical node identifier, e.g. EC2 instance-id or UUID)
    //   SK: "enrollment" | "revision#<rev>" for enrollment + revision history
    // -----------------------------------------------------------------------
    this.enrollmentTable = new dynamodb.Table(this, 'EnrollmentTable', {
      tableName: 'gateway-node-enrollment',
      partitionKey: { name: 'nodeId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: bootstrapKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------------
    // SSM Parameter — path to the current manifest in S3
    // -----------------------------------------------------------------------
    new ssm.StringParameter(this, 'ManifestPointer', {
      parameterName: '/gateway/bootstrap/manifest-s3-uri',
      description: 'S3 URI of the current desired-state node manifest',
      stringValue: `s3://${this.artifactBucket.bucketName}/manifests/current.json`,
    });

    // -----------------------------------------------------------------------
    // Secrets Manager — example secret using the secret-ref pattern.
    // Nodes reference secrets by name (/gateway/…) and retrieve values at
    // runtime; secret values are never stored in the manifest.
    // -----------------------------------------------------------------------
    new secretsmanager.Secret(this, 'ExampleNodeSecret', {
      secretName: '/gateway/bootstrap/example-node-secret',
      description: 'Placeholder secret demonstrating the secret-ref naming convention',
      encryptionKey: bootstrapKey,
    });

    // -----------------------------------------------------------------------
    // IAM — node-agent role
    // Nodes assume this role via instance profile or EC2 metadata service.
    // Permissions are minimal: read artifacts, read the manifest pointer, and
    // read secrets by name pattern.
    // -----------------------------------------------------------------------
    this.nodeAgentRole = new iam.Role(this, 'NodeAgentRole', {
      roleName: 'gateway-node-agent',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Minimal role assumed by the gateway node bootstrap agent',
    });

    this.artifactBucket.grantRead(this.nodeAgentRole);

    this.nodeAgentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadManifestPointer',
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/gateway/bootstrap/*`,
      ],
    }));

    this.nodeAgentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadNodeSecrets',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/gateway/*`,
      ],
    }));

    this.nodeAgentRole.addToPolicy(new iam.PolicyStatement({
      sid: 'UseBootstrapKey',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [bootstrapKey.keyArn],
    }));

    // -----------------------------------------------------------------------
    // Lambda — shared execution role for all control-service handlers
    // -----------------------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'ControlServiceLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for gateway-node-bootstrap control service Lambdas',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    this.enrollmentTable.grantReadWriteData(lambdaRole);
    this.artifactBucket.grantRead(lambdaRole);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadManifestPointerForLambda',
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/gateway/bootstrap/*`,
      ],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'UseBootstrapKeyForLambda',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [bootstrapKey.keyArn],
    }));

    // Shared Lambda environment variables
    const lambdaEnv: Record<string, string> = {
      ENROLLMENT_TABLE_NAME: this.enrollmentTable.tableName,
      MANIFEST_BUCKET_NAME: this.artifactBucket.bucketName,
      MANIFEST_SSM_PARAM: '/gateway/bootstrap/manifest-s3-uri',
    };

    const lambdaDefaults: Partial<lambda_nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      role: lambdaRole,
      environment: lambdaEnv,
      bundling: { minify: true, sourceMap: false },
    };

    const enrollFn = new lambda_nodejs.NodejsFunction(this, 'EnrollFunction', {
      ...lambdaDefaults,
      entry: path.join(__dirname, '../lambdas/enroll.ts'),
      handler: 'handler',
      description: 'Creates a pending enrollment record and issues a single-use bootstrap token',
    });

    const activateFn = new lambda_nodejs.NodejsFunction(this, 'ActivateFunction', {
      ...lambdaDefaults,
      entry: path.join(__dirname, '../lambdas/activate.ts'),
      handler: 'handler',
      description: 'Validates enrollment token and marks node as active',
    });

    const manifestFn = new lambda_nodejs.NodejsFunction(this, 'ManifestFunction', {
      ...lambdaDefaults,
      entry: path.join(__dirname, '../lambdas/manifest.ts'),
      handler: 'handler',
      description: 'Returns the current desired-state manifest for an enrolled node',
    });

    const heartbeatFn = new lambda_nodejs.NodejsFunction(this, 'HeartbeatFunction', {
      ...lambdaDefaults,
      entry: path.join(__dirname, '../lambdas/heartbeat.ts'),
      handler: 'handler',
      description: 'Records node heartbeat and last-applied revision',
    });

    // -----------------------------------------------------------------------
    // API Gateway — REST API for the control service
    // -----------------------------------------------------------------------
    this.api = new apigw.RestApi(this, 'BootstrapApi', {
      restApiName: 'gateway-node-bootstrap-api',
      description: 'Control service API for gateway-node enrollment and bootstrap',
      deployOptions: { stageName: 'v1' },
    });

    const enrollResource = this.api.root.addResource('enroll');
    enrollResource.addMethod('POST', new apigw.LambdaIntegration(enrollFn));

    const activateResource = this.api.root.addResource('activate');
    activateResource.addMethod('POST', new apigw.LambdaIntegration(activateFn));

    const manifestResource = this.api.root.addResource('manifest');
    manifestResource.addMethod('GET', new apigw.LambdaIntegration(manifestFn));

    const heartbeatResource = this.api.root.addResource('heartbeat');
    heartbeatResource.addMethod('POST', new apigw.LambdaIntegration(heartbeatFn));

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      description: 'S3 bucket for bootstrap artifacts',
    });

    new cdk.CfnOutput(this, 'EnrollmentTableName', {
      value: this.enrollmentTable.tableName,
      description: 'DynamoDB table for node enrollment records',
    });

    new cdk.CfnOutput(this, 'NodeAgentRoleArn', {
      value: this.nodeAgentRole.roleArn,
      description: 'IAM role ARN for the node bootstrap agent',
    });

    new cdk.CfnOutput(this, 'ControlServiceApiUrl', {
      value: this.api.url,
      description: 'Base URL of the gateway-node-bootstrap control service API',
    });
  }
}
