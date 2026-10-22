import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const consumer = mkdtempSync(join(tmpdir(), "langchain-postgres-package-"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: string[]) {
  execFileSync(command, args, { cwd: consumer, stdio: "inherit" });
}

try {
  const packResult = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--pack-destination", consumer], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  // npm 12 keys JSON output by package name; earlier releases return an array.
  const packed = Array.isArray(packResult)
    ? packResult[0]
    : packResult[manifest.name];
  if (!packed || typeof packed.filename !== "string") {
    throw new Error("npm pack did not report the package tarball");
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "package-compatibility-consumer",
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `file:./${packed.filename}`,
        "@langchain/core": manifest.devDependencies["@langchain/core"],
      },
      devDependencies: {
        "@types/node": "^20.0.0",
        "@types/pg": manifest.devDependencies["@types/pg"],
        typescript: manifest.devDependencies.typescript,
        "typescript-previous": "npm:typescript@5.9.3",
      },
    }),
  );
  // Resolve from scratch: the repository lockfile can hide consumer-only failures.
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  run(npm, ["ls", "@langchain/core", "langsmith"]);

  for (const extension of ["mts", "cts"]) {
    copyFileSync(
      join(root, "tests/package/consumer.ts"),
      join(consumer, `consumer.${extension}`),
    );
  }
  for (const compiler of ["typescript-previous", "typescript"]) {
    for (const module of ["Node16", "NodeNext"]) {
      // Upstream LangChain/js-tiktoken and LangSmith declarations rely on
      // require(ESM) type resolution, which Node16 mode cannot model. Still
      // check our consumer imports in Node16; fully check dependencies in NodeNext.
      const skipLibCheck = module === "Node16";
      console.log(
        `Checking ${compiler}, ${module}, skipLibCheck=${skipLibCheck}`,
      );
      run(process.execPath, [
        join(consumer, "node_modules", compiler, "bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        String(skipLibCheck),
        "--target",
        "ES2022",
        "--module",
        module,
        "--moduleResolution",
        module,
        "consumer.mts",
        "consumer.cts",
      ]);
    }
  }

  copyFileSync(
    join(root, "tests/package/smoke.mjs"),
    join(consumer, "smoke.mjs"),
  );
  for (const mode of ["esm", "cjs"]) {
    const args = ["smoke.mjs", mode];
    if (process.env.PACKAGE_NODE_VERSION) {
      run(npm, [
        "exec",
        "--yes",
        `--package=node@${process.env.PACKAGE_NODE_VERSION}`,
        "--",
        "node",
        ...args,
      ]);
    } else {
      run(process.execPath, args);
    }
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
