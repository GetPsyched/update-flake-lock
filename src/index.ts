import * as actionsCore from "@actions/core";
import * as actionsExec from "@actions/exec";
import * as actionsGithub from "@actions/github";
import { readFileSync } from "fs";

async function getSigningInfo() {
  if (actionsCore.getBooleanInput("sign-commits")) {
    // Import bot's GPG key for signing commits
    const gpgPrivateKey = actionsCore.getInput("gpg-private-key");
    const gpgFingerprint = actionsCore.getInput("gpg-fingerprint");
    const gpgPassphrase = actionsCore.getInput("gpg-passphrase");
    const git_config_global = true;
    const git_user_signingkey = true;
    const git_commit_gpgsign = true;

    // FIXME: Figure out how to do gpg stuff
    const gpgOutputs = await actionsExec.getExecOutput("some command here");

    return {
      author: { name: "", email: "" },
      committer: { name: "", email: "" },
    };
  } else {
    return {
      author: {
        name: actionsCore.getInput("git-author-name"),
        email: actionsCore.getInput("git-author-email"),
      },
      committer: {
        name: actionsCore.getInput("git-committer-name"),
        email: actionsCore.getInput("git-committer-email"),
      },
    };
  }
}

async function createBranch(token: string, base: string, head: string) {
  const octokit = actionsGithub.getOctokit(token);

  const repoDetails = await octokit.rest.repos.get({
    ...actionsGithub.context.repo,
  });
  const baseBranch = base ? base : repoDetails.data.default_branch;

  const branches = await octokit.rest.repos.listBranches({
    ...actionsGithub.context.repo,
  });
  if (!branches.data.some((branch) => branch.name === head)) {
    const baseBranchRef = await octokit.rest.git.getRef({
      ...actionsGithub.context.repo,
      ref: `heads/${baseBranch}`,
    });

    await octokit.rest.git.createRef({
      ...actionsGithub.context.repo,
      ref: `refs/heads/${head}`,
      sha: baseBranchRef.data.object.sha,
    });
  }

  return [baseBranch, head];
}

async function updateFlakeLock(options?: {
  inputs?: string[];
  nixOptions?: string[];
  workingDirectory?: string;
}) {
  // Run update-flake-lock.sh
  // await actionsExec.exec("./update-flake-lock.sh", [], {
  //   env: {
  //     COMMIT_MSG: actionsCore.getInput("commit-msg"),
  //     GIT_AUTHOR_NAME: authorName,
  //     GIT_AUTHOR_EMAIL: authorEmail,
  //     GIT_COMMITTER_NAME: committerName,
  //     GIT_COMMITTER_EMAIL: committerEmail,
  //     // Explicitly specify Nix path since it's not automatically picked up.
  //     NIX_BINARY: await actionsIo.which("nix", true),
  //     NIX_OPTIONS: actionsCore.getInput("nix-options"),
  //     PATH_TO_FLAKE_DIR: actionsCore.getInput("path-to-flake-dir"),
  //     TARGETS: actionsCore.getInput("inputs"),
  //   },
  // });
  const flakeUpdatesWithWarning = (
    await actionsExec.getExecOutput(
      "nix flake update",
      [
        "--no-warn-dirty",
        // FIXME: `--update-input` is not a recognised flag
        //  ...inputs.map((input) => `--update-input ${input}`)
      ],
      { cwd: options?.workingDirectory },
    )
  ).stderr;
  if (!flakeUpdatesWithWarning) return "";

  const [warning, ...flakeUpdates] = flakeUpdatesWithWarning.split("\n");
  return ["Flake lock file updates:", "", ...flakeUpdates].join("\n").trim();
}

