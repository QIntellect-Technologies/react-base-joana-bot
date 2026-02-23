# Stage 1: Build the modern frontend (Requires Node 20+)
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package*.json ./
COPY restaurant-bot-web/package*.json ./restaurant-bot-web/
RUN npm install --workspace=restaurant-bot-web
COPY . .
RUN npm run build --workspace=restaurant-bot-web

# Stage 2: Build the backend (Requires Node 16 for ffi-napi/vosk stability)
FROM node:16-slim AS backend-builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
COPY server/package*.json ./server/

# Install server dependencies only
RUN npm install --workspace=server

# Production Image
FROM node:16-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/restaurant-bot-web/dist ./restaurant-bot-web/dist

# Copy installed server modules from Stage 2
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/server/node_modules ./server/node_modules

# Copy source code
COPY . .

EXPOSE 3000

# Start the server
CMD ["node", "server/index.js"]
