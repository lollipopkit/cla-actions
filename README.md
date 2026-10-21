# cla-actions

CLA check for GitHub pull requests, with no third-party dependency beyond
`actions/github-script`. The agreement itself stays in each repository; these
actions only check and record signatures.

- **Check** (`lollipopkit/cla-actions`): everyone who authored a commit, plus
  the pull request's opener, must have signed. A comment whose whole body is
  `I have read the CLA Document and I hereby sign the CLA` signs; `recheck`
  runs again. The verdict is the job's own check run: make the job (`signatures`
  below) a required check. A comment run is not attached to the head commit,
  so after a signature or `recheck` it re-runs the latest `pull_request_target`
  run, and the pull request shows a single check.
- **Record** (`lollipopkit/cla-actions/record`): writes down a signature given
  elsewhere, such as an issue comment, by a maintainer.

Signatures are a JSON file on an orphan branch (`cla-signatures`,
`signatures/v1/cla.json`), matched by account id. Bump the path to `v2` when a
new CLA version must be signed again.

Bots, `web-flow`, the `allowlist` (default: the repository owner) and known
coding-agent accounts never need to sign.

## Usage

`.github/workflows/cla.yml`:

```yaml
name: CLA

on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions:
  contents: write # the cla-signatures branch
  pull-requests: write # the "please sign" comment
  actions: write # re-run the check after a signature

concurrency:
  # Never cancel: a cancelled run could drop a signature write.
  group: cla-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  signatures:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    # Cheap pre-filter; the action checks the comment body strictly.
    if: >-
      github.repository == 'OWNER/REPO' &&
      (github.event_name == 'pull_request_target' ||
       (github.event.issue.pull_request != null &&
        (contains(github.event.comment.body, 'I have read the CLA Document and I hereby sign the CLA') ||
         contains(github.event.comment.body, 'recheck'))))
    steps:
      - uses: lollipopkit/cla-actions@<sha> # v2
        with:
          note: You keep the copyright to what you wrote.
```

`.github/workflows/cla-record.yml`:

```yaml
name: CLA record

on:
  workflow_dispatch:
    inputs:
      login:
        description: GitHub username of the person who signed
        required: true
        type: string
      reference:
        description: URL of the comment where they signed
        required: true
        type: string

permissions:
  contents: write

concurrency:
  group: cla-signatures-write
  cancel-in-progress: false

jobs:
  record:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: lollipopkit/cla-actions/record@<sha> # v2
        with:
          login: ${{ inputs.login }}
          reference: ${{ inputs.reference }}
```

Inputs are listed in [`action.yml`](action.yml) and
[`record/action.yml`](record/action.yml).

## Security

The check runs on `pull_request_target`, holding a write token while a fork's
pull request is in play. It never checks out or runs repository content —
every step goes through the GitHub API — and event data reaches the script
through the payload or environment, never interpolated into code. Pin the
action by commit SHA.

## Development

`node --test test/` runs both actions against an in-memory GitHub API,
including the `script:` wiring in each `action.yml`.
