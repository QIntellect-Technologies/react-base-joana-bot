# Single-stage build for modern Node environment
FROM node:22-slim

# Install runtime dependencies (ffmpeg)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root configurations
COPY package.json package-lock.json* ./
COPY restaurant-bot-web/package.json ./restaurant-bot-web/
COPY server/package.json ./server/

# Install all dependencies (workspaces handle hoisting)
RUN npm install

# Copy source code
COPY . .

# Build frontend
RUN npm run build --workspace=restaurant-bot-web

# Expose port (Railway overrides this with PORT variable)
EXPOSE 3000

# Start application
CMD ["npm", "start", "--workspace=server"]
