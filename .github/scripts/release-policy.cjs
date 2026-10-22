const { requireProtection } = require("./dependency-automation.cjs");

const REPOSITORY = "yukiharada1228/langchainjs-postgres";
const PACKAGE = "@yukiharada1228/langchain-postgres";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REQUIRED_JOBS = [
  "test",
  "integration",
  "Automation Policy",
  "Supply Chain Security",
  "CI Success",
  ...["20.0.0", "20", "22", "24", "26"].map((node) => `Package (Node ${node})`),
];

function requireRepository(context) {
  if (
    `${context.repo.owner}/${context.repo.repo}` !== REPOSITORY ||
    context.ref !== "refs/heads/main"
  ) {
    throw new Error(
      "Release automation only runs from this repository's main branch.",
    );
  }
}

function requirePullTitle(title) {
  if (
    !/^(feat|fix|perf|security|revert|refactor|build|chore|docs|ci|test|style)(\([a-zA-Z0-9_./-]+\))?!?: \S[^\r\n]*$/.test(
      title,
    )
  ) {
    throw new Error(
      "Use a Conventional Commit PR title, e.g. fix: correct search, feat: add an option, or fix!: remove an API. See .github/releases.md.",
    );
  }
}

function validRun(run, workflowId, sha) {
  return (
    run.workflow_id === workflowId &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.head_sha === sha &&
    run.repository?.full_name === REPOSITORY &&
    run.head_repository?.full_name === REPOSITORY &&
    run.status === "completed" &&
    run.conclusion === "success"
  );
}

async function mainHead(github, context) {
  const { data } = await github.rest.git.getRef({
    ...context.repo,
    ref: "heads/main",
  });
  return data.object.sha;
}

async function greenMain(github, context, sha, runId) {
  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...context.repo,
    workflow_id: "ci.yml",
  });
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: workflow.id,
    head_sha: sha,
    event: "push",
    per_page: 100,
  });
  const run = data.workflow_runs.sort((a, b) => b.id - a.id)[0];
  if (
    !run ||
    (runId && String(run.id) !== String(runId)) ||
    !validRun(run, workflow.id, sha)
  )
    return false;
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRun,
    {
      ...context.repo,
      run_id: run.id,
      filter: "latest",
      per_page: 100,
    },
  );
  return REQUIRED_JOBS.every((name) =>
    jobs.some((job) => job.name === name && job.conclusion === "success"),
  );
}

async function releaseReady({ github, context }) {
  requireRepository(context);
  const sha = await mainHead(github, context);
  if (
    context.eventName === "workflow_run" &&
    context.payload.workflow_run.head_sha !== sha
  )
    return false;
  return greenMain(
    github,
    context,
    sha,
    context.eventName === "workflow_run"
      ? context.payload.workflow_run.id
      : undefined,
  );
}

async function jsonFile(github, context, path, ref) {
  const { data } = await github.rest.repos.getContent({
    ...context.repo,
    path,
    ref,
  });
  if (data.type !== "file" || data.encoding !== "base64")
    throw new Error(`Unexpected file: ${path}`);
  return JSON.parse(
    require("node:buffer").Buffer.from(data.content, "base64").toString(),
  );
}

async function releasePlan({ github, context, lookup = registryVersion }) {
  if (!(await releaseReady({ github, context })))
    return { ready: false, skipPullRequest: true };
  const sha = await mainHead(github, context);
  const manifest = await jsonFile(github, context, "package.json", sha);
  // Finish publishing the current version before proposing another one.
  return { ready: true, skipPullRequest: !(await lookup(manifest.version)) };
}

function onlyVersionChanged(before, after, lock = false) {
  const clean = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.version;
    if (lock) delete copy.packages[""].version;
    return copy;
  };
  return require("node:util").isDeepStrictEqual(clean(before), clean(after));
}

function validReleasePull(pr, files, bot) {
  const allowed = new Set([
    "package.json",
    "package-lock.json",
    ".release-please-manifest.json",
    "CHANGELOG.md",
  ]);
  return (
    pr.state === "open" &&
    !pr.draft &&
    pr.user?.login === bot &&
    pr.user?.type === "Bot" &&
    pr.head?.repo?.full_name === REPOSITORY &&
    pr.base?.repo?.full_name === REPOSITORY &&
    pr.base.ref === "main" &&
    pr.head.ref === "release-please--branches--main" &&
    pr.labels.some((label) => label.name === "autorelease: pending") &&
    !pr.labels.some((label) => label.name === "no-automerge") &&
    files.length === 4 &&
    files.every(
      (file) =>
        allowed.has(file.filename) &&
        ["added", "modified"].includes(file.status),
    )
  );
}

