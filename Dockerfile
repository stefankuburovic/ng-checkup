# ng-checkup as a container, for Jenkins, TeamCity and networks without npm:
#   docker run --rm -v "$PWD:/work" ghcr.io/stefankuburovic/ng-checkup:2 --offline
#
# Built from this repository's source, so an image never waits for npm to
# serve the release. The typings of the newest release of the last three
# Angular majors are downloaded at build time, so --offline finds them for a
# project on one of those exact versions without node_modules; any other
# version is read from node_modules, or downloaded when the run is online.

FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json README.md LICENSE ./
COPY src src
COPY schematics schematics
RUN npm ci --ignore-scripts && npx tsc -p tsconfig.build.json && npm pack --ignore-scripts

FROM node:22-slim
# git for hotspots, --since and history; trusted for any owner, since the mounted folder belongs to the host's user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
COPY --from=build /src/ng-checkup-cli-*.tgz /tmp/
RUN npm install -g --ignore-scripts /tmp/ng-checkup-cli-*.tgz && rm /tmp/ng-checkup-cli-*.tgz && npm cache clean --force
ENV NG_CHECKUP_CACHE=/opt/ng-checkup/cache
COPY docker/prefetch-typings.mjs /opt/ng-checkup/prefetch-typings.mjs
# Writable by any user: CI runs the container under its own uid, and an online run adds what it downloads.
RUN node /opt/ng-checkup/prefetch-typings.mjs && chmod -R a+rwX /opt/ng-checkup
WORKDIR /work
ENTRYPOINT ["ng-checkup"]
