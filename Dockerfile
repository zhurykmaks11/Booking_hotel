# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Фіктивний DATABASE_URL потрібен лише для генерації Prisma Client на етапі збірки
# (prisma generate валідує наявність змінної, але реально до БД не звертається)
ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hotel_booking?schema=public"

RUN npx prisma generate
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]