async function queueRelease({ github, context, bot }) {
  requireRepository(context);
  const { data: pulls } = await github.rest.pulls.list({
    ...context.repo,
    state: "open",
    base: "main",
    head: `${context.repo.owner}:release-please--branches--main`,
  });
  for (const pr of pulls) {
    const files = await github.paginate(github.rest.pulls.listFiles, {
      ...context.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    if (!validReleasePull(pr, files, bot))
      throw new Error(
        "Release PR has unexpected authorship, files, or opt-out label; refusing automatic merge.",
      );
    const base = await mainHead(github, context);
    if (pr.base.sha !== base) return;
    const before = await jsonFile(github, context, "package.json", base);
    const after = await jsonFile(github, context, "package.json", pr.head.sha);
    const beforeLock = await jsonFile(
      github,
      context,
      "package-lock.json",
      base,
    );
    const afterLock = await jsonFile(
      github,
      context,
      "package-lock.json",
      pr.head.sha,
    );
    const manifest = await jsonFile(
      github,
      context,
      ".release-please-manifest.json",
      pr.head.sha,
    );
    if (
      after.name !== PACKAGE ||
      !VERSION.test(after.version) ||
      compareVersions(after.version, before.version) <= 0 ||
      !onlyVersionChanged(before, after) ||
      !onlyVersionChanged(beforeLock, afterLock, true) ||
      afterLock.version !== after.version ||
      afterLock.packages[""].version !== after.version ||
      Object.keys(manifest).length !== 1 ||
      manifest["."] !== after.version
    ) {
      throw new Error(
        "Release PR must only advance synchronized package versions and the changelog.",
      );
    }
    const { data: protection } = await github.rest.repos.getBranchProtection({
      ...context.repo,
      branch: "main",
    });
    requireProtection(protection);
    const { data: current } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: pr.number,
    });
    if (
      current.head.sha !== pr.head.sha ||
      !validReleasePull(current, files, bot) ||
      (await mainHead(github, context)) !== base
    )
      return;
    if (!current.auto_merge) {
      await github.graphql(
        "mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH}) { clientMutationId } }",
        { id: current.node_id },
      );
    }
  }
}

function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b))
    throw new Error("Only stable semantic versions are supported.");
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

async function registryVersion(version, fetch = globalThis.fetch) {
  if (!VERSION.test(version)) throw new Error("Invalid package version.");
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/${version}`,
    {
      signal: globalThis.AbortSignal.timeout(30000),
      headers: { "Cache-Control": "no-cache" },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `npm registry returned ${response.status}; not treating this as an unpublished version.`,
    );
  const data = await response.json();
  if (
    data.name !== PACKAGE ||
    data.version !== version ||
    !data.dist?.integrity
  )
    throw new Error("Unexpected npm registry metadata.");
  return data;
}

async function publishCandidate({ github, context, lookup = registryVersion }) {
  requireRepository(context);
  const head = await mainHead(github, context);
  const current = await jsonFile(github, context, "package.json", head);
  if (current.name !== PACKAGE || !VERSION.test(current.version))
    throw new Error("Invalid release manifest.");
  const tag = `v${current.version}`;
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({
      ...context.repo,
      tag,
    }));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (release.draft || release.prerelease) return null;
  const { data: commit } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: `tags/${tag}`,
  });
  const sha = commit.sha;
  const { data: comparison } =
    await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${sha}...${head}`,
    });
  if (!["ahead", "identical"].includes(comparison.status))
    throw new Error("Release tag is not an ancestor of main.");
  const manifest = await jsonFile(github, context, "package.json", sha);
  if (manifest.version !== current.version || manifest.name !== PACKAGE)
    throw new Error("Release tag and package version differ.");
  if (!(await greenMain(github, context, sha)))
    throw new Error("Release commit has not passed the complete main CI.");
  const published = await lookup(manifest.version);
  return { sha, tag, version: manifest.version, published: Boolean(published) };
}

module.exports = {
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
};
