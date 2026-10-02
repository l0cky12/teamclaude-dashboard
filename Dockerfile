FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV PORT=8787 HOST=0.0.0.0 TEAMCLAUDE_URL=http://127.0.0.1:3456 TEAMCLAUDE_CONFIG=/config/teamclaude.json DASHBOARD_DATA_DIR=/data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
