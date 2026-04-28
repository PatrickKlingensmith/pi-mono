FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# Base system utilities
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
    # Network tools
    iputils-ping \
    dnsutils \
    # JSON / search / shell tools
    jq \
    fzf \
    bat \
    fd-find \
    ripgrep \
    # Archives
    zip \
    unzip \
    tar \
    # Media (optional — heavy, remove if not needed)
    ffmpeg \
    imagemagick \
    # HTTP CLI tools
    httpie \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 LTS (more stable than 24 for tooling)
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

RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /workspace
CMD ["pi"]
