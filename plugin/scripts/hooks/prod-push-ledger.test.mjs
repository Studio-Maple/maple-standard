// A push to the production branch is a recorded deploy (live-scan debt) unless the project says it deploys nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { recordsDeploy } from "../../hooks/guards/deploy-guard.mjs";
import { validatePredeploy } from "../predeploy/config.mjs";

const push = { id: "prod-branch-push" }, real = { id: "hardening-deploy" };
test("default: a production push is recorded like any deploy", () => {
  assert.equal(recordsDeploy(push, {}), true);
  assert.equal(recordsDeploy(push, { deployGuard: {} }), true);
  assert.equal(recordsDeploy(push, { deployGuard: { prodPushIsDeploy: true } }), true);
});
test("prodPushIsDeploy:false skips only the production push", () => {
  const pd = { deployGuard: { prodPushIsDeploy: false } };
  assert.equal(recordsDeploy(push, pd), false);
  assert.equal(recordsDeploy(real, pd), true, "a real deploy command is always recorded");
  assert.equal(recordsDeploy({ id: "wrangler" }, pd), true);
});
test("config: prodPushIsDeploy must be a boolean; false and true validate", () => {
  const cfg = (g) => ({ predeploy: { checks: [{ id: "a", command: "node -e 0" }], deployGuard: g } });
  const bad = (g) => validatePredeploy(cfg(g)).filter((e) => /deployGuard/.test(e));
  assert.deepEqual(bad({ prodPushIsDeploy: false }), []);
  assert.deepEqual(bad({ prodPushIsDeploy: true }), []);
  assert.match(bad({ prodPushIsDeploy: "no" }).join("\n"), /prodPushIsDeploy: must be a boolean/);
});
