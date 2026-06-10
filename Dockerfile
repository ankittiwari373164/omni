# Free-plan dashboard image: no Playwright/Chromium/xvfb needed here.
# Heavy jobs (Playwright + ffmpeg) run in GitHub Actions via worker.js.
FROM node:20-slim

# ffmpeg kept only for the rare case you flip RUN_JOBS=true later; comment out to slim further
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p uploads outputs assets

ENV NODE_ENV=production

# Render injects PORT — server.js reads process.env.PORT
CMD ["node", "server.js"]