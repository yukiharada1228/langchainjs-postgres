const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, renameSync } = require("node:fs");
const { resolve } = require("node:path");
const process = require("node:process");
const { setTimeout: delay } = require("node:timers/promises");
const {
  PACKAGE,
  compareVersions,
  registryVersion,
} = require("./release-policy.cjs");

function requirePackage(manifest, version) {
  compareVersions(version, version);
  if (manifest.name !== PACKAGE || manifest.version !== version)
    throw new Error("Unexpected tarball name or version.");
}

function pack(version) {
  requirePackage(JSON.parse(readFileSync("package.json", "utf8")), version);
  mkdirSync("release-artifact", { recursive: true });
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        "release-artifact",
      ],
      { encoding: "utf8" },
    ),
  );
  requirePackage(packed, version);
  if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(packed.filename))
    throw new Error("Invalid tarball filename.");
  renameSync(
    resolve("release-artifact", packed.filename),
    "release-artifact/package.tgz",
  );
}

async function latestVersion() {
  const response = await globalThis.fetch(
    `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`,
    {
      signal: globalThis.AbortSignal.timeout(30000),
      headers: { "Cache-Control": "no-cache" },
    },
  );
  if (!response.ok)
    throw new Error(`Cannot determine npm latest: ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== PACKAGE) throw new Error("Unexpected latest package.");
  return metadata.version;
}

function verifyIntegrity(published, integrity) {
  if (published.dist.integrity !== integrity)
    throw new Error(
      "The published version exists with different bytes; refusing to overwrite or claim success.",
    );
}

async function publish(version) {
  const tarball = resolve("release-artifact/package.tgz");
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  requirePackage(manifest, version);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const existing = await registryVersion(version);
  if (existing) {
    verifyIntegrity(existing, integrity);
    process.stdout.write(`Already published: ${PACKAGE}@${version}\n`);
    return;
  }
  if (compareVersions(await latestVersion(), version) >= 0)
    throw new Error("Refusing to move npm latest backwards.");
  execFileSync(
    "npm",
    [
      "publish",
      tarball,
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
      "--ignore-scripts",
    ],
    { stdio: "inherit" },
  );
  // Registry publication is asynchronous. Never retry an npm publish in this process.
  for (let attempt = 0; attempt < 40; attempt++) {
    const published = await registryVersion(version);
    if (published) {
      verifyIntegrity(published, integrity);
      if ((await latestVersion()) !== version)
        throw new Error(
          "Published bytes match but npm latest has not converged; inspect before changing tags.",
        );
      process.stdout.write(`Verified ${PACKAGE}@${version}: ${integrity}\n`);
      return;
    }
    await delay(15000);
  }
  throw new Error(
    "npm accepted the publish but it is not visible yet. The hourly reconciliation will check again.",
  );
}

if (require.main === module) {
  const command = process.argv[2];
  const version = process.env.RELEASE_VERSION;
  Promise.resolve()
    .then(() => {
      if (command === "pack") return pack(version);
      if (command === "publish") return publish(version);
      throw new Error("Expected pack or publish.");
    })
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
}

module.exports = { requirePackage, verifyIntegrity };
