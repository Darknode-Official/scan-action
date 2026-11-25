#!/usr/bin/env node
// Copyright (c) 2026 Darknode-Official. All rights reserved. See LICENSE.
// Re-pin the Darknode Code Scanner that action.yml downloads.
//
//   node scripts/pin.mjs <darknode-web commit SHA, branch or tag>
//
// 1. Resolves the ref to a full commit SHA and refuses commits that are not on
//    darknode-web's main branch (raw.githubusercontent.com also serves commits
//    from forks, so an unchecked SHA could point at someone else's code).
// 2. Reads the scanner's file list (SCANNER_FILES) from public/js/codescan/ci.js at
//    that commit, the same list the website's generated workflow pins.
// 3. Downloads every file from raw.githubusercontent.com (the URL the Action
//    uses), computes its SHA-256 and rewrites the pin block in action.yml.
// Each Action release re-pins this way. Needs Node 20 or newer; no dependencies.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Darknode-Official/darknode-web";
const DIR = "public/js";
const ACTION = join(dirname(fileURLToPath(import.meta.url)), "..", "action.yml");
const SHA1 = /^[0-9a-f]{40}$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_.-]*)*\.m?js$/i;
const BEGIN = "# pin:begin", END = "# pin:end";
const API = { headers: { Accept: "application/vnd.github+json", "User-Agent": "scan-action-pin" } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, opts) {
  for (let i = 0; ; i++) {
    let r = null, err = null;
    try { r = await fetch(url, opts); } catch (e) { err = e; }
    if (r && r.ok) return r;
    const retry = !r || r.status >= 500 || r.status === 429;
    if (retry && i < 3) { await sleep(2000 * (i + 1)); continue; }
    throw new Error(url + ": " + (r ? "HTTP " + r.status : (err && err.message) || "network error"));
  }
}

async function resolveSha(ref) {
  const r = await get(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, API);
  const sha = String((await r.json()).sha || "").toLowerCase();
  if (!SHA1.test(sha)) throw new Error("GitHub returned no commit SHA for " + ref);
  if (SHA1.test(ref.toLowerCase()) && sha !== ref.toLowerCase()) throw new Error(ref + " resolved to a different commit " + sha);
  const c = await (await get(`https://api.github.com/repos/${REPO}/compare/${sha}...main`, API)).json();
  if (c.status !== "ahead" && c.status !== "identical") throw new Error(`${sha} is not on ${REPO} main (compare status: ${c.status}).`);
  return sha;
}

const raw = (sha, file) => `https://raw.githubusercontent.com/${REPO}/${sha}/${DIR}/${file}`;

async function scannerFiles(sha) {
  const ci = await (await get(raw(sha, "codescan/ci.js"))).text();
  const dir = /export const SCANNER_DIR\s*=\s*"([^"]*)"/.exec(ci);
  if (!dir || dir[1] !== DIR) throw new Error("SCANNER_DIR in ci.js is no longer " + DIR + "; update pin.mjs and action.yml together.");
  const list = /export const SCANNER_FILES\s*=\s*(\[[^\]]*\])/.exec(ci);
  if (!list) throw new Error("Could not find SCANNER_FILES in ci.js at " + sha);
  const files = JSON.parse(list[1]);
  if (!Array.isArray(files) || !files.length) throw new Error("SCANNER_FILES is empty at " + sha);
  for (const f of files) if (typeof f !== "string" || !SAFE_FILE.test(f) || f.split("/").includes("..")) throw new Error("Unexpected scanner file name: " + JSON.stringify(f));
  if (!files.includes("codescan/cli.mjs")) throw new Error("SCANNER_FILES has no codescan/cli.mjs, which scripts/run.mjs imports.");
  return files;
}

async function main(argv) {
  const ref = String(argv[0] || "").trim();
  if (!ref || argv.length > 1 || ref.startsWith("-")) {
    process.stdout.write("Usage: node scripts/pin.mjs <darknode-web commit SHA, branch or tag>\n");
    return 2;
  }
  const sha = await resolveSha(ref);
  const files = await scannerFiles(sha);
  const sums = [];
  for (const f of files) {
    const bytes = Buffer.from(await (await get(raw(sha, f))).arrayBuffer());
    const hex = createHash("sha256").update(bytes).digest("hex");
    sums.push(hex + "  " + f);
    process.stdout.write(`${hex}  ${f} (${bytes.length} bytes)\n`);
  }

  const yml = readFileSync(ACTION, "utf8");
  const a = yml.indexOf(BEGIN), b = yml.indexOf(END);
  if (a < 0 || b < a || yml.indexOf(BEGIN, a + 1) >= 0) throw new Error("action.yml needs exactly one " + BEGIN + " ... " + END + " block.");
  const lineStart = yml.lastIndexOf("\n", a) + 1;
  const pad = yml.slice(lineStart, a);
  if (!/^ *$/.test(pad)) throw new Error(BEGIN + " must sit on its own line.");
  const block = [
    BEGIN + " (written by scripts/pin.mjs; do not edit by hand)",
    "DARKNODE_SCANNER_SHA: " + sha,
    "DARKNODE_SCANNER_SUMS: |",
    ...sums.map((s) => "  " + s),
    END,
  ].map((l, i) => (i ? pad : "") + l).join("\n");
  const out = yml.slice(0, a) + block + yml.slice(b + END.length);
  if (out !== yml) writeFileSync(ACTION, out);
  process.stdout.write(`${out === yml ? "Already pinned to" : "Pinned action.yml to"} ${REPO}@${sha} (${files.length} files).\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  process.stdout.write("pin: " + ((e && e.message) || e) + "\n");
  process.exit(1);
});
