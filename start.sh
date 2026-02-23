#!/bin/bash
echo "Starting deployment script..."

# Install dependencies for both workspaces
npm install

# Build the frontend
echo "Building frontend..."
npm run build --workspace=restaurant-bot-web

# Start the server
echo "Starting backend server..."
npm start --workspace=server
