/**
 * api/sms/incoming.ts — Vercel serverless function
 *
 * POST /sms/incoming — Twilio inbound-SMS webhook.
 *
 * Verifies the X-Twilio-Signature, then:
 *   - STOP/UNSUBSCRIBE/CANCEL/END/QUIT → suppress the number, record
 *     consent=opted_out with the hub, reply with an opt-out confirmation.
 *   - START/UNSTOP → unsuppress, record consent=opted_in, reply.
 *   - HELP/INFO → static help reply (no hub call).
 *   - anything else → forward to the hub /internal/v1/inbound-sms and
 *     return its reply (with the canonical opt-out footer) as TwiML.
 *
 * The reply is returned as TwiML <Message>. Talk-composed replies get
 * the canonical opt-out footer appended exactly once; outbound hub
 * bodies (sent via /api/sms/send) are NOT touched here.
 *
 * PII: the raw From number and message body are never logged — only the
 * keyword class and the Twilio MessageSid.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { env } from "../../src/config/env.js";
import {
  buildSignedWebhookUrl,
  escapeXmlAttr,
  validateTwilioSignature,
} from "../../src/core/twiml.js";
import {
  appendFooterOnce,
  classifyKeyword,
  HELP_REPLY,
  START_REPLY,
  STOP_REPLY,
  suppress,
  unsuppress,
} from "../../src/core/consent.js";
import { forwardInboundSms, recordConsent } from "../../src/services/hub.js";
import { logger } from "../../src/utils/logger.js";
import {
  parseBody,
  requireMethod,
  sendStatus,
  sendXml,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

const log = logger.child({ api: "sms-incoming" });

/** Wrap a reply string in TwiML <Message>. Empty → empty <Response/>
 *  (Twilio sends nothing). */
function twimlMessage(reply: string | undefined): string {
  if (!reply) return `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Response>\n  <Message>${escapeXmlAttr(reply)}</Message>\n</Response>`
  );
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "POST")) return;

  const body = await parseBody(req);

  // Twilio signed the EXACT public URL. As with /call/incoming we splice
  // the original query onto the hardcoded public path rather than reading
  // req.url (Vercel rewrites it to the internal /api path).
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const fullUrl = buildSignedWebhookUrl(req.url, "/sms/incoming", env.apiDomain);
  if (!validateTwilioSignature(signature, fullUrl, body)) {
    sendStatus(res, 403, "Forbidden");
    return;
  }

  const from = body.From ?? "";
  const to = body.To ?? "";
  const messageSid = body.MessageSid;
  const keyword = classifyKeyword(body.Body);

  log.info({ messageSid, keyword: keyword ?? "none" }, "Inbound SMS");

  // Guard a missing/blank From: suppressing or recording consent against
  // an empty key would write a junk suppression entry (under hash("")) and
  // never actually opt the real subscriber out/in. A well-formed Twilio
  // webhook always carries From; bail to empty TwiML if it doesn't.
  if (!from) {
    log.warn({ messageSid }, "Inbound SMS with no From — ignoring");
    sendXml(res, 200, twimlMessage(undefined));
    return;
  }

  if (keyword === "stop") {
    // Suppress FIRST (talk owns the number), then best-effort record
    // consent with the hub so a hub hiccup never leaves us still sending.
    await suppress(from);
    await recordConsent(from, "opted_out", "STOP");
    sendXml(res, 200, twimlMessage(STOP_REPLY));
    return;
  }

  if (keyword === "start") {
    await unsuppress(from);
    await recordConsent(from, "opted_in", "START");
    sendXml(res, 200, twimlMessage(START_REPLY));
    return;
  }

  if (keyword === "help") {
    // Static reply — no hub round-trip.
    sendXml(res, 200, twimlMessage(HELP_REPLY));
    return;
  }

  // Non-keyword: forward to the hub and relay its reply (with footer).
  const forwarded = await forwardInboundSms({ from, to, body: body.Body ?? "", messageSid });
  const reply =
    forwarded.status === "ok" && forwarded.reply
      ? appendFooterOnce(forwarded.reply)
      : undefined;
  sendXml(res, 200, twimlMessage(reply));
}
