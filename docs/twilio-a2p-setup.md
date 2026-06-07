# Twilio A2P 10DLC — setup & campaign remediation

Runbook for getting outbound SMS on the CoTrackPro Talk number compliant and
sending. The talk edge (this repo) sends SMS **through the A2P-registered
Messaging Service** (`src/core/sms.ts`); A2P 10DLC is the registration that
makes those sends deliverable to US handsets. Identifiers are owned in AWS SSM
under `/cotrackpro/<stage>/twilio/*` and mirrored to Vercel by
`scripts/sync-ssm-to-vercel.sh`.

## Current state (prod)

| Thing | Value | Status |
|---|---|---|
| Number | `+13143948500` | active |
| Brand `CoTrackPro` | `BN800b7b652fb999ea769725c80e56ee5c` | **APPROVED** |
| TrustHub A2P Bundle | `BU890d50f5e0029574aaa0ca88fe9b0740` | — |
| Customer Profile | `BU861ae83cff6fa5d19a654a373d313f6c` | — |
| Messaging Service | `MG6bc2ebf3394148858aa0a8eb6cf0d228` | active |
| Campaign (orig) | `CM906d9bc966f06e47abe42b4fb95aa93c` | **REJECTED** (CTA) |

The Brand is approved; the **Campaign was rejected at TCR** for *"issues
verifying the Call to Action (CTA)"* — its submission left **Privacy Policy URL**
and **Terms & Conditions URL** blank, and the opt-in flow wasn't publicly
verifiable. Rejected TCR campaigns can't be edited, so a **new campaign** must be
registered after the CTA is fixed.

## Fix, in order

### 1. Publish the consent pages (web app: talk.cotrackpro.com — NOT this repo)
This repo is the voice/SMS API edge only; the user-facing pages live in the web
app. Publish, at public/no-auth URLs:

- **Privacy Policy** including the SMS clause MNOs require: *"Mobile information
  will not be shared with third parties or affiliates for marketing or
  promotional purposes,"* plus what's collected and how to opt out.
- **Terms / Messaging Terms**: program/brand name, message types, **recurring**
  frequency, *"Message and data rates may apply,"* *"Reply STOP to cancel, HELP
  for help,"* and a support contact.
- **Opt-in page** publicly viewable, showing the consent checkbox and disclosure
  text that links to the Privacy Policy and Terms. (If it must sit behind auth,
  keep screenshots ready — but a public URL is what passes review.)

### 2. Register a NEW campaign (Twilio → Messaging → Regulatory Compliance → Campaigns)
- Under approved Brand `BN800…`, use case **Low Volume Mixed**.
- **Fill the Privacy Policy URL and Terms & Conditions URL** (step 1 pages) — this
  is the field that was blank and caused the rejection.
- Keep the existing sample messages. Write the "how end users consent" / CTA
  description so it matches the now-public opt-in page. The opt-in confirmation
  message should name the brand + "recurring" + "Msg & data rates may apply" +
  STOP/HELP (Twilio manages STOP/HELP keywords by default).
- Attach the campaign to Messaging Service `MG6bc2…`; confirm `+13143948500` is in
  the sender pool. Submit; wait for **Campaign status = VERIFIED**.
- If it rejects again: open a Twilio support ticket with the brand SID, the failed
  campaign SID, and the public CTA/Privacy/Terms URLs.

### 3. Record the new campaign SID in SSM
```bash
aws ssm put-parameter --region us-east-1 --overwrite \
  --name /cotrackpro/prod/twilio/campaign_sid --value 'CM…new-approved…'
```
Optional record-keeping (in IAM scope under `twilio/*`):
```bash
aws ssm put-parameter --region us-east-1 --overwrite --name /cotrackpro/prod/twilio/trusthub_profile_sid --value 'BU861ae83cff6fa5d19a654a373d313f6c'
aws ssm put-parameter --region us-east-1 --overwrite --name /cotrackpro/prod/twilio/a2p_bundle_sid       --value 'BU890d50f5e0029574aaa0ca88fe9b0740'
```

### 4. Re-deploy config
Run the **Sync SSM → Vercel env** action on `prod` so `TWILIO_MESSAGING_SERVICE_SID`
(and the rest) reflect the live values.

## Verify

```bash
# Pull the Twilio identifiers from SSM, then check brand + campaign status.
STAGE=prod; REGION=us-east-1
for k in account_sid auth_token messaging_service_sid brand_sid campaign_sid; do
  export "TWILIO_$(echo "$k" | tr 'a-z' 'A-Z')=$(aws ssm get-parameter \
    --region "$REGION" --name "/cotrackpro/$STAGE/twilio/$k" \
    --with-decryption --query Parameter.Value --output text)"
done
npm run show:a2p
```
Expect: Brand `APPROVED`, Campaign `VERIFIED`, sender pool contains `+13143948500`.
(`npm run show:a2p` → `scripts/show-a2p-status.ts`. Pure-curl equivalent:
`GET https://messaging.twilio.com/v1/Services/MG6bc2…/Compliance/Usa2p` →
`campaign_status: VERIFIED`.)

End-to-end: from an UNLINKED phone, drive the inbound path → the hub's
`send-auth-link` → assert the sign-in SMS reaches the handset.

## Notes
- STOP/HELP/START + suppression/quiet-hours are **not** the rejection cause
  (Twilio manages opt-out/help keywords by default for this campaign). They're
  tracked as separate future hardening in `docs/hub-talk-seam.md`.
- Voice does **not** depend on A2P — inbound calls work once the number's voice
  webhook points at `https://<API_DOMAIN>/call/incoming` (see
  `docs/GO_LIVE-inbound-voice.md`). A2P only gates SMS.
