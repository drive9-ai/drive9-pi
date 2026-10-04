#!/usr/bin/env bash
#
# DEV/CI-ONLY temporary bridge — NOT part of the published dependency contract.
#
# The published `drive9` npm package pinned in package.json (0.1.4) predates the
# LayerFS fork/delete client APIs that landed in mem9-ai/drive9#1014. Until a
# `drive9` version containing #1014 is published to the registry, code paths that
# call `client.forkFSLayer` / `client.deleteFSLayer` (the real
# Drive9LayerWorkspaceBackend, the live recovery E2E) cannot run against a plain
# SDK `Client`.
#
# This script builds the `drive9` JS SDK from a PINNED exact commit of
# mem9-ai/drive9 and installs the resulting tarball with `npm install --no-save`,
# so it overlays node_modules for local/E2E runs WITHOUT modifying the public
# package.json dependency contract. It is a temporary dev-phase bridge.
#
# RELEASE GATE: before publishing drive9-pi, publish a `drive9` version with
# #1014 and switch the package.json dependency back to a semver range
# (e.g. ^0.2.0). This bridge must NOT reach the published package.
#
# Usage:
#   scripts/install-pinned-drive9-sdk.sh
# Env overrides:
#   DRIVE9_SDK_REPO   git URL of mem9-ai/drive9       (default: github.com/mem9-ai/drive9)
#   DRIVE9_SDK_COMMIT exact commit SHA to build from  (default: the #1014 merge)

set -euo pipefail

# Default to the #1014 merge commit (exposes forkFSLayer/deleteFSLayer).
DRIVE9_SDK_COMMIT="${DRIVE9_SDK_COMMIT:-3d216f186497823c45d1d3c93dc842dc5f6dd53f}"
DRIVE9_SDK_REPO="${DRIVE9_SDK_REPO:-https://github.com/mem9-ai/drive9.git}"

# Refuse a non-pinned ref: a floating branch must never back this bridge.
if [[ ! "$DRIVE9_SDK_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: DRIVE9_SDK_COMMIT must be a full 40-char commit SHA (no branches/tags): '$DRIVE9_SDK_COMMIT'" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

echo "[pinned-sdk] cloning $DRIVE9_SDK_REPO @ $DRIVE9_SDK_COMMIT"
git -C "$work_dir" init -q
git -C "$work_dir" remote add origin "$DRIVE9_SDK_REPO"
git -C "$work_dir" fetch -q --depth 1 origin "$DRIVE9_SDK_COMMIT"
git -C "$work_dir" checkout -q FETCH_HEAD

sdk_dir="$work_dir/clients/drive9-js"
if [[ ! -d "$sdk_dir" ]]; then
  echo "error: clients/drive9-js not found at commit $DRIVE9_SDK_COMMIT" >&2
  exit 1
fi

echo "[pinned-sdk] building + packing drive9-js"
# drive9-js (a monorepo sub-package) ships no lockfile, so `npm ci` is not usable
# here; `npm install` is the supported install for this package.
( cd "$sdk_dir" && npm install --silent && npm run build --silent )
tarball="$(cd "$sdk_dir" && npm pack --silent | tail -n1)"
tarball_path="$sdk_dir/$tarball"

echo "[pinned-sdk] installing $tarball into drive9-pi with --no-save (package.json unchanged)"
( cd "$repo_root" && npm install --no-save "$tarball_path" )

# Verify the overlaid SDK actually exposes the #1014 APIs (artifact-level, not source).
node -e '
  const path = require("path");
  const sdk = require(path.join(process.cwd(), "node_modules/drive9"));
  const c = new sdk.Client("http://127.0.0.1:0", "x");
  for (const m of ["forkFSLayer", "deleteFSLayer"]) {
    if (typeof c[m] !== "function") { console.error(`error: overlaid drive9 missing ${m}`); process.exit(1); }
  }
  console.log("[pinned-sdk] verified: overlaid drive9 exposes forkFSLayer + deleteFSLayer");
'

echo "[pinned-sdk] done — temporary dev-phase overlay in place; revert to semver before publishing drive9-pi"
