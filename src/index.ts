import * as actionsCore from "@actions/core";
import * as actionsExec from "@actions/exec";
import * as actionsGithub from "@actions/github";
import { readFileSync } from "fs";

async function main() {
  let authorName;
  let authorEmail;
  let committerName;
  let committerEmail;

  if (actionsCore.getBooleanInput("sign-commits")) {
    // Import bot's GPG key for signing commits
    const gpgPrivateKey = actionsCore.getInput("gpg-private-key");
    const gpgFingerprint = actionsCore.getInput("gpg-fingerprint");
    const gpgPassphrase = actionsCore.getInput("gpg-passphrase");
    const git_config_global = true;
    const git_user_signingkey = true;
    const git_commit_gpgsign = true;

    // Set environment variables (signed commits)
    authorName = "";
    authorEmail = "";
    committerName = "";
    committerEmail = "";
    // TODO: GITHUB_ENV insertions
    // echo "GIT_AUTHOR_NAME=$GIT_AUTHOR_NAME" >> $GITHUB_ENV
    // echo "GIT_AUTHOR_EMAIL=<$GIT_AUTHOR_EMAIL>" >> $GITHUB_ENV
    // echo "GIT_COMMITTER_NAME=$GIT_COMMITTER_NAME" >> $GITHUB_ENV
    // echo "GIT_COMMITTER_EMAIL=<$GIT_COMMITTER_EMAIL>" >> $GITHUB_ENV

    // FIXME: Figure out how to do gpg stuff
    const gpgOutputs = await actionsExec.getExecOutput("some command here");
  } else {
    // Set environment variables (unsigned commits)
    authorName = actionsCore.getInput("git-author-name");
    authorEmail = actionsCore.getInput("git-author-email");
    committerName = actionsCore.getInput("git-committer-name");
    committerEmail = actionsCore.getInput("git-committer-email");
  }

  actionsCore.exportVariable("GIT_AUTHOR_NAME", authorName);
  actionsCore.exportVariable("GIT_AUTHOR_EMAIL", authorEmail);
  actionsCore.exportVariable("GIT_COMMITTER_NAME", committerName);
  actionsCore.exportVariable("GIT_COMMITTER_EMAIL", committerEmail);

  const token = actionsCore.getInput("token");
  const octokit = actionsGithub.getOctokit(token);

  const repoDetails = await octokit.rest.repos.get({
    ...actionsGithub.context.repo,
  });
  const baseBranch = actionsCore.getInput("base")
    ? actionsCore.getInput("base")
    : repoDetails.data.default_branch;
  const baseBranchRef = await octokit.rest.git.getRef({
    ...actionsGithub.context.repo,
    ref: `heads/${baseBranch}`,
  });
  const headBranch = actionsCore.getInput("branch");
  const branches = await octokit.rest.repos.listBranches({
    ...actionsGithub.context.repo,
  });
  if (!branches.data.some((branch) => branch.name === headBranch)) {
    await octokit.rest.git.createRef({
      ...actionsGithub.context.repo,
      ref: `refs/heads/${headBranch}`,
      sha: baseBranchRef.data.object.sha,
    });
  }

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
  const inputs = actionsCore.getInput("inputs").split(" ");
  const flakeDir = actionsCore.getInput("path-to-flake-dir");
  const flakeUpdatesWithWarning = (
    await actionsExec.getExecOutput(
      "nix flake update",
      [
        "--no-warn-dirty",
        // FIXME: `--update-input` is not a recognised flag
        //  ...inputs.map((input) => `--update-input ${input}`)
      ],
      { cwd: flakeDir },
    )
  ).stderr;
  if (!flakeUpdatesWithWarning) return;
  const [warning, ...flakeUpdates] = flakeUpdatesWithWarning.split("\n");
  const flakeUpdatesString = ["Flake lock file updates:", "", flakeUpdates]
    .join("\n")
    .trim();

  const blob = await octokit.rest.git.createBlob({
    ...actionsGithub.context.repo,
    content: readFileSync(`${flakeDir}flake.lock`, "utf-8"),
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
        path: `${flakeDir}flake.lock`,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      },
    ],
  });

  const newCommit = await octokit.rest.git.createCommit({
    ...actionsGithub.context.repo,
    author: { name: authorName, email: authorEmail },
    committer: { name: committerName, email: committerEmail },
    message: `${actionsCore.getInput("commit-msg")}\n\n${flakeUpdatesString}`,
    tree: tree.data.sha,
    parents: [currentCommit.data.sha],
  });

  await octokit.rest.git.updateRef({
    ...actionsGithub.context.repo,
    ref: `heads/${headBranch}`,
    sha: newCommit.data.sha,
    force: true,
  });

  // Set additional env variables (GIT_COMMIT_MESSAGE)
  const delimiter = (
    await actionsExec.getExecOutput("base64", [], {
      input: Buffer.from(
        (
          await actionsExec.getExecOutput(
            "dd if=/dev/urandom bs=15 count=1 status=none",
          )
        ).stdout,
      ),
    })
  ).stdout;
  const commitMessage = (
    await actionsExec.getExecOutput("git log --format=%b -n 1")
  ).stdout;
  // TODO: GITHUB_ENV insertions
  // echo "GIT_COMMIT_MESSAGE<<$DELIMITER" >> $GITHUB_ENV
  // echo "$COMMIT_MESSAGE" >> $GITHUB_ENV
  // echo "$DELIMITER" >> $GITHUB_ENV
  console.log("GIT_COMMIT_MESSAGE is:", commitMessage);

  // Create PR
  await octokit.rest.pulls.create({
    ...actionsGithub.context.repo,
    base: baseBranch,
    head: headBranch,

    title: actionsCore.getInput("pr-title"),
    body: actionsCore
      .getInput("pr-body")
      // FIXME: Figure out why GH isn't replacing env vars with their values
      .replace("{{ env.GIT_COMMIT_MESSAGE }}", flakeUpdatesString),

    // FIXME: Figure out how to add the following missing attributes:
    //   - delete-branch
    //   - committer
    //   - author
    //   - assignees
    //   - labels
    //   - reviewers
  });
}

main();
