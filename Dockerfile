# Use Node 20 for stable native builds and modern framework compatibility
FROM node:20-slim AS builder

# Install build dependencies for native modules (vosk/ffi-napi)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY server/package*.json ./server/
COPY restaurant-bot-web/package*.json ./restaurant-bot-web/

# Install dependencies (using npm install instead of ci to be more resilient with native builds)
RUN npm install

# Copy source code
COPY . .

# Build the frontend
RUN npm run build --workspace=restaurant-bot-web

# Production Image
FROM node:20-slim

# Install runtime dependencies (like ffmpeg which is used in server/index.js)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy nodes_modules and built assets from builder
COPY --from=builder /app /app

EXPOSE 3000

# Start the server (which also serves the frontend dist)
CMD ["npm", "start", "--workspace=server"]
