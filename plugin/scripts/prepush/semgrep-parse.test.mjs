#!/usr/bin/env node
// Regression: the shell files adopters copy into their repos (prepush-lib.sh, the template ci-local.sh)
// must stay parseable by semgrep's bash grammar. An unparseable file is a `semgrep-error` finding in the
// adopter's predeploy gate (EasyCaller 2026-10-08, fixed by hand in 8de69d36, then reverted by every
// re-sync of the canonical file). This is the fast, tool-free half: it greps for the exact forms semgrep
// rejects. The real parse by semgrep itself is semgrep-parse.integration.test.mjs (heavy tier).
import { readFileSync } from "node:fs";
import { ADOPTED } from "./adopted-shell-files.mjs";


const RULES = [
  [/10#/, "base-10 arithmetic prefix `10#` (use the _pp_dec helper)"],
  [/\bcase\b[^#]*\$'\n'[^#]*\bin\b|\)\s*;;.*\$'\n'|\*\$'\n'/, "`$'\n'` inside a case word or pattern (use $_PP_NL)"],
  [/^(?!.*\beval\b).*\{\w+\}<>/, "`<>` fd open outside eval (semgrep has no `<>`; route it through eval)"],
  [/^\s*case\b.*\bin\b.*\besac\b/, "one-line `case ... esac` (write it multi-line)"],
  [/\$\{\w+:?[-=+?]<[^}]*>\}/, "`<...>` as a ${var:-default} (semgrep reads the < as a redirect; use plain words)"],
];

let failed = 0;
for (const file of ADOPTED) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trimStart();
    if (t.startsWith("#")) return;
    for (const [re, why] of RULES) {
      if (re.test(line)) { console.error(`FAIL ${file}:${i + 1}: ${why}\n    ${line.trim()}`); failed++; }
    }
    // a heredoc body must not run straight into a closing `}` (semgrep mis-parses it)
    if (/^\}\s*$/.test(line) && /^[A-Za-z_]*EOF[A-Za-z]*$/.test((lines[i - 1] || "").trim())) {
      console.error(`FAIL ${file}:${i + 1}: heredoc terminator directly before a closing \`}\` (use process substitution)`); failed++;
    }
  });
}
if (failed) { console.error(`\n${failed} semgrep-unparseable form(s) in the adopted shell files.`); process.exit(1); }
console.log(`ok - ${ADOPTED.length} adopted shell files free of known semgrep-unparseable forms`);
