import * as actionsCore from "@actions/core";
import * as actionsExec from "@actions/exec";
import * as actionsGithub from "@actions/github";

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

  // Run update-flake-lock.sh
  await actionsExec.exec("./update-flake-lock.sh", [], {
    env: {
      COMMIT_MSG: actionsCore.getInput("commit-msg"),
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
      NIX_OPTIONS: actionsCore.getInput("nix-options"),
      PATH_TO_FLAKE_DIR: actionsCore.getInput("path-to-flake-dir"),
      TARGETS: actionsCore.getInput("inputs"),
    },
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
  const token = actionsCore.getInput("token");
  const octokit = actionsGithub.getOctokit(token);
  await octokit.rest.pulls.create({
    ...actionsGithub.context.repo,
    base: actionsCore.getInput("base"),
    head: actionsCore.getInput("branch"),

    title: actionsCore.getInput("pr-title"),
    body: actionsCore.getInput("pr-body"),

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
