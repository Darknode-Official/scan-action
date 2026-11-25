# Darknode Scan Action

Runs the Darknode code scanner on every pull request and fails the check only when the change adds a **new** high or critical finding. Findings that were already in the code do not block anyone, so the check can be required from day one.

```yaml
- uses: Darknode-Official/scan-action@v1
```

- Leaked secrets, risky code (with taint tracking from untrusted input to dangerous calls in JavaScript and TypeScript) and known-vulnerable pinned dependencies.
- Results go to the job summary and, optionally, to GitHub code scanning as SARIF.
- The scan runs on your runner. Your code is never sent to Darknode or anyone else.

## Usage

Add `.github/workflows/darknode.yml`:

```yaml
name: Darknode

on:
  pull_request:
  push:
    branches: [main]   # keeps the code scanning baseline for the default branch current

permissions:
  contents: read
  security-events: write   # upload results to GitHub code scanning
  actions: read            # needed by the upload in private repositories

jobs:
  scan:
    name: Darknode scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Darknode-Official/scan-action@v1
```

That is the whole setup. The default checkout (one commit) is enough: the action fetches the base commit it compares with. In a private repository checked out with `persist-credentials: false`, that fetch has no credentials, so check out with `fetch-depth: 0` instead.

Runs on Linux and macOS runners, GitHub-hosted or self-hosted, that have `bash`, `curl` and `git`. It uses the Node.js 20 or newer already on the runner, and installs Node.js 20 only when there is none.

