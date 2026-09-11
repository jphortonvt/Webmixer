# Render's native Node runtime has no ffmpeg, and mixdown export shells out to
# both ffmpeg and ffprobe. Playback does not need them — sessions stream from
# MP3s already cached in B2 — which is why this only became a requirement when
# mixdown landed.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so a source-only change reuses this layer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Render supplies PORT; the app falls back to 3000 locally
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
