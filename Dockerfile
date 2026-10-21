# Builds the web app, then runs the sync server on Python's standard library (no pip packages).
#   docker build -t dividends . && docker run -d -p 8787:8787 -v dividends-data:/app/data -e TZ=America/New_York dividends
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx tsc -b && npx vite build

FROM python:3.13-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
COPY server ./server
COPY --from=web /app/dist ./dist
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8787
CMD ["python3", "server/server.py"]
