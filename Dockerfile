FROM node:20-alpine
WORKDIR /app/backend

# Install dependencies
COPY backend/package.json .
RUN npm install --omit=dev

# Copy backend source
COPY backend/server.js .

# Copy frontend (will be overridden by the volume mount in compose if present)
COPY frontend/ /app/frontend/

EXPOSE 3000
CMD ["node", "server.js"]
