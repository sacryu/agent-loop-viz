# 自己部署的服务器（星系群模式）：单个 Node 进程。前面放一个带 TLS 的反向代理（见 deploy/Caddyfile、deploy/compose.yml）。
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

FROM node:22-alpine
WORKDIR /app
# 服务器打包成一个文件（ws、zod 都打进去了），不需要 node_modules
COPY --from=build /src/server/dist/server.mjs ./server.mjs
COPY --from=build /src/web/dist ./web
# LOCAL=0：按星系群隔离、只收密文。GROUPS（白名单）在 compose 里从 .env 传进来
# TRUST_PROXY=0：直接对外开端口时 X-Forwarded-For 谁都能伪造。前面有反向代理时（deploy/compose.yml 的 caddy）由 compose 设成 1
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 LOCAL=0 TRUST_PROXY=0 STATIC_DIR=/app/web
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4317/healthz >/dev/null || exit 1
CMD ["node", "server.mjs"]
