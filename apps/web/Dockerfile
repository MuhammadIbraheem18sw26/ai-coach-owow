# Stage 1: Build React + TypeScript frontend
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src

RUN pnpm run build

# Stage 2: Serve static bundle & proxy /api to FastAPI backend
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
