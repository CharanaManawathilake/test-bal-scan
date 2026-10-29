# bal scan playground

This playground records what `bal scan` does. It does not check the results against expected values. For each scan tool version you list, it runs every case, which can be a single `.bal` file, a package, or a workspace, and saves the following:

- every command, its exit code and how long it took
- stdout, stderr and both streams together in the order they arrived
- the files each command created, changed or deleted, such as reports, `Dependencies.toml` and `target/`
- a few facts read from the output: the number of issues printed and their rules, the summary line, which reports were written and their issue counts, and any warnings or errors
- one `terminal.txt` per case and one for the whole run, so you can read everything without running anything again

A small web UI shows the runs. You can compare versions side by side, open the generated reports, and start new runs from it.

The cases follow the tests in [ballerina-platform/static-code-analysis-tool](https://github.com/ballerina-platform/static-code-analysis-tool). That includes the `main` branch and the in-source suppression work (`@scan:Suppress`, PR #115, branch `in-source-suppression`). Each case links back to the upstream test or fixture it is based on.

## Quick start

```bash
# Requirements: bal on PATH, Node.js 18+. The analyzer and platform cases also need javac/jar (JDK 21+).
cp .env.example .env          # .env already exists with defaults; set SCAN_VERSIONS and the SonarQube values
npm run setup:plugins         # once: builds the test analyzers + recorder platform plugin (see below)
npm test                      # runs every case for every version in SCAN_VERSIONS
npm run ui                    # opens http://localhost:4173
```

Useful variations:

```bash
node runner/run.mjs --versions=0.12.0,0.13.0-SNAPSHOT        # override SCAN_VERSIONS for one run
node runner/run.mjs --cases="packages/sup-*" --label=suppr     # only some cases, with a run name
node runner/run.mjs --tags=core-rules                          # by tag
node runner/run.mjs --skip-tags=sonarqube,network              # leave some out
npm run list                                                   # print the case catalog
```

## `.env`

| Key | Meaning |
|---|---|
| `SCAN_VERSIONS` | Comma-separated scan tool versions. You can add `@central` (the default), `@local` (uses `--repository=local`), `@dev` (sets `BALLERINA_DEV_CENTRAL=true`) or `@stage`. For each version the runner tries `bal tool use scan:<v>`, then `bal tool pull scan:<v>`, and then checks `bal tool list`. If that version still isn't active, it is marked **unavailable**, its cases are skipped, and the log is saved in `tool-switch.txt`. |
| `RESTORE_ACTIVE_VERSION` | Switches back to the scan version that was active before the run (default `true`). |
| `CASES`, `TAGS`, `SKIP_TAGS` | Default case selection. The command-line flags override these. |
| `SONAR_HOST_URL`, `SONAR_TOKEN` | Used by the `sonarqube` cases. Each case gets a `sonar-project.properties` with these values, and they are also exported as environment variables. The token is masked as `***` in every saved output. |
| `SONAR_PLATFORM_PLUGIN_PATH` | The platform plugin JAR, or a URL to it, that goes into the `[[platform]]` entry of the case's `Scan.toml`. |
| `SONAR_SCANNER_HOME` | Its `bin` folder is added to the front of `PATH`, because the plugin calls `sonar-scanner`. |
| `SONAR_PROJECT_KEY_PREFIX` | Project keys are `<prefix>-<case>-<version>`. |
| `SCAN_COMMAND_JAR`, `BAL_DISTRIBUTION_HOME` | Overrides for `setup:plugins`. Both are detected automatically. |
| `STEP_TIMEOUT_SECONDS`, `UI_PORT` | Step timeout and UI port. |

A value exported in your shell overrides the one in `.env`, for example `SCAN_VERSIONS=0.12.0 npm test`.

## Layout

```
cases/
  single-files/<case>/   case.json + the .bal files (scanned as standalone files)
  packages/<case>/       case.json + a package (or several packages in sub folders)
  workspaces/<case>/     case.json + a workspace (Ballerina.toml with [workspace])
runner/                  run.mjs (runner), serve.mjs (UI server), lib/
ui/                      the web UI (plain HTML/JS, no build step)
tools/                   build-test-plugins.mjs and the Java sources of the test plugins
results/<run-id>/        run.json, terminal.txt, <version>/<category>/<case>/{case.json, terminal.txt, steps/, work/}
```

`work/` is a fresh copy of the fixture that the commands run in. It is kept after the run, so you can open the generated `target/report/scan_results.json`, the SARIF files, `scan_report.html`, `platform-recorder-output.json` and so on.

## Case definition (`case.json`)

```jsonc
{
  "title": "Short title",
  "description": "What this case shows",
  "tags": ["package", "suppression"],
  "upstream": ["SuppressionTest#testIgnoreSuppressions", "test-resources/bal-project-with-suppressions"],
  "requires": { "plugins": true, "env": ["SONAR_TOKEN"] },   // the case is skipped (with the reason) when these are missing
  "setup": [ { "name": "Lock dependencies", "run": "bal build", "cwd": "." } ],
  "steps": [
    { "name": "Scan", "run": "bal scan --format=sarif", "cwd": ".", "note": "shown in the UI", "env": { "X": "${SONAR_TOKEN}" } }
  ]
}
```

- `setup` defaults to running `bal build` for packages and workspaces, because scan 0.13+ won't scan a package that has no `Dependencies.toml`. Single files get no setup by default. Setup steps are recorded too, but the overview leaves them out. A step inside `steps` can also have `"setup": true`.
- In `run`, `cwd` and `env`, a `${VAR}` placeholder is replaced with a value from `.env` or one of the values below. Every file whose name ends in `.tmpl` is filled in the same way and saved without the `.tmpl` ending, which is how `Scan.toml.tmpl` and `sonar-project.properties.tmpl` get real paths, URLs and tokens.
  - `WORK_DIR`: the work folder, with forward slashes, safe to put in TOML
  - `WORK_DIR_NATIVE`: the same folder as a native path
  - `RECORDER_PLUGIN_JAR`
  - `PLUGINS_OUT_DIR`
  - `SCAN_VERSION`
  - `SONAR_PROJECT_KEY`
  - `CASE_ID`
- `npm run list -- --markdown` prints the case table.

## Test plugins (`npm run setup:plugins`)

Upstream builds its test plugins with Gradle and GitHub Packages. `tools/build-test-plugins.mjs` builds the same plugins with only `javac`, `jar` and `bal`:

- **Analyzers:** `exampleOrg|ballerina|ballerinax/example_module_static_code_analyzer`, plus `invalid/invalid_module_{ruleformat,rulekind,rules}_static_code_analyzer`, which have deliberately broken `rules.json` files. Each analyzer reports rule 1 once per document, like upstream. The script packs them, pushes them to the **local** repository, and then copies them into `~/.ballerina/repositories/central.ballerina.io/bala/...`, as upstream's `build.gradle` does, so `[[analyzer]]` entries without `repository = "local"` can find them.
- **Platform plugin:** `tools/test-plugins/out/recorder-platform-plugin.jar` provides the `recorder` and `recorder2` platforms. Each writes `platform-<name>-output.json` into the working directory, containing the issues, the platform arguments and `initiatedByPlatform`, and prints a one-line summary.

The script compiles against the active scan tool's `scan-command` JAR. Ballerina 2201.14 is built for Java 25, so it falls back to an older installed distribution's `bre/lib` when the local `javac` is older than that. `npm run clean:plugins` removes everything the script installed. Cases that need the plugins are skipped until you build them, and the skip reason says so.

## Web UI

`npm run ui` serves on `127.0.0.1` only.

- **Sidebar:** every case, with one cell per version. Each cell has one square per scan step, plus the number of issues printed. A square is filled amber for a non-zero exit code and outlined amber when the step printed errors. A purple outline means the versions behaved differently.
- **Exit codes on Windows:** `bal.bat` exits 0 even when the command fails (for example `bal scan missing.bal` or a failed `bal build`). The exit codes are still recorded, but use the printed errors to tell whether a step failed.
- **Overview:** stats for the run and an exit-code and issue-count table across versions.
- **Case view:** the description and upstream links. For each step it shows the command, exit code, duration and the facts read from the output, with links to the reports and the HTML report. It also lists the files that changed (the `target/cache|bin|build` noise is folded away) and has tabs for the combined output, stdout and stderr. **Compare with** shows two versions next to each other and marks steps whose exit code or issue count differs.
- **New run:** starts `run.mjs` or the plugin build from the browser and shows its log as it runs.

## Coverage notes

- The single-file cases cover file arguments, the invalid-argument paths, ignored report flags, formats, `--list-rules`, rule filters, help, compilation errors, `Scan.toml` next to a file, `--platforms`, suppressions, and a `core-rules` case: one compiling file (`core_rules.bal`) that triggers every core rule from `ballerina:1` to `ballerina:14`.
- The package cases cover basic scans by path, an empty package, a file inside a package, `--target-dir`, `--scan-report`, formats, `--list-rules`, rule filters on the CLI and in `Scan.toml`, `configPath` (relative, external, missing, remote and invalid URL), custom and invalid analyzers, invalid `Scan.toml` entries, standard library analyzers (http, file, os, crypto), compilation errors, a missing `Dependencies.toml`, the recorder platform, invalid platforms, SonarQube, and 18 suppression cases (`sup-*`).
- The workspace cases cover basic scans, SARIF and reports, rules, scanning one package or one file, empty and broken packages, the upstream `workspace-project`, platforms per package, suppression requirements, suppressions, `Scan.toml` per package and at the workspace root, SonarQube, and a missing `Dependencies.toml`.
- Not covered: `ScanLanguageServerTool`, the editor/language-server entry point that applies global exclusions. It has no CLI to drive.
