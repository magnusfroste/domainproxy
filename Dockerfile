# Multi-stage build for production
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build || true  # No build step needed

# Production stage
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app /app

# Create data dir
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

VOLUME ["/app/data"]

CMD ["npm", "start"]