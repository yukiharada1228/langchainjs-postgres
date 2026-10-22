const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Buffer } = require("node:buffer");
const { readFileSync } = require("node:fs");
const {
  REPOSITORY,
  PACKAGE,
  REQUIRED_JOBS,
  requirePullTitle,
  validRun,
  releaseReady,
  releasePlan,
  greenMain,
  validReleasePull,
  onlyVersionChanged,
  queueRelease,
  compareVersions,
  registryVersion,
  publishCandidate,
} = require("./release-policy.cjs");
const { requirePackage, verifyIntegrity } = require("./npm-release.cjs");

const sha = "a".repeat(40);
const next = "b".repeat(40);
const bot = "release-app[bot]";
const context = {
  repo: { owner: "yukiharada1228", repo: "langchainjs-postgres" },
  ref: "refs/heads/main",
  eventName: "workflow_dispatch",
  payload: {},
};
const run = {
  id: 10,
  workflow_id: 7,
  head_sha: sha,
  event: "push",
  head_branch: "main",
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
  status: "completed",
  conclusion: "success",
};
const pr = {
  number: 99,
  node_id: "PR_99",
  state: "open",
  draft: false,
  user: { login: bot, type: "Bot" },
  head: {
    sha: next,
    ref: "release-please--branches--main",
    repo: { full_name: REPOSITORY },
  },
  base: { sha, ref: "main", repo: { full_name: REPOSITORY } },
  labels: [{ name: "autorelease: pending" }],
};
const files = [
  "package.json",
  "package-lock.json",
  ".release-please-manifest.json",
  "CHANGELOG.md",
].map((filename) => ({ filename, status: "modified" }));
const copy = (object) => JSON.parse(JSON.stringify(object));
function fixture() {
  const state = {
    head: sha,
    runs: [copy(run)],
    jobs: REQUIRED_JOBS.map((name) => ({ name, conclusion: "success" })),
    pr: copy(pr),
    files: copy(files),
    version: "0.2.0",
    comparison: "identical",
    calls: [],
  };
  const github = {
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: state.head } } }) },
      actions: {
        getWorkflow: async () => ({ data: { id: 7 } }),
        listWorkflowRuns: async () => ({ data: { workflow_runs: state.runs } }),
        listJobsForWorkflowRun: async () => state.jobs,
      },
      pulls: {
        list: async () => ({ data: [state.pr] }),
        listFiles: async () => state.files,
        get: async () => ({ data: state.pr }),
      },
      repos: {
        getContent: async ({ path, ref }) => {
          const version = ref === next ? "0.2.1" : state.version;
          let value = {
            name: PACKAGE,
            version,
            dependencies: { pg: "^8.23.0" },
          };
          if (path === "package-lock.json")
            value = {
              ...value,
              lockfileVersion: 3,
              packages: {
                "": { version },
                "node_modules/pg": { version: "8.23.1" },
              },
            };
          if (path === ".release-please-manifest.json")
            value = { ".": version };
          if (state.mutateFile) value = state.mutateFile(value, path, ref);
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(JSON.stringify(value)).toString("base64"),
            },
          };
        },
        getReleaseByTag: async () => ({
          data: { draft: false, prerelease: false },
        }),
        getCommit: async () => ({ data: { sha } }),
        compareCommitsWithBasehead: async () => ({
          data: { status: state.comparison },
        }),
        getBranchProtection: async () => ({
          data: {
            required_status_checks: {
              strict: true,
              checks: ["CI Success", "Supply Chain Security"].map((name) => ({
                context: name,
                app_id: 15368,
              })),
            },
          },
        }),
      },
    },
    paginate: async (method, args) => method(args),
    graphql: async (...args) => {
      state.calls.push(args);
    },
  };
  return { github, state };
}

test("PR titles preserve feature, fix, security and breaking-change signals", () => {
  for (const title of [
    "fix: repair filters",
    "feat(search): add hybrid query",
    "fix!: remove legacy hook",
    "security: bind parameters",
    "chore(deps): bump pg",
    "chore(main): release 0.2.1",
  ])
    assert.doesNotThrow(() => requirePullTitle(title));
  for (const title of [
    "update stuff",
    "Feat: thing",
    "fix:",
    "fix: ",
    "fix: title\nfeat: more",
  ])
    assert.throws(() => requirePullTitle(title));
});

