/**
 * services/dynamo.ts — DynamoDB CRUD operations for call records
 *
 * Persists call metadata, transcripts, safety events, and tool call
 * records to DynamoDB. Disabled by default (DYNAMO_ENABLED=false) so
 * the app runs without AWS credentials during local development.
 *
 * TABLE DESIGN:
 *   Table name: env.dynamoTableName (default "cotrackpro-calls")
 *   PK: callSid (String)
 *
 *   GSI "role-date-index":
 *     PK: role (String)
 *     SK: startedAt (String, ISO 8601)
 *
 *   GSI "status-date-index":
 *     PK: status (String)
 *     SK: startedAt (String, ISO 8601)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type {
  CallRecord,
  CallStatus,
  CoTrackProRole,
  SafetyEvent,
  ToolCallRecord,
  TranscriptEntry,
} from "../types/index.js";

const log = logger.child({ service: "dynamo" });

const isEnabled = env.dynamoEnabled === "true";

/**
 * DynamoDB client with an explicit retry budget (audit E-4).
 *
 * The AWS SDK v3 default is 3 retries with adaptive exponential
 * backoff, which is fine for background workloads but can add
 * 100-500ms of tail latency during throttling that hurts real-time
 * voice calls more than dropping a record would. We pass
 * `env.dynamoMaxRetries` explicitly (default 3) so operators can
 * tune the trade-off without redeploying:
 *
 *   - Raise it (e.g. 5) if you see persistent throttling and care
 *     more about record completeness than call latency.
 *   - Lower it (e.g. 1) for latency-sensitive deployments that
 *     would rather drop a record than stall the write path.
 *   - Set it to 0 to disable retries entirely (not recommended).
 *
 * Note: the AWS SDK retry strategy only handles *transient* errors
 * (ProvisionedThroughputExceeded, throttling, 5xx). Deterministic
 * errors (ConditionalCheckFailed, ValidationException) are not
 * retried and fail immediately, which is what we want.
 */
const _client = isEnabled
  ? DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: env.dynamoRegion,
        maxAttempts: env.dynamoMaxRetries + 1, // AWS counts the initial try
      }),
      {
        marshallOptions: { removeUndefinedValues: true },
      },
    )
  : null;

const TABLE = env.dynamoTableName;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the DynamoDB client or throws if disabled. */
function db(): DynamoDBDocumentClient {
  if (!_client) {
    throw new Error("DynamoDB is not enabled (set DYNAMO_ENABLED=true)");
  }
  return _client;
}

/** Mask a phone number for PII protection: "+15551234567" → "+1***4567" */
export function maskPhoneNumber(phone: string): string {
  if (phone.length <= 4) return phone;
  return phone.slice(0, 2) + "***" + phone.slice(-4);
}

// ── CREATE ───────────────────────────────────────────────────────────────────

/**
 * Create a new call record when a call starts.
 * Automatically sets TTL from env.recordsTtlDays unless the caller
 * provided one.
 *
 * Failure mode (audit E-4): after exhausting the retry budget, the
 * SDK throws. We emit a structured `dynamo.createCallRecord.failed`
 * log line BEFORE re-throwing so operators have a clean signal to
 * alert on. The exception is still propagated — the caller
 * (`callHandler.ts`) decides whether to tear down the call or
 * continue without persistence, and we don't want to silently
 * swallow the error here.
 */
export async function createCallRecord(
  record: CallRecord,
): Promise<void> {
  if (!isEnabled) return;

  // Set TTL if not already set — auto-delete after retention window
  const withTtl: CallRecord = record.ttl !== undefined
    ? record
    : {
        ...record,
        ttl: Math.floor(Date.now() / 1000) + Math.floor(env.recordsTtlDays * 86400),
      };

  log.info({ callSid: withTtl.callSid, role: withTtl.role, ttl: withTtl.ttl }, "Creating call record");

  try {
    await db().send(
      new PutCommand({
        TableName: TABLE,
        Item: withTtl,
        ConditionExpression: "attribute_not_exists(callSid)",
      }),
    );
  } catch (err) {
    // Structured error line so alerting on
    // `msg="dynamo.createCallRecord.failed"` Just Works. Include
    // enough context to triage without leaking PII (callerNumber is
    // already masked on the record, so we log it verbatim).
    log.error(
      {
        err,
        callSid: withTtl.callSid,
        role: withTtl.role,
        direction: withTtl.direction,
        callerNumber: withTtl.callerNumber,
        dynamoMaxRetries: env.dynamoMaxRetries,
      },
      "dynamo.createCallRecord.failed",
    );
    throw err;
  }
}

