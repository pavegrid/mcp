#!/usr/bin/env bash
set -euo pipefail
# This runs only in the disposable CI D-Bus session. This password is for the
# temporary test keyring, not an AI access token.
printf '%s' 'temporary-ci-keyring' | gnome-keyring-daemon --unlock --components=secrets
npm run test:store
npm run test:pack
