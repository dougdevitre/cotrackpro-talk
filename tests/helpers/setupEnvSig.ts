/**
 * tests/helpers/setupEnvSig.ts — Test bootstrap with Twilio signature
 * validation ENABLED, for the /sms/incoming rejection path.
 *
 * Built on setupEnvHub (shared bearer + hub). Sets
 * VALIDATE_TWILIO_SIGNATURE=true so signatureValidationEnabled() returns
 * true outside production and the handler actually verifies signatures.
 * Import FIRST, before any src/* import.
 */

import "./setupEnvHub.js";

process.env.VALIDATE_TWILIO_SIGNATURE = "true";

export {};
