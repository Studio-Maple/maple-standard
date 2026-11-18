// scrub: kept live-scan evidence never carries an injected secret, an auth header or a JWT.
import assert from "node:assert/strict";
import { scrubSecrets } from "./scrub.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz";

t("an injected value is replaced everywhere, including inside JSON strings", () => {
  const out = scrubSecrets('{"a":"x s3cr3t-value-123 y","b":"s3cr3t-value-123"}', ["s3cr3t-value-123"]);
  assert.ok(!out.includes("s3cr3t-value-123")); assert.equal(out.split("[REDACTED]").length - 1, 2);
});
t("auth headers lose their value, the header name stays", () => {
  const out = scrubSecrets(`GET /x HTTP/1.1\r\nAuthorization: Bearer abc.def\r\nCookie: sid=1; a=2\r\nHost: h`, []);
  assert.ok(/Authorization: \[REDACTED\]/.test(out) && /Cookie: \[REDACTED\]/.test(out) && out.includes("Host: h"));
  assert.ok(!out.includes("Bearer abc.def") && !out.includes("sid=1"));
});
t("a header inside a JSON string stops at the closing quote", () => {
  const out = scrubSecrets('{"requestHeader":"Authorization: Bearer zzz"}', []);
  assert.equal(out, '{"requestHeader":"Authorization: [REDACTED]"}');
});
t("a JWT anywhere is redacted", () => {
  const out = scrubSecrets(`token=${jwt} next`, []);
  assert.ok(!out.includes(jwt) && out.includes("[REDACTED-JWT]"));
});
t("short values are ignored (they would shred the log) and ordinary text is untouched", () => {
  assert.equal(scrubSecrets("a short abc here", ["abc"]), "a short abc here");
  assert.equal(scrubSecrets("nothing secret", ["", undefined, null]), "nothing secret");
});

console.log(`\n${n} scrub tests passed`);

import { scrubUri } from "./scrub.mjs";
{
  const u = scrubUri("https://h/a/b?x=1&access_token=abc123&session=zzz&page=2", []);
  assert.equal(u, "https://h/a/b?x=1&access_token=[REDACTED]&session=[REDACTED]&page=2");
  assert.equal(scrubUri("https://h/p/s3cr3t-value-123/q", ["s3cr3t-value-123"]), "https://h/p/[REDACTED]/q");
  console.log("ok - scrubUri keeps the path and redacts credential-looking query values and injected values");
}
