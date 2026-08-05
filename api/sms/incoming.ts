/**
 * api/sms/incoming.ts — Vercel serverless function
 *
 * POST /sms/incoming — Twilio inbound-SMS webhook.
 *
 * Verifies the X-Twilio-Signature, then:
 *   - STOP/UNSUBSCRIBE/CANCEL/END/QUIT → suppress the number, clear any
 *     conversation thread, record consent=opted_out with the hub, reply
 *     with an opt-out confirmation.
 *   - START/UNSTOP → unsuppress, record consent=opted_in, reply.
 *   - HELP/INFO → static help reply (no hub call).
 *   - hub commands (RESOURCES, SAFE, DEADLINES, LOG, CONFIRM, SNOOZE,
 *     MENU) → forward to the hub /internal/v1/inbound-sms and return its
 *     reply (with the canonical opt-out footer) as TwiML. These are
 *     state-changing operations on the user's record; the hub owns them.
 *   - anything else (free text) → a conversational Claude reply in the
 *     CoTrackPro persona, with short-term thread memory
 *     (src/core/smsConversation.ts). Set SMS_AI_ENABLED=false to fall
 *     back to forwarding the first word to the hub instead.
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
import {
  clearThread,
  generateSmsReply,
  isHubCommand,
} from "../../src/core/smsConversation.js";
import { lookupInboundPhone } from "../../src/config/inboundPhoneMap.js";
import { forwardInboundSms, recordConsent } from "../../src/services/hub.js";
import { logger } from "../../src/utils/logger.js";
import {
  parseBody,
  publicHost,
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
  const fullUrl = buildSignedWebhookUrl(
    req.url,
    "/sms/incoming",
    env.apiDomain,
    publicHost(req),
  );
  if (!validateTwilioSignature(signature, fullUrl, body)) {
    sendStatus(res, 403, "Forbidden");
    return;
  }

  const from = body.From ?? "";
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

  // Twilio Advanced Opt-Out: when the Messaging Service has carrier-level
  // opt-out enabled, Twilio processes STOP/START/HELP itself AND already
  // sent its configured reply, then still fires this webhook with an
  // `OptOutType` field. Honor it so OUR suppression list + the hub's
  // consent record stay in sync with Twilio (the voice path reads our
  // list) — but return EMPTY TwiML so we don't double-reply on top of
  // Twilio's response.
  const optOutType = (body.OptOutType ?? "").toUpperCase();
  if (optOutType) {
    if (optOutType === "STOP") {
      await suppress(from);
      await recordConsent(from, "opted_out", "STOP");
    } else if (optOutType === "START") {
      await unsuppress(from);
      await recordConsent(from, "opted_in", "START");
    }
    // STOP / START / HELP — Twilio already replied; send nothing.
    log.info({ messageSid, optOutType }, "Twilio Advanced Opt-Out handled");
    sendXml(res, 200, twimlMessage(undefined));
    return;
  }

  if (keyword === "stop") {
    // Suppress FIRST (talk owns the number), then best-effort record
    // consent with the hub so a hub hiccup never leaves us still sending.
    await suppress(from);
    // An opt-out leaves nothing behind: drop any stored conversation
    // context for this number rather than waiting out its TTL.
    await clearThread(from);
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

  const text = body.Body ?? "";

  // Free text → conversational reply. The hub's keyword router can only
  // act on the FIRST WORD of a message, so routing "he showed up two
  // hours late again" there discards everything the person actually
  // said. Structured commands still go to the hub below.
  if (env.smsAiEnabled && !isHubCommand(text)) {
    // Per-number persona: the same INBOUND_PHONE_VOICE_MAP that pins a
    // voice + role for inbound CALLS also selects the SMS persona, keyed
    // on the CoTrackPro number that was texted. One number, one
    // consistent assistant across both channels.
    const role = lookupInboundPhone(body.To)?.role ?? "parent";
    const result = await generateSmsReply({ from, body: text, role });
    log.info(
      { messageSid, source: result.source, role },
      "Inbound SMS answered conversationally",
    );
    sendXml(res, 200, twimlMessage(result.text));
    return;
  }

  // Structured hub command (or SMS_AI_ENABLED=false): forward to the hub
  // as { phone, keyword } — the hub is keyword-routed (RESOURCES/SAFE,
  // DEADLINES, LOG, CONFIRM, SNOOZE, else a default menu), so it wants
  // the SENDER as `phone` and the FIRST word as `keyword`. Relay its
  // reply with the canonical footer; a 404 (number not linked) → no reply.
  const firstWord = text.trim().split(/\s+/)[0] ?? "";
  const forwarded = await forwardInboundSms({ phone: from, keyword: firstWord });
  const reply =
    forwarded.status === "ok" && forwarded.reply
      ? appendFooterOnce(forwarded.reply)
      : undefined;
  sendXml(res, 200, twimlMessage(reply));
}
