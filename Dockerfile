FROM node:24.22.1-slim AS dependencies
WORKDIR /app
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/office/package.json apps/office/package.json
COPY apps/driver/package.json apps/driver/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages

FROM dependencies AS api
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@traslado/api", "start"]

FROM dependencies AS office-build
ENV VITE_API_URL=/api
RUN pnpm --filter @traslado/office build

FROM dependencies AS driver-build
ENV VITE_API_URL=/api
RUN pnpm --filter @traslado/driver build

FROM caddy:2-alpine AS office
COPY deploy/Pwa.Caddyfile /etc/caddy/Caddyfile
COPY --from=office-build /app/apps/office/dist /srv

FROM caddy:2-alpine AS driver
COPY deploy/Pwa.Caddyfile /etc/caddy/Caddyfile
COPY --from=driver-build /app/apps/driver/dist /srv
