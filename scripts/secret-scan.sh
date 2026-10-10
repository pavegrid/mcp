#!/usr/bin/env bash
set -euo pipefail
scan_tool_directory="${RUNNER_TEMP:?}/pavegrid-secret-scan"
mkdir -p "$scan_tool_directory"
gh release download v8.30.1 --repo gitleaks/gitleaks \
  --pattern gitleaks_8.30.1_linux_x64.tar.gz --dir "$scan_tool_directory"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' \
  "$scan_tool_directory/gitleaks_8.30.1_linux_x64.tar.gz" | sha256sum --check --strict
tar -xzf "$scan_tool_directory/gitleaks_8.30.1_linux_x64.tar.gz" -C "$scan_tool_directory"
"$scan_tool_directory/gitleaks" detect --source . --redact
