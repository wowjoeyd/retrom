// Builds the thin `retrom-host-agent` and stages it as a Tauri external binary
// (sidecar) so it installs next to the Retrom client. Tauri's `externalBin`
// expects `<name>-<target-triple>[.exe]`; at install the triple is stripped, so
// the agent lands beside the main binary and `resolved_host_agent_cmd()` finds it.
//
// Run automatically via tauri.conf.json `beforeBundleCommand`.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const binariesDir = join(repoRoot, "packages", "client", "binaries");
const exeExt = process.platform === "win32" ? ".exe" : "";

// Resolve the host target triple from rustc.
const rustcVerbose = execSync("rustc -vV", { encoding: "utf8" });
const tripleMatch = rustcVerbose.match(/host:\s*(\S+)/);
if (!tripleMatch) {
  throw new Error(
    "could not determine the host target triple from `rustc -vV`",
  );
}
const triple = tripleMatch[1];

// Build the thin (no `dev` feature) host-agent in release.
execSync("cargo build -p retrom-host-agent --release", {
  cwd: repoRoot,
  stdio: "inherit",
});

const builtBinary = join(
  repoRoot,
  "target",
  "release",
  `retrom-host-agent${exeExt}`,
);
if (!existsSync(builtBinary)) {
  throw new Error(`host-agent binary not found at ${builtBinary}`);
}

mkdirSync(binariesDir, { recursive: true });
const dest = join(binariesDir, `retrom-host-agent-${triple}${exeExt}`);
copyFileSync(builtBinary, dest);

console.log(`staged host-agent external binary -> ${dest}`);
