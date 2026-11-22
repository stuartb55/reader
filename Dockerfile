FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
# Extracted articles are kept here so they survive a restart. Declared as a
# volume so it stays writable when the container's filesystem is read-only.
RUN mkdir /cache && chown node:node /cache
VOLUME /cache
USER node
ENV PORT=8080 NODE_ENV=production CACHE_DIR=/cache
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
