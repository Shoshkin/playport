#!/bin/sh
# Compiles the web client and JVM server in Docker and writes the artifacts into this checkout:
#   web/dist/                      browser client
#   server/build/install/server/   server distribution (run it from the repository root)
set -e
cd "$(dirname "$0")/.."
rm -rf web/dist server/build/install/server
docker build --target artifacts --output type=local,dest=. "$@" .
echo "built: web/dist and server/build/install/server"
echo "run:   server/build/install/server/bin/server --help"
