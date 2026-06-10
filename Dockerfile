# Playwright base image already contains Chromium + all browser deps + xvfb deps
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# ffmpeg + ffprobe for frame/outro compositing, xvfb for headless:false browser
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Match the Playwright version in package.json with the installed browsers
RUN npx playwright install chromium

COPY . .

RUN mkdir -p uploads outputs assets

ENV NODE_ENV=production
EXPOSE 3000

# xvfb-run gives the "headless: false" Chromium a virtual display
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24", "node", "server.js"]