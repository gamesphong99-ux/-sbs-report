FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

RUN mkdir -p /app/data

EXPOSE 3000
ENV PORT=3000
ENV DB_PATH=/app/data/sbs.db

CMD ["node", "server.js"]
