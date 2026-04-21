import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
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
 */
export class BootstrapStack extends cdk.Stack {
  public readonly artifactBucket: s3.Bucket;
  public readonly enrollmentTable: dynamodb.Table;
  public readonly nodeAgentRole: iam.Role;

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
  }
}
