#!/usr/bin/env node
import { redact, looksSensitive, clip } from "./redact.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

check("masks an email", redact("contact me at a@b.com please").includes("[redacted-email]"));
check("masks a long hex token", redact("token abcdef0123456789abcdef01").includes("[redacted-hex]"));
check("masks a bearer token", redact("Authorization: Bearer sk-abcdefghij1234567890").includes("[redacted-token]"));
check("leaves ordinary text alone", redact("build the login page") === "build the login page");
check("handles non-string input", redact(undefined) === "");

check("flags a private key block as sensitive", looksSensitive("-----BEGIN RSA PRIVATE KEY-----\nabc"));
check("flags a password: field as sensitive", looksSensitive("password: hunter2"));
check("does not flag ordinary text as sensitive", !looksSensitive("fix the login bug"));

check("clip leaves short text alone", clip("hi", 10) === "hi");
check("clip truncates long text with a marker", clip("a".repeat(20), 5) === `${"a".repeat(5)}…[clipped]`);

if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All redact.mjs checks passed.");
