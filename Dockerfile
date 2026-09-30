# Coding-agent broker — single global instance. Talks to Matrix, the k8s API
# or the host docker daemon (to provision/tear down per-room pods/containers)
# and each room's opencode server over HTTP. It never clones a repo or runs
# git/gh itself — that's runner/'s job, inside the untrusted per-room pod —
# so this image stays minimal.
FROM node:22-bookworm-slim

# Compose mode (WORKSPACE_BACKEND=compose) drives docker through its CLI —
# pinned static binary, checksum-verified (the CLI only; no engine). The
# daemon it talks to lives on the host (mounted socket), rootless setups included.
ARG TARGETARCH
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) urlarch=x86_64; sum=d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70 ;; \
    arm64) urlarch=aarch64; sum=667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*; \
  curl -fsSL "https://download.docker.com/linux/static/stable/${urlarch}/docker-29.8.1.tgz" -o /tmp/docker.tgz; \
  echo "${sum}  /tmp/docker.tgz" | sha256sum -c -; \
  tar -xz -C /tmp -f /tmp/docker.tgz docker/docker; \
  mv /tmp/docker/docker /usr/local/bin/docker; \
  rm -rf /tmp/docker.tgz /tmp/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# deploy/ rides along for the compose one-shot bootstrap container (same image).
COPY deploy ./deploy

# Persistent state (SQLite registry, Matrix sync token) lives under /data.
# Running with cwd=/data means the broker's relative paths land on the volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /data
ENTRYPOINT ["node", "/app/src/broker.ts"]