// ── READ (single item) ──────────────────────────────────────────────────────

/**
 * Get a call record by callSid.
 */
export async function getCallRecord(
  callSid: string,
): Promise<CallRecord | null> {
  if (!isEnabled) return null;


  const result = await db().send(
    new GetCommand({
      TableName: TABLE,
      Key: { callSid },
    }),
  );

  return (result.Item as CallRecord) ?? null;
}

// ── READ (query by role + date range) ────────────────────────────────────────

/**
 * List call records for a given role, optionally filtered by date range.
 * Uses GSI "role-date-index".
 */
export async function listCallsByRole(
  role: CoTrackProRole,
  opts?: {
    startDate?: string; // ISO 8601
    endDate?: string;   // ISO 8601
    limit?: number;
    lastKey?: Record<string, unknown>;
  },
): Promise<{ records: CallRecord[]; lastKey?: Record<string, unknown> }> {
  if (!isEnabled) return { records: [] };


  let keyCondition = "#role = :role";
  const exprNames: Record<string, string> = { "#role": "role" };
  const exprValues: Record<string, unknown> = { ":role": role };

  if (opts?.startDate && opts?.endDate) {
    keyCondition += " AND startedAt BETWEEN :start AND :end";
    exprValues[":start"] = opts.startDate;
    exprValues[":end"] = opts.endDate;
  } else if (opts?.startDate) {
    keyCondition += " AND startedAt >= :start";
    exprValues[":start"] = opts.startDate;
  } else if (opts?.endDate) {
    keyCondition += " AND startedAt <= :end";
    exprValues[":end"] = opts.endDate;
  }

  const result = await db().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "role-date-index",
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: false, // newest first
      Limit: opts?.limit ?? 50,
      ExclusiveStartKey: opts?.lastKey,
    }),
  );

  return {
    records: (result.Items as CallRecord[]) ?? [],
    lastKey: result.LastEvaluatedKey,
  };
}

// ── READ (query by status + date range) ──────────────────────────────────────

/**
 * List call records by status (e.g. all active or completed calls).
 * Uses GSI "status-date-index".
 */
export async function listCallsByStatus(
  status: CallStatus,
  opts?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    lastKey?: Record<string, unknown>;
  },
): Promise<{ records: CallRecord[]; lastKey?: Record<string, unknown> }> {
  if (!isEnabled) return { records: [] };


  let keyCondition = "#status = :status";
  const exprNames: Record<string, string> = { "#status": "status" };
  const exprValues: Record<string, unknown> = { ":status": status };

  if (opts?.startDate && opts?.endDate) {
    keyCondition += " AND startedAt BETWEEN :start AND :end";
    exprValues[":start"] = opts.startDate;
    exprValues[":end"] = opts.endDate;
  } else if (opts?.startDate) {
    keyCondition += " AND startedAt >= :start";
    exprValues[":start"] = opts.startDate;
  }

  const result = await db().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "status-date-index",
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: false,
      Limit: opts?.limit ?? 50,
      ExclusiveStartKey: opts?.lastKey,
    }),
  );

  return {
    records: (result.Items as CallRecord[]) ?? [],
    lastKey: result.LastEvaluatedKey,
  };
}

// ── UPDATE (call completion) ─────────────────────────────────────────────────

/**
 * Mark a call as completed and set end time + duration.
 */
