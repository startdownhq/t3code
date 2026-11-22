#!/usr/bin/env bash
# Builds a linux-x64 T3 runtime archive of startdownhq/t3code main, the way upstream CI does:
# Ubuntu 24.04 container + the official Node binary (a distro Node links system libraries).
# Run on jiv-server (has Docker): ssh jiblars@192.168.193.182 'bash -s -- <version>' < this file
# Output: ~/src/t3code-startdown-ci/release-cli/t3-<version>-linux-x64.tar.gz
set -euo pipefail
V="$1"
SRC=~/src/t3code-startdown-ci
if [ -d "$SRC/.git" ]; then sudo -n chown -R "$(id -u):$(id -g)" "$SRC"; cd "$SRC" && git fetch -q origin && git reset -q --hard origin/main && git clean -qfdx; else git clone -q --filter=blob:none https://github.com/startdownhq/t3code.git "$SRC"; fi
cd "$SRC"; echo "commit $(git rev-parse --short HEAD)"
mkdir -p "$SRC/.rm" && # Reuse the installed runtime's resource monitor (a separate Rust binary; no cargo needed).
cp -a "$(ls -d ~/.t3/runtime/versions/*/resource-monitor | head -1)/." "$SRC/.rm/"
cat > "$SRC/.ci-build.sh" <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq git patchelf python3 make g++ xz-utils curl ca-certificates libatomic1 >/dev/null
curl -fsSL https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz | tar -xJ -C /opt
export PATH=/opt/node-v26.13.1-linux-x64/bin:$PATH
node -v
cd /src && git config --global --add safe.directory /src
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
npx -y pnpm@12.14.0 install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
export PATH=$PWD/node_modules/.bin:$PATH
node scripts/update-release-package-versions.ts "$V" >/dev/null
echo "== bundle"; vp run --filter t3 build >/tmp/bundle.log 2>&1 || { tail -30 /tmp/bundle.log; exit 1; }
echo "== exe"; node apps/server/scripts/cli.ts build-exe >/tmp/exe.log 2>&1 || { tail -30 /tmp/exe.log; exit 1; }
echo "== archive"; rm -rf release-cli; node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$V" --resource-monitor-dir /src/.rm --output-dir release-cli >/tmp/archive.log 2>&1 || { tail -30 /tmp/archive.log; exit 1; }
ls -la release-cli
echo "== smoke"; node scripts/smoke-cli-archive.ts --archive release-cli/* --expect-version "$V" 2>&1 | tail -6
INNER
docker run --rm -e V="$V" -v "$SRC":/src ubuntu:24.04 bash /src/.ci-build.sh
sudo -n chown -R "$(id -u):$(id -g)" "$SRC"
