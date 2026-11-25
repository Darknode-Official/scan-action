#!/usr/bin/env node
// Copyright (c) 2026 Darknode-Official. All rights reserved. See LICENSE.
// Scan step of action.yml. Runs main() from the pinned, checksum-verified scanner
// CLI (public/js/codescan/cli.mjs in darknode-web) on the runner, then:
//   - picks the diff base for the event and fetches it if the checkout is shallow;
//   - writes the step outputs (new findings by severity, result, SARIF path);
//   - makes SARIF paths relative to the repository root when `path` is a subfolder;
//   - writes the job summary.
// Exits 0 whether the gate passed or failed (the Gate step in action.yml fails the
// job after the SARIF upload), and 2 on a usage or runtime error.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const SEVS = ["critical", "high", "medium", "low"];
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const LEVELS = ["critical", "high", "medium", "low", "none"];
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const say = (s) => process.stdout.write(s + "\n");
const mdEsc = (s) => String(s ?? "").replace(/[|\\`*_<>[\]]/g, (c) => "\\" + c).replace(/\r?\n/g, " ");
const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

function bool(name, input, def) {
  const v = String(env[name] ?? "").trim().toLowerCase();
  if (!v) return def;
  if (v === "true" || v === "false") return v === "true";
  throw new Error(`Input ${input} must be true or false, not "${env[name]}".`);
}

function git(dir, args, timeout = 120000) {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim(); }
  catch (_) { return null; }
}

// Which commit the changes are compared with, and why there is none when there isn't.
function pickBase(dir, diff) {
  if (!diff) return { base: "", label: "", why: "Diff is off (diff: false), so every finding at or above the level counts." };
  const ev = env.GITHUB_EVENT_NAME || "";
  const from = { pull_request: ["DN_PR_BASE", "pull request base"], pull_request_target: ["DN_PR_BASE", "pull request base"], merge_group: ["DN_MQ_BASE", "merge queue base"], push: ["DN_PUSH_BEFORE", "previous commit"] }[ev];
  if (!from) return { base: "", label: "", why: `A ${ev || "manual"} run has no base commit to compare with, so every finding at or above the level counts.` };
  const base = String(env[from[0]] || "").trim();
  if (!base || /^0+$/.test(base)) return { base: "", label: "", why: "This push created the branch, so there is no previous commit to compare with; every finding at or above the level counts." };
  if (!COMMIT.test(base)) return { base: "", label: "", why: "The event's base commit is not a commit SHA, so every finding at or above the level counts." };
  // actions/checkout fetches one commit by default; fetch the base so the diff works.
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true" && git(dir, ["cat-file", "-e", base + "^{commit}"]) === null) {
    const shallow = git(dir, ["rev-parse", "--is-shallow-repository"]) === "true";
    say(`Fetching the ${from[1]} ${base.slice(0, 12)} for the diff.`);
    if (git(dir, ["fetch", "--no-tags", "--quiet", ...(shallow ? ["--depth=1"] : []), "origin", base]) === null) say("Could not fetch it; the scanner will fall back to a full scan.");
  }
  return { base, label: from[1], why: "" };
}

// Path of the scanned folder inside the repository ("" at the root), used to make
// SARIF locations and summary links relative to the repository root.
function repoPrefix(dir, ws) {
  const p = git(dir, ["rev-parse", "--show-prefix"]);
  if (p !== null) return p.replace(/\\/g, "/").replace(/^\/+/, "");
  const rel = relative(ws, dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
  return rel.split(sep).join("/") + "/";
}

function prefixSarif(file, prefix) {
  const enc = prefix.split("/").filter(Boolean).map(encodeURIComponent).join("/") + "/";
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const fix = (loc) => { const a = loc && loc.physicalLocation && loc.physicalLocation.artifactLocation; if (a && typeof a.uri === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(a.uri)) a.uri = enc + a.uri; };
  for (const run of doc.runs || []) for (const res of run.results || []) {
    for (const l of res.locations || []) fix(l);
    for (const cf of res.codeFlows || []) for (const tf of cf.threadFlows || []) for (const s of tf.locations || []) fix(s.location);
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
}

function output(values) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, " ")}\n`).join(""));
}

