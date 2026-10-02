# syntax=docker/dockerfile:1.7
#
# Compiles PlayPort (web client + JVM server) in containers and exports the artifacts back to the
# host, where the server runs natively on macOS (it needs Bluetooth, mDNS and the LAN directly).
#
#   docker build --target artifacts --output type=local,dest=. .
#
# or simply: scripts/docker-build.sh
#
# The macOS bt-bridge helper links IOBluetooth and cannot be built in a Linux container; build it on
# the host with macos/bt-bridge/build.sh.

# ---- web client -------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm test && npm run build

# ---- JVM server -------------------------------------------------------------------------------
# gradle/gradle-daemon-jvm.properties pins the Gradle daemon to JDK 25; the code targets Java 21.
FROM eclipse-temurin:25-jdk AS server
WORKDIR /src
ENV GRADLE_USER_HOME=/gradle-home
COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle/ gradle/
RUN --mount=type=cache,target=/gradle-home ./gradlew --no-daemon --version
COPY protocol/ protocol/
COPY server/ server/
# identity/ is deliberately not copied (secret); MfiIdentityTest skips itself without it.
RUN --mount=type=cache,target=/gradle-home ./gradlew --no-daemon build :server:installDist

# ---- exported artifacts (paths relative to the repository root) -------------------------------
FROM scratch AS artifacts
COPY --from=web /src/web/dist/ /web/dist/
COPY --from=server /src/server/build/install/server/ /server/build/install/server/
