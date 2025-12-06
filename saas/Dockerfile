# Multi-stage for CMS
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production && \
    apk del python3 make g++

COPY . .

# Production
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies with native modules
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production && \
    apk del python3 make g++

# Copy application code (excluding node_modules)
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3001

CMD ["npm", "start"]