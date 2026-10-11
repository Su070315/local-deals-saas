FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/miniprogram-customer/package.json apps/miniprogram-customer/package.json
COPY apps/miniprogram-verifier/package.json apps/miniprogram-verifier/package.json
COPY packages/api-contract/package.json packages/api-contract/package.json
RUN npm ci

COPY apps/api apps/api
RUN npm run build -w @local-deals/api
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=staging

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist

USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
