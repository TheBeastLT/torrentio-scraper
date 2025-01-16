FROM node:21-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache git

WORKDIR /home/node/app

COPY package*.json ./
RUN npm ci --only-production
COPY . .

CMD [ "node", "--insecure-http-parser", "index.js" ]