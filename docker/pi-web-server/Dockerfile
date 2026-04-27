# =============================================================================
# Stage 1: Build the web UI from monorepo source
# =============================================================================
FROM node:22 AS web-builder

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

# Copy all package sources (npm workspaces requires all members to be present)
COPY tsconfig.json tsconfig.base.json biome.json ./
COPY packages/ai/ ./packages/ai/
COPY packages/agent/ ./packages/agent/
COPY packages/tui/ ./packages/tui/
COPY packages/coding-agent/ ./packages/coding-agent/
COPY packages/mom/ ./packages/mom/
COPY packages/pods/ ./packages/pods/
COPY packages/web-ui/ ./packages/web-ui/

# Build only what the web UI needs: ai → agent → web-ui → example
RUN npm run build -w packages/ai
RUN npm run build -w packages/agent
RUN npm run build -w packages/web-ui
RUN npm run build --prefix packages/web-ui/example

# =============================================================================
# Stage 2: Build the WebSocket server
# =============================================================================
FROM node:22 AS server-builder

WORKDIR /server
COPY docker/pi-web-server/package.json ./
RUN npm install
COPY docker/pi-web-server/tsconfig.json ./
COPY docker/pi-web-server/src/ ./src/
RUN npm run build

# =============================================================================
# Stage 3: Runtime — Ubuntu + all system tools + Node.js
# =============================================================================
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# System utilities (same set as the CLI container so bash tool works fully)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    wget \
    gnupg \
    lsb-release \
    bash \
    git \
    openssh-client \
    less \
    procps \
    python3 \
    python3-pip \
    make \
    g++ \
    build-essential \
    iputils-ping \
    dnsutils \
    jq \
    fzf \
    bat \
    fd-find \
    ripgrep \
    zip \
    unzip \
    tar \
    ffmpeg \
    imagemagick \
    httpie \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && node --version \
    && npm --version \
    && rm -rf /var/lib/apt/lists/*

# Install pi CLI globally so bash commands inside the agent can use it
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /app

# Copy the server and its dependencies
COPY --from=server-builder /server/dist ./dist
COPY --from=server-builder /server/node_modules ./node_modules

# Copy the built web UI (served as static files)
COPY --from=web-builder /app/packages/web-ui/example/dist ./public

WORKDIR /workspace
EXPOSE 3000

CMD ["node", "/app/dist/index.js"]
