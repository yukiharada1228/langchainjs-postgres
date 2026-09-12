/**
 * Detects changes between the pinned `upstream/langchain-postgres` submodule
 * commit and the latest commit on upstream's default branch, so this
 * TypeScript port (`src/`) can be kept in sync with
 * https://github.com/langchain-ai/langchain-postgres (Python).
 *
 * This project has no automated Python -> TypeScript translation: porting is
 * done by a human (or an AI assistant) reading the upstream diff. This script
 * only detects *that* upstream moved and prints *what* changed, so that work
 * can be scoped.
 *
 * When GITHUB_OUTPUT is set (GitHub Actions), writes:
 *   outdated=true|false
 *   current=<sha>
 *   latest=<sha>
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SUBMODULE = join(ROOT, "upstream", "langchain-postgres");

// Only these upstream paths matter for the JS port; ignore upstream
// test/doc/CI-only churn that has no corresponding TypeScript surface.
const WATCHED_PATHS = ["langchain_postgres/"];

function git(args: string, cwd = SUBMODULE): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

function setOutput(name: string, value: string): void {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${name}=${value}\n`);
}

function main(): void {
  if (!existsSync(SUBMODULE)) {
    console.error(
      "upstream submodule not found. Run: git submodule update --init --recursive",
    );
    process.exit(1);
  }

  const current = git("rev-parse HEAD");
  git("fetch origin --quiet");
  const defaultBranch = git("rev-parse --abbrev-ref origin/HEAD").replace("origin/", "");
  const latest = git(`rev-parse origin/${defaultBranch}`);

  console.log("Upstream update check: langchain-ai/langchain-postgres\n");
  console.log(`Current (pinned): ${current}`);
  console.log(`Latest:           ${latest}\n`);

  setOutput("current", current);
  setOutput("latest", latest);

  if (current === latest) {
    console.log("Upstream is up to date. Nothing to sync.");
    setOutput("outdated", "false");
    return;
  }

  const changedAll = git(`diff --name-only ${current} ${latest}`)
    .split("\n")
    .filter(Boolean);
  const changed = changedAll.filter((f) => WATCHED_PATHS.some((p) => f.startsWith(p)));

  if (changed.length === 0) {
    console.log(
      `Upstream moved (${changedAll.length} file(s) changed), but none touch ` +
        `${WATCHED_PATHS.join(", ")}. Nothing to port.`,
    );
    setOutput("outdated", "false");
    return;
  }

  setOutput("outdated", "true");

  console.log(`Changed files under ${WATCHED_PATHS.join(", ")}:`);
  for (const f of changed) console.log(`- ${f}`);

  console.log("\nUpstream commits touching those paths:");
  const log = git(`log --oneline ${current}..${latest} -- ${WATCHED_PATHS.join(" ")}`);
  console.log(log || "(no direct commits; changes may have arrived via a merge)");

  console.log("\nSuggested next steps:");
  console.log("- Diff the changed upstream files against the corresponding module in src/.");
  console.log("- Port the new/changed behavior into TypeScript, keeping API names analogous.");
  console.log("- Add/update tests under tests/ to cover the change.");
  console.log(`- Bump the submodule: cd upstream/langchain-postgres && git checkout ${latest}`);
}

main();