test("only completed same-repository main push CI is eligible", () => {
  assert.equal(validRun(run, 7, sha), true);
  for (const change of [
    { workflow_id: 8 },
    { event: "pull_request" },
    { head_branch: "feature" },
    { head_sha: next },
    { status: "in_progress" },
    { conclusion: "failure" },
    { repository: { full_name: "evil/fork" } },
    { head_repository: { full_name: "evil/fork" } },
  ])
    assert.equal(validRun({ ...run, ...change }, 7, sha), false);
});

test("release gate requires every matrix job and ignores stale workflow events", async () => {
  const { github, state } = fixture();
  assert.equal(await releaseReady({ github, context }), true);
  state.jobs = state.jobs.filter((job) => job.name !== "Package (Node 20.0.0)");
  assert.equal(await greenMain(github, context, sha), false);
  state.jobs = REQUIRED_JOBS.map((name) => ({
    name,
    conclusion: name === "test" ? "skipped" : "success",
  }));
  assert.equal(await greenMain(github, context, sha), false);
  assert.equal(
    await releaseReady({
      github,
      context: {
        ...context,
        eventName: "workflow_run",
        payload: { workflow_run: { id: 10, head_sha: next } },
      },
    }),
    false,
  );
  await assert.rejects(
    releaseReady({
      github,
      context: { ...context, ref: "refs/heads/feature" },
    }),
  );
});

test("a newer failed CI prevents using an old successful result", async () => {
  const { github, state } = fixture();
  state.runs.push({ ...run, id: 11, conclusion: "failure" });
  assert.equal(await greenMain(github, context, sha), false);
});

test("do not propose the next version until the current version is on npm", async () => {
  const { github } = fixture();
  assert.deepEqual(
    await releasePlan({ github, context, lookup: async () => null }),
    { ready: true, skipPullRequest: true },
  );
  assert.deepEqual(
    await releasePlan({
      github,
      context,
      lookup: async () => ({ version: "0.2.0" }),
    }),
    { ready: true, skipPullRequest: false },
  );
});

test("automatic release merges cannot include source code, forks, humans or opt-outs", () => {
  assert.equal(validReleasePull(pr, files, bot), true);
  for (const change of [
    { draft: true },
    { state: "closed" },
    { user: { login: "human", type: "User" } },
    { head: { ...pr.head, repo: { full_name: "evil/fork" } } },
    { head: { ...pr.head, ref: "feature" } },
    { labels: [...pr.labels, { name: "no-automerge" }] },
  ])
    assert.equal(validReleasePull({ ...pr, ...change }, files, bot), false);
  assert.equal(
    validReleasePull(
      pr,
      [...files, { filename: "src/index.ts", status: "modified" }],
      bot,
    ),
    false,
  );
  assert.equal(
    validReleasePull(
      pr,
      files.map((file) => ({ ...file, status: "removed" })),
      bot,
    ),
    false,
  );
});

test("queue release only when package changes are synchronized version-only changes", async () => {
  const { github, state } = fixture();
  await queueRelease({ github, context, bot });
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0][1], { id: "PR_99" });
  state.calls = [];
  state.mutateFile = (value, path, ref) => {
    if (path === "package.json" && ref === next)
      value.scripts = { postinstall: "evil" };
    return value;
  };
  await assert.rejects(queueRelease({ github, context, bot }), /only advance/);
  assert.equal(state.calls.length, 0);
});

test("queue release refuses changed lockfile dependencies or incomplete branch protection", async () => {
  const { github, state } = fixture();
  state.mutateFile = (value, path, ref) => {
    if (path === "package-lock.json" && ref === next)
      value.packages["node_modules/pg"].version = "9.0.0";
    return value;
  };
  await assert.rejects(queueRelease({ github, context, bot }), /only advance/);
  state.mutateFile = null;
  github.rest.repos.getBranchProtection = async () => ({
    data: { required_status_checks: { strict: false } },
  });
  await assert.rejects(
    queueRelease({ github, context, bot }),
    /strict branch protection/,
  );
  assert.equal(state.calls.length, 0);
});