async function commit(
  token: string,
  headBranch: string,
  message: string,
  pathToFlakeDir: string,
) {
  const octokit = actionsGithub.getOctokit(token);

  const blob = await octokit.rest.git.createBlob({
    ...actionsGithub.context.repo,
    content: Buffer.from(
      readFileSync(`${pathToFlakeDir}flake.lock`, "utf-8"),
    ).toString("base64"),
    encoding: "base64",
  });

  const currentCommit = await octokit.rest.repos.getCommit({
    ...actionsGithub.context.repo,
    ref: `heads/${headBranch}`,
  });

  const tree = await octokit.rest.git.createTree({
    ...actionsGithub.context.repo,
    base_tree: currentCommit.data.commit.tree.sha,
    tree: [
      {
        path: `${pathToFlakeDir}flake.lock`,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      },
    ],
  });

  if (tree.data.sha === currentCommit.data.commit.tree.sha) {
    console.log("Working tree is clean, skipping commit.");
    return "";
  }

  const newCommit = await octokit.rest.git.createCommit({
    ...actionsGithub.context.repo,
    ...(await getSigningInfo()),
    message: message,
    tree: tree.data.sha,
    parents: [currentCommit.data.sha],
  });

  await octokit.rest.git.updateRef({
    ...actionsGithub.context.repo,
    ref: `heads/${headBranch}`,
    sha: newCommit.data.sha,
    force: true,
  });

  // // Set additional env variables (GIT_COMMIT_MESSAGE)
  // const delimiter = (
  //   await actionsExec.getExecOutput("base64", [], {
  //     input: Buffer.from(
  //       (
  //         await actionsExec.getExecOutput(
  //           "dd if=/dev/urandom bs=15 count=1 status=none",
  //         )
  //       ).stdout,
  //     ),
  //   })
  // ).stdout;
  // const commitMessage = (
  //   await actionsExec.getExecOutput("git log --format=%b -n 1")
  // ).stdout;
  // // TODO: GITHUB_ENV insertions
  // // echo "GIT_COMMIT_MESSAGE<<$DELIMITER" >> $GITHUB_ENV
  // // echo "$COMMIT_MESSAGE" >> $GITHUB_ENV
  // // echo "$DELIMITER" >> $GITHUB_ENV
  // console.log("GIT_COMMIT_MESSAGE is:", commitMessage);
}

async function createPR(
  token: string,
  baseBranch: string,
  headBranch: string,
  meta: {
    title: string;
    body: string;
    labels?: string[];
    reviewers?: string[];
    assignees?: string[];
  },
) {
  const octokit = actionsGithub.getOctokit(token);
  const existingPR = await octokit.rest.pulls.list({
    ...actionsGithub.context.repo,
    head: headBranch,
  });
  if (existingPR.data.length !== 0) {
    console.log(
      `Skipping PR creation, it already exists at ${existingPR.data[0].html_url}`,
    );
    return { number: existingPR.data[0].number, operation: "updated" };
  }
  const pullRequest = await octokit.rest.pulls.create({
    ...actionsGithub.context.repo,
    base: baseBranch,
    head: headBranch,

    title: meta.title,
    body: meta.body,

    // FIXME: Figure out how to add the following missing attributes:
    //   - delete-branch
    //   - committer
    //   - author
  });

  if (meta.labels) {
    await octokit.rest.issues.addLabels({
      ...actionsGithub.context.repo,
      issue_number: pullRequest.data.number,
      labels: meta.labels,
    });
  }

  if (meta.reviewers) {
    await octokit.rest.pulls.requestReviewers({
      ...actionsGithub.context.repo,
      pull_number: pullRequest.data.number,
      reviewers: meta.reviewers,
    });
  }

  if (meta.assignees) {
    await octokit.rest.issues.addAssignees({
      ...actionsGithub.context.repo,
      issue_number: pullRequest.data.number,
      assignees: meta.assignees,
    });
  }

  return { number: pullRequest.data.number, operation: "created" };
}

async function main() {
  const token = actionsCore.getInput("token");
  const [baseBranch, headBranch] = await createBranch(
    token,
    actionsCore.getInput("base"),
    actionsCore.getInput("branch"),
  );

  const pathToFlakeDir = actionsCore.getInput("path-to-flake-dir");
  const flakeChangelog = await updateFlakeLock({
    inputs: actionsCore
      .getInput("inputs")
      .split(" ")
      .filter((input) => !!input),
    nixOptions: actionsCore
      .getInput("nix-options")
      .split(" ")
      .filter((input) => !!input),
    workingDirectory: pathToFlakeDir,
  });
  if (!flakeChangelog) return;

  await commit(
    token,
    headBranch,
    `${actionsCore.getInput("commit-msg")}\n\n${flakeChangelog}`,
    pathToFlakeDir,
  );

  const { number: prNumber, operation } = await createPR(
    token,
    baseBranch,
    headBranch,
    {
      title: actionsCore.getInput("pr-title"),
      body: actionsCore
        .getInput("pr-body")
        // FIXME: Figure out why GH isn't replacing env vars with their values
        .replace("{{ env.GIT_COMMIT_MESSAGE }}", flakeChangelog),
      labels: actionsCore
        .getInput("pr-labels")
        .split(",")
        .flatMap((label) => label.split("\n"))
        .filter((label) => !!label),
      reviewers: actionsCore
        .getInput("pr-reviewers")
        .split(",")
        .flatMap((label) => label.split("\n"))
        .filter((label) => !!label),
      assignees: actionsCore
        .getInput("pr-assignees")
        .split(",")
        .flatMap((label) => label.split("\n"))
        .filter((label) => !!label),
    },
  );

  actionsCore.setOutput("pull-request-number", prNumber);
  // FIXME: When will a PR be closed?
  actionsCore.setOutput("pull-request-operation", operation);
}

main();
