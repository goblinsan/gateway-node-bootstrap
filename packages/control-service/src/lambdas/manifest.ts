/**
 * GET /manifest
 *
 * Node-facing endpoint that returns the current desired-state NodeManifest
 * for an actively enrolled node.
 *
 * Required query parameters:
 *   instanceId — the EC2 instance ID of the requesting node
 *
 * The node must have an active enrollment record (created via POST /activate).
 * The manifest JSON is read from S3 using the URI stored in SSM Parameter Store.
 *
 * Response: NodeManifest JSON (Content-Type: application/json)
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const TABLE_NAME = process.env.ENROLLMENT_TABLE_NAME ?? '';
const MANIFEST_SSM_PARAM = process.env.MANIFEST_SSM_PARAM ?? '/gateway/bootstrap/manifest-s3-uri';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ssm = new SSMClient({});

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const instanceId = event.queryStringParameters?.instanceId;
  if (!instanceId) {
    return jsonResponse(400, { error: 'instanceId query parameter is required' });
  }

  // Verify the node has an active enrollment
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { nodeId: instanceId, sk: 'enrollment' },
    })
  );

  const record = result.Item;
  if (!record || record.status !== 'active') {
    return jsonResponse(403, {
      error: 'Node is not enrolled. Complete POST /activate before requesting the manifest.',
    });
  }

  // Read manifest URI from SSM
  let manifestUri: string;
  try {
    const ssmResp = await ssm.send(
      new GetParameterCommand({ Name: MANIFEST_SSM_PARAM })
    );
    manifestUri = ssmResp.Parameter?.Value ?? '';
    if (!manifestUri) {
      return jsonResponse(503, { error: 'Manifest URI not configured' });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[manifest] Failed to read SSM parameter: ${msg}`);
    return jsonResponse(503, { error: 'Failed to retrieve manifest location' });
  }

  // Parse S3 URI and fetch the manifest object
  let manifestBody: string;
  try {
    const url = new URL(manifestUri);
    const bucket = url.hostname;
    const key = url.pathname.slice(1);
    const s3Resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!s3Resp.Body) {
      return jsonResponse(503, { error: 'Manifest object is empty' });
    }
    const buf = await streamToBuffer(s3Resp.Body as AsyncIterable<Uint8Array>);
    manifestBody = buf.toString('utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[manifest] Failed to fetch manifest from S3: ${msg}`);
    return jsonResponse(503, { error: 'Failed to retrieve manifest' });
  }

  // Return the manifest JSON directly (pass-through)
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: manifestBody,
  };
}
