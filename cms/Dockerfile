# Multi-stage for CMS
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Production
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app /app

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3001

VOLUME ["/app/data"]

CMD ["npm", "start"]