# Образ балансувальника Nginx з вшитою конфігурацією (Round Robin за замовчуванням).
# Збирається з кореня репозиторію:  docker build -f nginx/Dockerfile .
FROM nginx:alpine

# Пакети базового образу оновлюються рідше, ніж виходять патчі Alpine: без цього сканер
# вразливостей у CI (Grype, critical + only-fixed) падає на вже виправлених CVE (openssl, expat, musl...)
RUN apk upgrade --no-cache

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
