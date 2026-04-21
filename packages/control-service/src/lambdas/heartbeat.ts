/**
 * POST /heartbeat
 *
 * Node-facing endpoint that records the node's current bootstrap status and
 * last-applied manifest revision.  This is the primary signal used to detect
 * drift between desired state (control service) and actual state (node).
 *
 * Expected request body:
 *   {
 *     "instanceId":     "i-0abc123",
 *     "revision":       "abc123",       // last-applied manifest revision
 *     "bootstrapStatus": "healthy",     // "healthy" | "degraded" | "failed"
 *     "healthChecks":   [               // per-check results (optional)
 *       { "name": "http-api", "passed": true },
 *       { "name": "vpn-service", "passed": false, "detail": "port unreachable" }
 *     ]
 *   }
 *
 * Response:
 *   { "accepted": true }
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.ENROLLMENT_TABLE_NAME ?? '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type BootstrapStatus = 'healthy' | 'degraded' | 'failed';

export interface HealthCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface HeartbeatRequest {
  instanceId: string;
  revision: string;
  bootstrapStatus: BootstrapStatus;
  healthChecks?: HealthCheckResult[];
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

  let req: HeartbeatRequest;
  try {
    req = JSON.parse(event.body) as HeartbeatRequest;
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { instanceId, revision, bootstrapStatus, healthChecks } = req;
  if (!instanceId || !revision || !bootstrapStatus) {
    return jsonResponse(400, {
      error: 'instanceId, revision, and bootstrapStatus are required',
    });
  }

  const validStatuses: BootstrapStatus[] = ['healthy', 'degraded', 'failed'];
  if (!validStatuses.includes(bootstrapStatus)) {
    return jsonResponse(400, {
      error: `bootstrapStatus must be one of: ${validStatuses.join(', ')}`,
    });
  }

  // Verify the node has an active enrollment before accepting heartbeats
  const enrollResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { nodeId: instanceId, sk: 'enrollment' },
    })
  );

  if (!enrollResult.Item || enrollResult.Item.status !== 'active') {
    return jsonResponse(403, {
      error: 'Node is not enrolled. Complete POST /activate before sending heartbeats.',
    });
  }

  const now = new Date().toISOString();

  // Write the heartbeat record (upsert)
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        nodeId: instanceId,
        sk: 'heartbeat',
        revision,
        bootstrapStatus,
        healthChecks: healthChecks ?? [],
        lastHeartbeatAt: now,
      },
    })
  );

  return jsonResponse(200, { accepted: true });
}
