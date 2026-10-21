FROM node:20-alpine

WORKDIR /app

# Install dependencies required by Baileys
RUN apk add --no-cache git python3 make g++

COPY package*.json ./
RUN npm install --production

COPY . .

# Directory for stateful session persistence (mount Railway volume here)
RUN mkdir -p /data/tuna_session

EXPOSE 8080

CMD ["node", "worker.js"]
