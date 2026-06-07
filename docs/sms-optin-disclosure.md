# SMS opt-in disclosure — signup page copy

> **Publishing note:** This is the consent UI for the signup page at
> **talk.cotrackpro.com** — the third piece the A2P reviewer verifies (alongside
> `docs/sms-privacy-policy.md` and `docs/sms-terms.md`). The page must be publicly
> reachable. The checkbox must be **unchecked by default** (consent can't be
> pre-selected), and its label must link to the Privacy Policy and Terms.

## The checkbox (unchecked by default)

Label text next to the checkbox:

> ☐ I agree to receive text messages from **CoTrackPro Talk** (verification
> codes, call notifications and reminders, and transcript/account alerts) at the
> mobile number I provided. Msg & data rates may apply. Msg frequency varies.
> Reply **STOP** to cancel, **HELP** for help. See our
> [Privacy Policy](https://cotrackpro.com/privacy) and
> [Terms](https://cotrackpro.com/terms).

## Helper line under the phone-number field (optional but recommended)

> Consent to receive texts is **not** a condition of using CoTrackPro Talk.

## Rules that keep this compliant

- **Unchecked by default** — the user must actively check it. Never pre-check.
- **Consent isn't required to sign up** — don't block account creation if the box
  is left unchecked (you just won't send that user SMS).
- **Both links resolve** to the live, public Privacy Policy and Terms pages.
- The disclosure wording **matches** the campaign's "How do end-users consent"
  text and the Terms §3 opt-in description — reviewers cross-check these.

## Plain-text fallback (if your form can't render links)

```
I agree to receive text messages from CoTrackPro Talk (verification codes,
call notifications and reminders, and transcript/account alerts) at the mobile
number I provided. Msg & data rates may apply. Msg frequency varies. Reply STOP
to cancel, HELP for help. Privacy Policy: https://cotrackpro.com/privacy
Terms: https://cotrackpro.com/terms
```
