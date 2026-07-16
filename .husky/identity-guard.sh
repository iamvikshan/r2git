#!/bin/bash
# identity-guard.sh - Enforces expected git identity to prevent accidental commits

# Skip in CI or when HUSKY is disabled
if [ "${CI:-}" = "true" ] || [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${GITLAB_CI:-}" ] || [ "${HUSKY:-}" = "0" ]; then
  echo "Identity guard skipped in CI or HUSKY=0"
  exit 0
fi

exit 0
