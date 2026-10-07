# Образ балансувальника Nginx з вшитою конфігурацією (Round Robin за замовчуванням).
# Збирається з кореня репозиторію:  docker build -f nginx/Dockerfile .
FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
