# A2P Campaign — exact values to enter in the Twilio form

Copy-paste answers for the **Edit A2P Campaign Details** modal (campaign
`CM906d9bc966f06e47abe42b4fb95aa93c`, use case **Low Volume Mixed**). This fixes
the **CTA-verification rejection**. See `docs/twilio-a2p-setup.md` for the full
runbook and `docs/sms-privacy-policy.md` / `docs/sms-terms.md` for the pages that
must be live first.

> **Do this first, or it rejects again:** publish the privacy and terms copy at
> **https://cotrackpro.com/privacy** and **https://cotrackpro.com/terms** (public,
> no login), and make sure the **signup page at talk.cotrackpro.com is publicly
> reachable** with the SMS consent checkbox whose text links to those two pages.
> The reviewer clicks these to verify the CTA — blank or unreachable = rejection.

---

## Campaign description
```
CoTrackPro Talk sends account and transactional SMS to its own registered users
(parents, attorneys, and professionals) who opted in. Messages include sign-in /
verification codes, missed-call notifications, scheduled-call reminders, and
transcript-ready alerts for their co-parenting, legal, or appointment
communications. This is not a marketing program.
```

## Sample messages (enter 4 — drop the old contact-invite #5)
**#1**
```
You missed a video call from [User Name] on CoTrackPro Talk. Log in to view the transcript and call history: https://talk.cotrackpro.com
```
**#2**
```
Reminder: You have a scheduled call with [User Name] on CoTrackPro Talk at 3:00 PM CT. Join at https://talk.cotrackpro.com/schedule
```
**#3**
```
Your CoTrackPro Talk verification code is 482159. Do not share this with anyone.
```
**#4**
```
A new smart call transcript has been posted. Visit your secure dashboard to review: https://talk.cotrackpro.com/history
```
> Old **#5** ("[User Name] added you to their CoTrackPro Talk contacts…") — **remove it.** Messaging a person another user added implies sending to a non-consented recipient, a top CTA/consent rejection cause. (Emoji removed from samples; not required and keeps carrier parsing clean — re-add if you prefer.)

## Message contents (checkboxes)
| Question | Answer |
|---|---|
| Embedded links? | **Yes** |
| Embedded phone numbers? | **No** |
| Direct lending / loan content? | **No** |
| Age-gated content? | **No** |

## How do end-users consent to receive messages? (40–2048 chars)
```
End users opt in at https://talk.cotrackpro.com during account signup: they enter their mobile number and check a box (unchecked by default) that reads "I agree to receive SMS from CoTrackPro Talk (verification codes, call notifications and reminders, transcript and account alerts). Msg & data rates may apply. Msg frequency varies. Reply STOP to cancel, HELP for help," with links to our Privacy Policy (https://cotrackpro.com/privacy) and Terms (https://cotrackpro.com/terms). Consent is not a condition of purchase. Users may also opt in by texting START or SUBSCRIBE to (314) 394-8500.
```
> Removed the old "Screenshots available upon request" and the vague
> "consent is collected when users schedule a call" — reviewers verify the live
> page, not screenshots, and every opt-in path must be concrete and reachable.

## Privacy Policy URL
```
https://cotrackpro.com/privacy
```
## Terms and Conditions URL
```
https://cotrackpro.com/terms
```

## Opt-in / Opt-out / Help (Twilio-managed defaults — leave as-is)
- **Opt-in keywords:** START, SUBSCRIBE
- **Opt-in message:** `CoTrackPro Talk: You're now subscribed to receive secure call updates and notifications. Reply HELP for help or STOP to unsubscribe.`
- **Opt-out keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE
- **Opt-out message:** `You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.`
- **Help keywords:** HELP, INFO
- **Help message:** `Reply STOP to unsubscribe. Msg&Data Rates May Apply.`

## Submit
Check the agreement box (acknowledges the **$15 resubmission vetting fee**) and
click **Update**. The campaign SID stays the same, so **no SSM change is needed**
if it passes. Watch for **Campaign status = Verified**, then verify end-to-end
with `npm run show:a2p` (see `docs/twilio-a2p-setup.md`).
```

If it rejects a second time, open a Twilio support ticket with the brand SID
(BN800b7b652fb999ea769725c80e56ee5c), the campaign SID, and the live
privacy/terms/signup URLs.
```