test("stale release PR is not merged and existing reservations are idempotent", async () => {
  const { github, state } = fixture();
  state.pr.base.sha = next;
  await queueRelease({ github, context, bot });
  assert.equal(state.calls.length, 0);
  state.pr.base.sha = sha;
  state.pr.auto_merge = { enabled_by: bot };
  await queueRelease({ github, context, bot });
  assert.equal(state.calls.length, 0);
});

test("version comparisons handle numeric components and reject prereleases", () => {
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.throws(() => compareVersions("0.2.1-beta", "0.2.0"));
  assert.equal(
    onlyVersionChanged(
      { version: "0.2.0", name: PACKAGE },
      { name: PACKAGE, version: "0.2.1" },
    ),
    true,
  );
});

test("only an explicit registry 404 means unpublished", async () => {
  assert.equal(
    await registryVersion("0.2.1", async () => ({ status: 404 })),
    null,
  );
  for (const status of [401, 403, 429, 500, 503])
    await assert.rejects(
      registryVersion("0.2.1", async () => ({ status, ok: false })),
      /not treating/,
    );
  await assert.rejects(
    registryVersion("0.2.1", async () => {
      throw new Error("network");
    }),
    /network/,
  );
  await assert.rejects(
    registryVersion("0.2.1", async () => ({
      status: 200,
      ok: true,
      json: async () => ({ name: "other", version: "0.2.1" }),
    })),
    /Unexpected/,
  );
});

test("publication resolves the tag, ancestor relationship and exact commit CI", async () => {
  const { github, state } = fixture();
  const candidate = await publishCandidate({
    github,
    context,
    lookup: async () => null,
  });
  assert.deepEqual(candidate, {
    sha,
    tag: "v0.2.0",
    version: "0.2.0",
    published: false,
  });
  assert.equal(
    (
      await publishCandidate({
        github,
        context,
        lookup: async () => ({ version: "0.2.0" }),
      })
    ).published,
    true,
  );
  state.comparison = "diverged";
  await assert.rejects(
    publishCandidate({ github, context, lookup: async () => null }),
    /ancestor/,
  );
  state.comparison = "identical";
  state.runs[0].conclusion = "failure";
  await assert.rejects(
    publishCandidate({ github, context, lookup: async () => null }),
    /complete main CI/,
  );
});

test("missing and draft releases do not publish; API failures are not hidden", async () => {
  const { github } = fixture();
  github.rest.repos.getReleaseByTag = async () => {
    throw Object.assign(new Error("missing"), { status: 404 });
  };
  assert.equal(await publishCandidate({ github, context }), null);
  github.rest.repos.getReleaseByTag = async () => {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  };
  await assert.rejects(publishCandidate({ github, context }), /forbidden/);
  github.rest.repos.getReleaseByTag = async () => ({ data: { draft: true } });
  assert.equal(await publishCandidate({ github, context }), null);
});

test("publication rejects unexpected packages and different published bytes", () => {
  assert.doesNotThrow(() =>
    requirePackage({ name: PACKAGE, version: "0.2.1" }, "0.2.1"),
  );
  assert.throws(() =>
    requirePackage({ name: "other", version: "0.2.1" }, "0.2.1"),
  );
  assert.throws(() =>
    requirePackage({ name: PACKAGE, version: "0.2.0" }, "0.2.1"),
  );
  assert.throws(
    () =>
      verifyIntegrity({ dist: { integrity: "sha512-other" } }, "sha512-tested"),
    /different bytes/,
  );
});

test("release build has no write credentials; publisher never installs or builds dependencies", () => {
  const workflow = readFileSync(
    require("node:path").join(__dirname, "../workflows/publish.yml"),
    "utf8",
  );
  const build = workflow.split("  build:\n")[1].split("  publish:\n")[0];
  const publish = workflow.split("  publish:\n")[1];
  assert.doesNotMatch(build, /id-token: write|contents: write|secrets\./);
  assert.doesNotMatch(
    publish,
    /npm ci|npm install|npm run build|NODE_AUTH_TOKEN/,
  );
  assert.match(publish, /environment: npm/);
  assert.match(publish, /id-token: write/);
  for (const match of workflow.matchAll(/uses: [^\s@]+@([^\s]+)/g))
    assert.match(match[1], /^[a-f0-9]{40}$/);
});
