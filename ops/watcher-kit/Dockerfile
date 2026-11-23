# Wicketgate watcher for an independent operator: the watcher plus the onboarding scripts.
# Built by ops/watcher-kit/kit.sh from the repository root; see ops/watcher-kit/README.md.
FROM node:22-bookworm-slim
WORKDIR /app
RUN npm i -g pnpm@9.15.9
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/watcher/package.json packages/watcher/
COPY packages/scripts/package.json packages/scripts/
RUN pnpm install --frozen-lockfile --filter @wicketgate/watcher... --filter @wicketgate/scripts... --ignore-scripts
COPY packages/core packages/core
COPY packages/watcher packages/watcher
COPY packages/scripts packages/scripts
COPY deployments deployments
ENV NPM_CONFIG_UPDATE_NOTIFIER=false WICKETGATE_KEYS=/keys/keys.env WICKETGATE_STATE=/state HOME=/state
WORKDIR /app/packages/watcher