function summary(s) {
  const { r, failOn, mode, base, label, why, prefix, counts, review, gating, upload, uploadWhy, includeReview, scannerSha, path } = s;
  const repo = env.GITHUB_REPOSITORY || "", sha = env.GITHUB_SHA || "";
  const link = (f) => {
    const p = prefix + f.path;
    const text = mdEsc(p) + ":" + f.line;
    return repo && sha ? `[${text}](https://github.com/${repo}/blob/${sha}/${p.split("/").map(encodeURIComponent).join("/")}#L${f.line})` : text;
  };
  const newWord = mode === "diff" ? "new " : "";
  const L = [];
  L.push(`## Darknode code scan: ${gating ? "failed" : "passed"}`, "");
  if (failOn === "none") L.push("Gate off (`fail-on: none`): findings are reported but never fail the check.");
  else if (gating) L.push(`**${plural(gating, newWord + "finding")} at ${failOn} or above.** This check fails until each one is fixed, or reviewed and silenced (see below).`);
  else L.push(`No ${newWord}findings at ${failOn} or above.`);
  L.push("");
  if (mode === "diff") L.push(`Compared with the ${label} \`${base.slice(0, 12)}\`: ${plural(r.changed, "changed file")} in scope under \`${mdEsc(path)}\`.`);
  else L.push(`Full scan of \`${mdEsc(path)}\`: ${plural(r.scanned, "file")}.` + (why ? " " + mdEsc(why) : ""));
  if (r.note) L.push("", "> " + mdEsc(r.note) + " Every finding at or above the level counts.");
  if (r.depNote) L.push("", "> " + mdEsc(r.depNote));
  L.push("", "| | Critical | High | Medium | Low | Needs review |", "|---|---|---|---|---|---|");
  L.push(`| ${mode === "diff" ? "New" : "Findings"} | ${SEVS.map((k) => counts[k]).join(" | ")} | ${review} |`);
  if (mode === "diff") {
    const fx = r.fixed || [];
    L.push(`| Fixed | ${SEVS.map((k) => fx.filter((f) => f.sev === k && f.confidence !== "review").length).join(" | ")} | ${fx.filter((f) => f.confidence === "review").length} |`);
  }
  const list = (r.added || []).filter((f) => f.confidence !== "review" && RANK[f.sev] !== undefined);
  if (list.length) {
    L.push("", mode === "diff" ? "### New findings" : "### Findings", "", "| Severity | Finding | Location | Rule |", "|---|---|---|---|");
    for (const f of list.slice(0, 50)) {
      const title = f.kind === "dep" ? `${f.pkg} ${f.version}: ${f.title}` : f.title;
      L.push(`| ${f.sev} | ${mdEsc(title)}${f.secret ? " (" + mdEsc(f.secret) + ")" : ""} | ${link(f)} | ${mdEsc(f.ruleId)} |`);
    }
    if (list.length > 50) L.push("", `${list.length - 50} more in the SARIF file.`);
  }
  if (review) L.push("", `${plural(review, newWord + "needs-review item")}: a risky call with no traced untrusted input. ${review === 1 ? "It does" : "They do"} not fail the check${includeReview ? "" : " and stay out of code scanning unless `include-review` is true"}.`);
  if (list.length || review) L.push("", "<details><summary>Reviewed a false positive?</summary>", "",
    "Add `darknode-ignore` and a short reason in a comment on the flagged line, or `darknode-ignore-next-line` on the line above it. To skip whole paths (fixtures, vendored code), list them in `.darknodeignore` at the root of the scanned folder. The marker shows up in the pull request diff, so the exception is reviewed like any other change.", "", "</details>");
  L.push("", `Scanner: Darknode-Official/darknode-web@\`${scannerSha.slice(0, 12)}\`, every file SHA-256 verified. Your code stayed on this runner. Code scanning upload: ${upload ? "on" : uploadWhy}.`);
  return L.join("\n") + "\n";
}

