FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
