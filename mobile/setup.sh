#!/usr/bin/env bash
# Same as setup.bat, for a Mac or Linux machine.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS build from https://nodejs.org"; exit 1; }
echo "Node $(node -v) found."
npm install --no-audit --no-fund
npx cap sync android
echo
echo "Done. Open the 'android' folder in Android Studio, let Gradle sync, then press Run."