export async function completeCallRecord(
  callSid: string,
  endedAt: string,
  durationSecs: number,
  transcript: TranscriptEntry[],
  turnCount: number,
): Promise<void> {
  if (!isEnabled) return;


  log.info({ callSid, durationSecs, turnCount }, "Completing call record");

  await db().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { callSid },
      UpdateExpression:
        "SET #status = :status, endedAt = :endedAt, durationSecs = :dur, " +
        "transcript = :transcript, turnCount = :turnCount",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "completed",
        ":endedAt": endedAt,
        ":dur": durationSecs,
        ":transcript": transcript,
        ":turnCount": turnCount,
      },
    }),
  );
}

// ── UPDATE (cost summary) ────────────────────────────────────────────────────

/**
 * Attach the finalized per-call cost summary to a call record.
 * Called from the cleanup path after metrics are aggregated.
 */
export async function updateCallCost(
  callSid: string,
  costSummary: import("../types/index.js").CallCostSummary,
): Promise<void> {
  if (!isEnabled) return;

  await db().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { callSid },
      UpdateExpression: "SET costSummary = :cost",
      ExpressionAttributeValues: {
        ":cost": costSummary,
      },
    }),
  );
}

// ── UPDATE (status change) ───────────────────────────────────────────────────

/**
 * Update the status of a call record (e.g. "failed", "force-reaped").
 */
export async function updateCallStatus(
  callSid: string,
  status: CallStatus,
): Promise<void> {
  if (!isEnabled) return;


  await db().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { callSid },
      UpdateExpression: "SET #status = :status, endedAt = :endedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":endedAt": new Date().toISOString(),
      },
    }),
  );
}

// ── UPDATE (append safety event) ─────────────────────────────────────────────

/**
 * Append a safety event to an active call record.
 */
export async function appendSafetyEvent(
  callSid: string,
  event: SafetyEvent,
): Promise<void> {
  if (!isEnabled) return;


  log.info({ callSid, tier: event.tier }, "Recording safety event");

  await db().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { callSid },
      UpdateExpression:
        "SET safetyEvents = list_append(if_not_exists(safetyEvents, :empty), :event)",
      ExpressionAttributeValues: {
        ":event": [event],
        ":empty": [],
      },
    }),
  );
}

// ── UPDATE (append tool call) ────────────────────────────────────────────────

/**
 * Append a tool call record to an active call.
 */
export async function appendToolCall(
  callSid: string,
  toolCall: ToolCallRecord,
): Promise<void> {
  if (!isEnabled) return;


  await db().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { callSid },
      UpdateExpression:
        "SET toolCalls = list_append(if_not_exists(toolCalls, :empty), :tc)",
      ExpressionAttributeValues: {
        ":tc": [toolCall],
        ":empty": [],
      },
    }),
  );
}

// ── DELETE ────────────────────────────────────────────────────────────────────

/**
 * Delete a call record by callSid.
 * Returns true if the item existed and was deleted.
 */
export async function deleteCallRecord(callSid: string): Promise<boolean> {
  if (!isEnabled) return false;


  log.info({ callSid }, "Deleting call record");

  const result = await db().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { callSid },
      ReturnValues: "ALL_OLD",
    }),
  );

  return !!result.Attributes;
}

// ── LIST (recent calls, paginated) ───────────────────────────────────────────

/**
 * Scan recent call records (use sparingly — prefer query by role or status).
 * Useful for admin dashboards.
 */
export async function listRecentCalls(opts?: {
  limit?: number;
  lastKey?: Record<string, unknown>;
}): Promise<{ records: CallRecord[]; lastKey?: Record<string, unknown> }> {
  if (!isEnabled) return { records: [] };


  const result = await db().send(
    new ScanCommand({
      TableName: TABLE,
      Limit: opts?.limit ?? 25,
      ExclusiveStartKey: opts?.lastKey,
    }),
  );

  return {
    records: (result.Items as CallRecord[]) ?? [],
    lastKey: result.LastEvaluatedKey,
  };
}
