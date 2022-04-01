FROM node:16-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache git

WORKDIR /home/node/app

COPY ./catalogs .
COPY ./addon ../addon
RUN npm ci --only-production

CMD [ "node", "index.js" ]