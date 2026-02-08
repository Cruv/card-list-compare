# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine

LABEL org.opencontainers.image.source="https://github.com/Cruv/card-list-compare"
LABEL org.opencontainers.image.description="Card List Compare - Compare two MTG deck lists and generate In/Out summaries"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
