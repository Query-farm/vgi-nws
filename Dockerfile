# syntax=docker/dockerfile:1
# One image, both transports:
#   docker run -p 8000:8000 IMAGE         -> HTTP on $PORT (default 8000; GET /health)
#   docker run -i IMAGE stdio             -> stdio worker, for DuckDB on the same host
FROM oven/bun:1.3-slim

ARG VERSION=0.0.0
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="vgi-nws-worker" \
      org.opencontainers.image.description="NWS weather and NWPS river data for DuckDB" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.licenses="0BSD"

ENV NODE_ENV=production PORT=8000
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libeccodes-tools \
    && rm -rf /var/lib/apt/lists/*
COPY test/fixtures/grib/png.grib2 /tmp/nws-png-check.grib2
RUN test "$(grib_get -F %.17g -p bitmapPresent -i 330 /tmp/nws-png-check.grib2 | xargs)" = "0 2.5" \
    && rm /tmp/nws-png-check.grib2

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json README.md LICENSE ./
COPY src ./src
COPY bin ./bin

# Run as an unprivileged user (the base image ships `bun`, uid 1000).
USER bun

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '8000') + '/health'); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["docker-entrypoint.sh"]
