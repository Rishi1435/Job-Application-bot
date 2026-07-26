# Job Application Bot - container image for Render (or any Docker host).
#
# Puppeteer needs a real Chromium plus a pile of shared libraries. Rather than
# letting Puppeteer download its own build (which pulls another ~150 MB and can
# mismatch the base image's glibc), Chromium is installed from Debian and
# PUPPETEER_EXECUTABLE_PATH points at it.

FROM node:20-slim

ENV NODE_ENV=production \
    # Do not download the bundled Chromium - the apt package below is used.
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium + the fonts and X/GTK/NSS libraries it dynamically links against.
# Installed in one layer and the apt cache is dropped to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so the layer is cached until package.json actually changes.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Chromium refuses to run as root without --no-sandbox; the app passes that
# flag, but dropping to the image's unprivileged user is still the right
# default. `node` ships with node:20-slim.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Render overrides this with its own health check, but a local `docker run`
# still gets a meaningful container status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