async function run() {
  const failOn = String(env.DN_FAIL_ON || "high").trim().toLowerCase();
  if (!LEVELS.includes(failOn)) throw new Error(`Input fail-on must be one of ${LEVELS.join(", ")}, not "${env.DN_FAIL_ON}".`);
  const sarif = bool("DN_SARIF", "sarif", true);
  const includeReview = bool("DN_INCLUDE_REVIEW", "include-review", false);
  const diff = bool("DN_DIFF", "diff", true);
  const deps = bool("DN_DEPS", "deps", true);
  const path = String(env.DN_PATH || ".").trim() || ".";
  const scannerDir = env.DARKNODE_SCANNER_DIR || "";
  const scannerSha = env.DARKNODE_SCANNER_SHA || "";
  if (!scannerDir || !existsSync(join(scannerDir, "codescan", "cli.mjs"))) throw new Error("The verified scanner is missing; the download step did not finish.");
  const ws = env.GITHUB_WORKSPACE || process.cwd();
  const dir = resolve(ws, path);
  if (!existsSync(dir)) throw new Error(`Input path "${path}" does not exist in the workspace. Check out the repository first (actions/checkout).`);

  const { base, label, why } = pickBase(dir, diff);
  say(base ? `Diff base: ${base} (${label}).` : "Full scan: " + why);

  const sarifFile = join(scannerDir, "results.sarif");
  const argv = [dir, "--fail-on", failOn, "--sarif", sarifFile];
  if (sarif) argv.push("--full-sarif");
  if (includeReview) argv.push("--sarif-include-review");
  if (deps) argv.push("--deps");
  if (base) argv.push("--diff-base", base);

  const { main } = await import(pathToFileURL(join(scannerDir, "codescan", "cli.mjs")).href);
  const r = await main(argv, { env: { ...env, GITHUB_STEP_SUMMARY: "" }, cwd: ws, log: say });
  if (!r || r.code === 2 || !Array.isArray(r.added)) throw new Error("The scanner stopped with an error (see the log above).");

  const prefix = repoPrefix(dir, ws);
  const hasSarif = existsSync(sarifFile);
  if (hasSarif && prefix) prefixSarif(sarifFile, prefix);

  const added = r.added.filter((f) => RANK[f.sev] !== undefined);
  const confirmed = added.filter((f) => f.confidence !== "review");
  const counts = Object.fromEntries(SEVS.map((k) => [k, confirmed.filter((f) => f.sev === k).length]));
  const review = added.length - confirmed.length;
  const gating = failOn === "none" ? 0 : confirmed.filter((f) => RANK[f.sev] <= RANK[failOn]).length;
  if ((gating > 0) !== (r.code === 1)) throw new Error(`Gate mismatch: the scanner exited ${r.code} with ${gating} gating finding(s).`);

  let upload = sarif && hasSarif, uploadWhy = sarif ? "skipped, no SARIF was written" : "off (`sarif: false`)";
  if (upload && env.GITHUB_EVENT_NAME === "pull_request" && env.DN_HEAD_REPO && env.DN_HEAD_REPO !== env.GITHUB_REPOSITORY) {
    upload = false;
    uploadWhy = "skipped, pull requests from forks get a read-only token (the gate still applies)";
  }
  const mode = r.mode === "diff" ? "diff" : "full";
  output({
    critical: counts.critical, high: counts.high, medium: counts.medium, low: counts.low, "needs-review": review,
    gating, result: gating ? "failed" : "passed", mode, "sarif-file": hasSarif ? sarifFile : "",
    upload, category: prefix ? "darknode/" + prefix.replace(/\/+$/, "") : "darknode",
  });
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary({ r, failOn, mode, base, label, why, prefix, counts, review, gating, upload, uploadWhy, includeReview, scannerSha, path }));
  }
  return 0;
}

run().then((code) => process.exit(code), (e) => {
  const msg = String((e && e.message) || e);
  say("::error title=Darknode scan::" + msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"));
  if (env.GITHUB_STEP_SUMMARY) { try { appendFileSync(env.GITHUB_STEP_SUMMARY, "## Darknode code scan: error\n\n" + mdEsc(msg) + "\n"); } catch (_) {} }
  process.exit(2);
});
