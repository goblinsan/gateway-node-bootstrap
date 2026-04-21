/**
 * POST /enroll
 *
 * Operator-facing endpoint that creates a pending enrollment record for a
 * given EC2 instance and returns a short-lived, single-use bootstrap token.
 *
 * Expected request body:
 *   { "instanceId": "i-0abc123", "profileId": "edge-gateway" }
 *
 * Response:
 *   { "token": "<hex>", "expiresAt": "<ISO-8601>" }
 *
 * The token is stored only as a SHA-256 hash in DynamoDB; the plaintext is
 * returned once and never stored.  The node must present it to POST /activate
 * within TOKEN_TTL_SECONDS.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import * as crypto from 'crypto';

const TABLE_NAME = process.env.ENROLLMENT_TABLE_NAME ?? '';
const TOKEN_TTL_SECONDS = 3600; // 1 hour

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface EnrollRequest {
  instanceId: string;
  profileId: string;
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

  let req: EnrollRequest;
  try {
    req = JSON.parse(event.body) as EnrollRequest;
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { instanceId, profileId } = req;
  if (!instanceId || !profileId) {
    return jsonResponse(400, { error: 'instanceId and profileId are required' });
  }

  // Check for an existing active enrollment to prevent duplicate enrollments
  const existing = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { nodeId: instanceId, sk: 'enrollment' },
    })
  );
  if (existing.Item?.status === 'active') {
    return jsonResponse(409, {
      error: 'Node is already actively enrolled. Revoke before re-enrolling.',
    });
  }

  // Generate a cryptographically random token (32 bytes = 64 hex chars)
  const tokenBytes = crypto.randomBytes(32);
  const token = tokenBytes.toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const now = Math.floor(Date.now() / 1000);
  const expiry = now + TOKEN_TTL_SECONDS;
  const expiresAt = new Date(expiry * 1000).toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        nodeId: instanceId,
        sk: 'enrollment',
        status: 'pending',
        tokenHash,
        expiry,
        profileId,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      },
    })
  );

  return jsonResponse(200, { token, expiresAt });
}
