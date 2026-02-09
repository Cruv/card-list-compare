# Build stage: frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Build stage: backend dependencies
FROM node:22-alpine AS backend-build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Production stage
FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/Cruv/card-list-compare"
LABEL org.opencontainers.image.description="Card List Compare - Compare two MTG deck lists and generate In/Out summaries"

RUN apk add --no-cache nginx curl

WORKDIR /app

# Copy nginx config (replace entire main config to avoid nested server blocks)
COPY nginx.conf /etc/nginx/nginx.conf
RUN rm -f /etc/nginx/conf.d/default.conf /etc/nginx/http.d/default.conf

# Copy frontend build
COPY --from=frontend-build /app/dist /usr/share/nginx/html

# Copy backend
COPY --from=backend-build /app/node_modules ./server/node_modules
COPY server/ ./server/

# Copy shared lib files (used by server for parsing/diffing)
COPY src/lib/parser.js src/lib/constants.js src/lib/differ.js src/lib/formatter.js ./src/lib/

# Data directory is mounted as a volume — DO NOT bake data into image
# DB_PATH defaults to /app/data/cardlistcompare.db (outside server/ to keep image clean)
RUN mkdir -p /app/data

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost/api/health || exit 1

CMD ["/docker-entrypoint.sh"]
