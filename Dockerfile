FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
