FROM node:20-alpine AS builder
WORKDIR /app

# Dependencies first so they are cached until package files change.
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# The admin console is a Vite + React app: type-check, then bundle into dist/.
COPY . .
RUN npm run build && test -f dist/index.html

# Runtime stage
FROM alpine:3.21

RUN apk update && \
    apk add --no-cache nginx nginx-mod-http-headers-more && \
    mkdir -p /etc/nginx/ssl /var/log/nginx /var/cache/nginx /run/nginx && \
    chown -R nginx:nginx /var/log/nginx /var/cache/nginx /run/nginx

COPY nginx/nginx.conf /etc/nginx/nginx.conf

# TLS certificate and key are NOT stored in the repository or baked into the image.
# Mount them at /etc/nginx/ssl/cert.pem and /etc/nginx/ssl/key.pem (for example from a
# Kubernetes secret). nginx.conf refers to those two paths.

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3050 443

CMD ["nginx", "-g", "daemon off;"]
