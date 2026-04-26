# Stage 1: Build
FROM node:22 AS builder

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/agent/package.json ./packages/agent/
COPY packages/tui/package.json ./packages/tui/
COPY packages/coding-agent/package.json ./packages/coding-agent/
COPY packages/mom/package.json ./packages/mom/
COPY packages/pods/package.json ./packages/pods/
COPY packages/web-ui/package.json ./packages/web-ui/
COPY packages/web-ui/example/package.json ./packages/web-ui/example/
COPY packages/coding-agent/examples/extensions/with-deps/package.json \
     ./packages/coding-agent/examples/extensions/with-deps/
COPY packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json \
     ./packages/coding-agent/examples/extensions/custom-provider-anthropic/
COPY packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json \
     ./packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/
COPY packages/coding-agent/examples/extensions/custom-provider-qwen-cli/package.json \
     ./packages/coding-agent/examples/extensions/custom-provider-qwen-cli/

RUN npm install

# Copy source
COPY tsconfig.json tsconfig.base.json biome.json ./
COPY packages/ai/ ./packages/ai/
COPY packages/agent/ ./packages/agent/
COPY packages/web-ui/ ./packages/web-ui/

# Build dependency chain: ai → agent → web-ui → example
RUN npm run build -w packages/ai
RUN npm run build -w packages/agent
RUN npm run build -w packages/web-ui
RUN npm run build --prefix packages/web-ui/example

# Stage 2: Serve
FROM nginx:alpine AS serve

COPY --from=builder /app/packages/web-ui/example/dist /usr/share/nginx/html
COPY packages/web-ui/example/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
