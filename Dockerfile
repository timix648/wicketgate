# Wicketgate watcher. Observe mode needs no key:
#   docker build -t wicketgate-watcher .
#   docker run --rm wicketgate-watcher --mode observe --rollup wicketgate-pay --once
# The feed is written to /feed inside the container; mount it to keep it: -v $PWD/feed:/feed
FROM node:22-bookworm-slim
WORKDIR /app
RUN npm i -g pnpm@9.15.9
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/watcher/package.json packages/watcher/
RUN pnpm install --frozen-lockfile --filter @wicketgate/watcher... --ignore-scripts
COPY packages/core packages/core
COPY packages/watcher packages/watcher
COPY deployments deployments
WORKDIR /app/packages/watcher
ENTRYPOINT ["npx", "tsx", "src/cli.ts", "--feed", "/feed"]
CMD ["--mode", "observe", "--rollup", "wicketgate-pay"]
