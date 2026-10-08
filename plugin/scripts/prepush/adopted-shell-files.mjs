// The shell files adopting projects copy verbatim (prepush-lib.sh must stay byte-identical; ci-local.sh is
// re-copied from the template). Shared by the semgrep-parse tests. SG_TEST_FILES (comma list) overrides, to
// prove the tests fail on a known-bad file.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
export const ADOPTED = process.env.SG_TEST_FILES
  ? process.env.SG_TEST_FILES.split(",")
  : [resolve(HERE, "prepush-lib.sh"), resolve(REPO, "scripts", "ci-local.sh")];
