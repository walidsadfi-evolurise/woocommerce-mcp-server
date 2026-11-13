FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL io.modelcontextprotocol.server.name="io.github.walidsadfi-evolurise/woocommerce-mcp-server" \
      org.opencontainers.image.source="https://github.com/walidsadfi-evolurise/woocommerce-mcp-server" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
USER app
VOLUME ["/data"]
ENV WOO_PROPOSALS_FILE=/data/proposals.json PORT=3333
EXPOSE 3333
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["http"]
