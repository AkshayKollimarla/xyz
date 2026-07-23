FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source
COPY src ./src

# Non-root user for defense-in-depth
RUN addgroup -S forwarder && adduser -S forwarder -G forwarder \
    && mkdir -p /app/data /app/logs \
    && chown -R forwarder:forwarder /app

USER forwarder

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
