/**
 * core/phoneValidation.ts — Defensive checks before dialing out.
 *
 * Why this file exists: the previous /call/outbound implementation
 * forwarded `body.to` straight to Twilio without format-checking it,
 * so a leaked Bearer token could dial premium-rate international
 * numbers and run up the bill before the per-hour rate limit tripped.
 *
 * Flagged as C-1 in docs/CODE_REVIEW-vercel-hosting-optimization.md.
 *
 * The checks here are deliberately conservative:
 *
 *   1. Must be E.164: `+` followed by 1-15 digits, starting with a
 *      non-zero country code digit. Regex matches the spec.
 *   2. Must be in the allow-list of country codes specified by the
 *      OUTBOUND_ALLOWED_COUNTRY_CODES env var. If unset, defaults to
 *      "US,CA" because that's the operational target today. Set to
 *      "*" to disable the country check (not recommended).
 *
 * This is NOT a replacement for libphonenumber-js — it doesn't know
 * about number lengths per country, area-code ranges, or premium-rate
 * prefixes within a country. It's a first-line check that makes the
 * obvious attacks expensive. Teams that need real number validation
 * should add libphonenumber-js on top; for now this is enough to
 * block the bulk of drive-by abuse.
 */

/** Strict E.164 pattern: `+` followed by 1-15 digits, no leading zero. */
const E164_REGEX = /^\+[1-9]\d{0,14}$/;

/**
 * Prefix-based country code detection. E.164 country codes are 1-3
 * digits and most-specific prefix wins. This isn't a complete
 * E.164 country code table — it only lists codes we care about for
 * allow-listing. Attempts to match against longer prefixes first.
 */
const COUNTRY_CODE_LENGTHS = [3, 2, 1] as const;

/**
 * Minimal country code → ISO country code map. Only codes present in
 * this map can appear in OUTBOUND_ALLOWED_COUNTRY_CODES. Expand as
 * needed when you open new markets.
 *
 * Sources: ITU E.164 assignments.
 */
const COUNTRY_CODES: Record<string, string> = {
  // 1-digit
  "1": "NANP", // US, Canada, and other NANP countries share "+1"
  "7": "RU", // Russia + Kazakhstan
  // 2-digit
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "36": "HU",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "51": "PE",
  "52": "MX",
  "53": "CU",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "58": "VE",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "93": "AF",
  "94": "LK",
  "95": "MM",
  "98": "IR",
  // 3-digit (the usual suspects for premium-rate fraud — deliberately
  // listed so the allow-list can reject them explicitly rather than
  // falling into an unknown-prefix branch)
  "880": "BD",
  "886": "TW",
  "971": "AE",
  "972": "IL",
};

/**
 * NANP country identifier. The "+1" prefix is shared by the US,
 * Canada, and ~24 Caribbean countries. We treat any +1 number as
 * belonging to the "US"/"CA" allow-list entries because we can't tell
 * them apart from the prefix alone. This is pragmatically correct for
 * bill-protection purposes — the fraud risk inside NANP is small
 * compared to premium international prefixes.
 */
function nanpMatches(allowed: Set<string>): boolean {
  return (
    allowed.has("US") ||
    allowed.has("CA") ||
    allowed.has("NANP")
  );
}

/**
 * Split an E.164 number into { countryCode, subscriberDigits }. Uses
 * greedy prefix matching: tries 3-digit prefix, then 2, then 1.
 * Returns null if no known prefix matches — in that case the caller
 * should reject the number as "unknown country".
 */
function detectCountryCode(
  e164: string,
): { countryCode: string; iso: string } | null {
  const digits = e164.slice(1); // strip the leading "+"
  for (const len of COUNTRY_CODE_LENGTHS) {
    const prefix = digits.slice(0, len);
    const iso = COUNTRY_CODES[prefix];
    if (iso) return { countryCode: prefix, iso };
  }
  return null;
}

/**
 * Parse the allow-list env var once per process.
 *
 * We read `process.env.OUTBOUND_ALLOWED_COUNTRY_CODES` directly rather
 * than going through the `env` object because `env` is frozen at
 * module-load time. Reading process.env lets tests flip the value and
 * call `_resetPhoneValidationCacheForTests()` to re-parse. In
 * production this has zero effect because the env var never changes
 * after startup.
 */
let _allowedCountrySet: Set<string> | null = null;
function allowedCountries(): Set<string> {
  if (_allowedCountrySet) return _allowedCountrySet;
  const raw = (process.env.OUTBOUND_ALLOWED_COUNTRY_CODES || "US,CA").trim();
  if (raw === "*") {
    _allowedCountrySet = new Set(["*"]);
  } else {
    _allowedCountrySet = new Set(
      raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    );
  }
  return _allowedCountrySet;
}

/** Test-only reset for env flips. */
export function _resetPhoneValidationCacheForTests(): void {
  _allowedCountrySet = null;
}

export type PhoneValidationResult =
  | { ok: true; countryCode: string; iso: string }
  | { ok: false; reason: "not_e164" | "unknown_country" | "country_not_allowed"; detail: string };

/**
 * Validate a phone number is safe to dial. Returns a structured
 * result the caller (core/outbound.ts) maps to a 400 response on
 * failure or proceeds on success.
 */
export function validateDialable(
  number: string | undefined,
): PhoneValidationResult {
  if (!number || typeof number !== "string") {
    return {
      ok: false,
      reason: "not_e164",
      detail: "Missing or non-string phone number",
    };
  }

  if (!E164_REGEX.test(number)) {
    return {
      ok: false,
      reason: "not_e164",
      detail: "Phone number must be E.164 format (e.g. +15551234567)",
    };
  }

  const allowed = allowedCountries();

  // Wildcard bypass (explicit opt-out for teams that really do want
  // to dial anywhere).
  if (allowed.has("*")) {
    const detected = detectCountryCode(number);
    return {
      ok: true,
      countryCode: detected?.countryCode ?? "",
      iso: detected?.iso ?? "unknown",
    };
  }

  const detected = detectCountryCode(number);
  if (!detected) {
    return {
      ok: false,
      reason: "unknown_country",
      detail: "Phone number's country code is not in the allow-list table",
    };
  }

  // NANP numbers match the "US" or "CA" allow-list entry.
  const isAllowed =
    detected.iso === "NANP"
      ? nanpMatches(allowed)
      : allowed.has(detected.iso);

  if (!isAllowed) {
    return {
      ok: false,
      reason: "country_not_allowed",
      detail: `Country code +${detected.countryCode} (${detected.iso}) is not in OUTBOUND_ALLOWED_COUNTRY_CODES`,
    };
  }

  return { ok: true, countryCode: detected.countryCode, iso: detected.iso };
}
