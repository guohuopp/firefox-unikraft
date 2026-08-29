FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./

RUN npm install \
    --omit=dev \
    --no-audit \
    --no-fund

COPY index.js ./

ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
