/**
 * POST /activate
 *
 * Node-facing endpoint that validates an enrollment token and marks the node
 * as actively enrolled.  Returns the S3 URI of the current desired-state
 * manifest so the node agent can begin bootstrap.
 *
 * Expected request body:
 *   { "instanceId": "i-0abc123", "token": "<hex>" }
 *
 * Response:
 *   { "manifestUri": "s3://...", "profileId": "edge-gateway" }
 *
 * Tokens are single-use: the tokenHash is cleared after successful activation.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import * as crypto from 'crypto';

const TABLE_NAME = process.env.ENROLLMENT_TABLE_NAME ?? '';
const MANIFEST_SSM_PARAM = process.env.MANIFEST_SSM_PARAM ?? '/gateway/bootstrap/manifest-s3-uri';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

interface ActivateRequest {
  instanceId: string;
  token: string;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  let req: ActivateRequest;
  try {
    req = JSON.parse(event.body) as ActivateRequest;
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { instanceId, token } = req;
  if (!instanceId || !token) {
    return jsonResponse(400, { error: 'instanceId and token are required' });
  }

  // Look up the pending enrollment record
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { nodeId: instanceId, sk: 'enrollment' },
    })
  );

  const record = result.Item;
  if (!record) {
    return jsonResponse(404, { error: 'No pending enrollment found for this instance' });
  }

  if (record.status === 'revoked') {
    return jsonResponse(403, { error: 'Enrollment has been revoked' });
  }

  if (record.status !== 'pending') {
    return jsonResponse(409, { error: 'Enrollment token has already been used' });
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (record.expiry < now) {
    return jsonResponse(410, { error: 'Enrollment token has expired' });
  }

  // Verify token using constant-time comparison to prevent timing attacks
  const providedHash = crypto.createHash('sha256').update(token).digest('hex');
  const expectedHash: string = record.tokenHash;
  if (
    providedHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(expectedHash))
  ) {
    return jsonResponse(403, { error: 'Invalid enrollment token' });
  }

  // Fetch manifest URI from SSM
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
    console.error(`[activate] Failed to read SSM parameter: ${msg}`);
    return jsonResponse(503, { error: 'Failed to retrieve manifest location' });
  }

  // Mark enrollment as active and clear the token hash (single-use)
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { nodeId: instanceId, sk: 'enrollment' },
      UpdateExpression:
        'SET #status = :active, lastUpdated = :now REMOVE tokenHash, expiry',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':now': new Date().toISOString(),
      },
    })
  );

  return jsonResponse(200, {
    manifestUri,
    profileId: record.profileId as string,
  });
}
