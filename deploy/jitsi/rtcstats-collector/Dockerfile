FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY stats.mjs server.mjs report.mjs ./
ENV DATA_DIR=/data PORT=8099
USER node
EXPOSE 8099
CMD ["node", "server.mjs"]
