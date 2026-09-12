/**
 * Verifies the `upstream/langchain-postgres` submodule is checked out.
 *
 * `langchainjs-postgres` is a hand-maintained TypeScript port of
 * https://github.com/langchain-ai/langchain-postgres. The submodule pins the
 * exact upstream commit this port was last synced against; `diff-upstream.ts`
 * (run on a schedule in CI) compares that pin against upstream's latest
 * commit to detect when a manual port is needed.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE = join(__dirname, "..", "upstream", "langchain-postgres");

if (!existsSync(SUBMODULE) || readdirSync(SUBMODULE).length === 0) {
  console.error(
    "upstream submodule is not checked out.\nRun: git submodule update --init --recursive",
  );
  process.exit(1);
}

console.log("upstream/langchain-postgres submodule is present.");
