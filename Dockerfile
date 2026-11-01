FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    BEHOLDER_DATA_DIR=/app/data \
    PORT=3000 \
    HOST=0.0.0.0
COPY package.json ./
COPY src ./src
COPY public ./public
# Source commit for Emergency Dump provenance (pattern from Society). Unset builds bake "". Never a secret.
ARG SOURCE_COMMIT_SHA=""
RUN node -e 'require("node:fs").writeFileSync("/app/build-info.json", JSON.stringify({ sourceCommitSha: process.env.SOURCE_COMMIT_SHA || "" }))' \
 && mkdir -p /app/data/images /app/data/uploaded-images
EXPOSE 3000
CMD ["node", "src/server.js"]
