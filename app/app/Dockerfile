FROM node:20-bookworm-slim AS node

FROM debian:bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/app

WORKDIR /app

COPY --from=node /usr/local/bin/node /usr/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

COPY --from=node /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
COPY --from=node /lib/x86_64-linux-gnu /lib/x86_64-linux-gnu
COPY --from=node /lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2

COPY app/package.json /app/package.json
COPY app/index.js /app/index.js

RUN mkdir -p /app/firefox-profile

CMD ["/usr/bin/node", "/app/index.js"]
