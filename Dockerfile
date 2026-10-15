# ---- Build stage ----
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .


ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hotel_booking?schema=public"

RUN npx prisma generate
RUN npm run build

# ---- Production stage ----
FROM node:24-alpine

WORKDIR /app

# Версія образу (передається з CI: 1.0.0, 1.1.0, sha-...); віддається ендпоінтом GET /version
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