If code scanning is not available to the repository (see [Code scanning](#code-scanning)), set `sarif: false` and keep only `contents: read`:

```yaml
permissions:
  contents: read

# ...
      - uses: Darknode-Official/scan-action@v1
        with:
          sarif: false
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `fail-on` | `high` | Lowest severity of a new finding that fails the check: `critical`, `high`, `medium`, `low`, or `none` to report without failing. |
| `path` | `.` | Folder to scan, relative to the workspace. A `.darknodeignore` at its root is honoured. |
| `sarif` | `true` | Upload results to GitHub code scanning. Needs `security-events: write`; private repositories also need GitHub Advanced Security. |
| `include-review` | `false` | Also upload needs-review items to code scanning. They never fail the check. |
| `diff` | `true` | Fail only on findings that are new compared with a base commit. See [What fails the check](#what-fails-the-check). |
| `deps` | `true` | Check pinned dependencies in manifests and lockfiles against OSV.dev advisories. Sends package names and versions, never code. |

## Outputs

| Output | Description |
|---|---|
| `critical`, `high`, `medium`, `low` | Number of new findings at each severity. Needs-review items are not included. |
| `needs-review` | Number of new needs-review items. |
| `result` | `passed` or `failed`. With `fail-on: none` it is always `passed`. |
| `mode` | `diff` when findings were compared with a base commit, `full` when the whole folder was scanned. |
| `sarif-file` | Absolute path of the SARIF file on the runner. With `sarif: true` it covers the whole folder; with `sarif: false` in diff mode it covers the changed files only. |

To read the outputs after a failure, give the step an `id` and `continue-on-error: true`, then check `steps.<id>.outputs.result`.

## What fails the check

With `diff: true` (the default) the action compares the checked-out code with a base commit and fails only on findings at or above `fail-on` that the change introduces:

| Event | Compared with |
|---|---|
| `pull_request`, `pull_request_target` | The pull request base commit |
| `merge_group` | The merge queue base commit |
| `push` | The commit before the push (`github.event.before`) |

The action falls back to a **full scan**, where every finding at or above `fail-on` counts, when there is nothing to compare with:

- a push that creates a branch, or the first push to a repository (there is no previous commit);
- any other event, such as `workflow_dispatch` or `schedule`;
- a base commit that cannot be fetched, for example after a force-push;
- `diff: false`.

The job summary always says which mode ran and why. Other rules:

- **Needs-review items never fail the check.** These are risky calls (for example a shell command built from a variable) where the scanner did not trace untrusted input into the call. They are counted in the summary and kept out of code scanning unless `include-review` is `true`.
- In test, fixture, example and documentation paths, secrets are reported as low and critical code findings as high.
- Files the repository does not track in git, folders such as `node_modules`, `vendor` and `dist`, binaries, minified bundles and files over 600 KB are not scanned.
- The check fails after the SARIF upload, so the results of a failing pull request still reach code scanning.

## Make it a required check

A failing check only blocks merging once it is required. Run the workflow once first so GitHub knows the check name (the job `name`, `Darknode scan` in the example above).

**With a ruleset (recommended):**

1. In the repository, open **Settings**, then **Rules**, then **Rulesets**, and choose **New ruleset**, then **New branch ruleset**.
2. Name it, set **Enforcement status** to **Active**, and under **Target branches** add the default branch.
3. Enable **Require status checks to pass**, choose **Add checks**, and select **Darknode scan**. Set its source to **GitHub Actions** so no other app can report that check name.
4. Save. Organisations can apply the same rule to many repositories with an organisation ruleset.

**With classic branch protection:** **Settings**, then **Branches**, then **Add branch protection rule** for the default branch; enable **Require status checks to pass before merging** and select **Darknode scan**.

Notes:

- If the repository uses a merge queue, add `merge_group:` to the workflow's `on:` block, or queued pull requests wait for a check that never runs.
- Do not put `paths` or `paths-ignore` filters on a workflow that provides a required check: pull requests that skip it stay at "Expected: waiting for status to be reported".
- Rulesets and branch protection on private repositories need a paid GitHub plan.

## Silence a reviewed false positive

When someone has reviewed a finding and accepted it, mark it in the code so the decision is visible in review and in history:

```js
exec(BUILD_COMMAND); // darknode-ignore: constant command, no user input (reviewed)

// darknode-ignore-next-line: test credential for the local emulator only
const key = "...";
```

- `darknode-ignore` anywhere in a comment on the flagged line skips findings on that line. `nosec` works the same way.
- `darknode-ignore-next-line` on the line above skips findings on the next line.
- To skip whole paths, such as fixtures, generated code or vendored code, list them in `.darknodeignore` at the root of the scanned folder. It uses gitignore-style patterns: `#` comments, `dir/`, `*`, `?`, `**`, and a leading `/` to anchor at the root. Negation (`!`) is not supported.

```gitignore
# .darknodeignore
/test/fixtures/
generated/**/*.js
```

Use the comment syntax of the file's language (`#` in Python, shell and YAML). Dismissing an alert in the Security tab does not change the gate; the markers do. Because only new findings fail the check, existing findings do not need markers.

## What leaves the runner

None of your code. The scanner is a Node.js program that reads your files on the runner. The only network traffic is:

| Destination | What is sent | When |
|---|---|---|
| `raw.githubusercontent.com` | A download request for each pinned scanner file (no data about your repository) | Every run |
| `api.osv.dev` | Package names, versions and ecosystems read from manifests and lockfiles, then advisory IDs for details. No file contents, paths or repository names. | When `deps` is `true` (the default) |
| Your repository's `origin` on GitHub | `git fetch` of the base commit | In diff mode, when the checkout does not already contain it |
| GitHub code scanning, in your own repository | The SARIF file: rule IDs, messages and file locations | When `sarif` is `true` |

Nothing is sent to Darknode: no telemetry, no account and no API key. Secret values are masked (only the last four characters are kept) in the log, the summary and the SARIF.

## Code scanning

- The upload needs `security-events: write`. In private repositories, the upload also needs `actions: read`.
- Code scanning is free for public repositories. Private and internal repositories need GitHub Advanced Security (GitHub Code Security). Without it, set `sarif: false`; the gate works the same and only needs `contents: read`.
- Pull requests from forks get a read-only token, so the action skips the upload for them. The gate still applies.
- Results are uploaded under the category `darknode` (`darknode/<path>` when `path` is a subfolder), so one job can scan several folders without overwriting each other's alerts.

## How the scanner is pinned

The scanner itself lives in [Darknode-Official/darknode-web](https://github.com/Darknode-Official/darknode-web) (`public/js/codescan/`) and is the same engine as the Code Scanner on darknode.ai. Each release of this action pins one immutable darknode-web commit and the SHA-256 of every scanner file in `action.yml`. At run time the action downloads those files at that commit and checks each hash before running anything; if a single byte differs, the step fails and the scanner does not run.

`@v1` moves to the newest `v1.x.y` release. To freeze the action and the scanner completely, pin the action to a full commit SHA instead:

```yaml
- uses: Darknode-Official/scan-action@<full commit SHA> # v1.x.y
```

Every third-party action this action uses is also pinned to a full commit SHA.

### Re-pinning (maintainers)

```sh
node scripts/pin.mjs <darknode-web commit SHA>
```

The script refuses commits that are not on darknode-web's `main`, reads the file list (`SCANNER_FILES`) from `public/js/codescan/ci.js` at that commit, downloads each file, and rewrites the pin block in `action.yml`. Open a pull request with the result; the self-test workflow runs the new pin against the fixtures in `selftest/`.

## Licence

This action and the Darknode Code Scanner are **source-available, not open source**.

- The scanner is covered by the [darknode-web LICENSE](https://github.com/Darknode-Official/darknode-web/blob/main/LICENSE). On its own that licence allows only reading and studying the source for personal learning, and referencing techniques in your own original work without copying substantial portions. It prohibits copying, redistributing, modifying, creating derivative works, and using or running the code anywhere other than darknode.ai.
- This repository's [LICENSE](LICENSE) adds one permission: you may reference this action from GitHub Actions workflows to scan repositories you own or are authorised to scan, and run it, with the pinned scanner, unmodified, on GitHub-hosted or self-hosted runners for that purpose. Copying, redistributing, modifying, or offering the action or the scanner as part of a hosted service is not permitted.

Licensing inquiries: contact@darknode.ai
