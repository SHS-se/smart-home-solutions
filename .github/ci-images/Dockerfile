ARG PLAYWRIGHT_VERSION

FROM node:22.23.4-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f AS dependencies
RUN install -d -o 1001 -g 1001 /opt/shs-ci
WORKDIR /opt/shs-ci
COPY --chown=1001:1001 package.json package-lock.json ./
USER 1001:1001
RUN HOME=/tmp npm ci --include=dev && HOME=/tmp npm cache clean --force

FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno

FROM dependencies AS checks
COPY --from=deno /deno /usr/local/bin/deno
USER root
WORKDIR /

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS browser
COPY --from=dependencies /usr/local/ /usr/local/
COPY --from=dependencies --chown=1001:1001 /opt/shs-ci/node_modules /opt/shs-ci/node_modules
WORKDIR /
