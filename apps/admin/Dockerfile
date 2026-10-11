FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/miniprogram-customer/package.json apps/miniprogram-customer/package.json
COPY apps/miniprogram-verifier/package.json apps/miniprogram-verifier/package.json
COPY packages/api-contract/package.json packages/api-contract/package.json
RUN npm ci

COPY apps/admin apps/admin
COPY packages/api-contract packages/api-contract
ARG VITE_WORKSPACE_ROLE=ALL
ARG VITE_RELEASE_ID
ENV VITE_WORKSPACE_ROLE=$VITE_WORKSPACE_ROLE
ENV VITE_RELEASE_ID=$VITE_RELEASE_ID
ENV VITE_REQUIRE_RELEASE_ID=true
RUN npm run build -w @local-deals/admin

FROM nginx:1.27-alpine
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
