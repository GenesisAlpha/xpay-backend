FROM node:22-slim

# Instalar dependências necessárias para o binário do Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Copiar os ficheiros de definição de pacotes
COPY package*.json ./

# 2. Copiar a pasta prisma ANTES do npm install (Crucial!)
COPY prisma ./prisma/

# 3. Instalar dependências (isto vai correr o 'prisma generate' automaticamente)
RUN npm install

# 4. Copiar o resto do código e compilar o TypeScript
COPY . .
RUN npm run build

# pay escuta na 3007 (ver src/main.ts)
ENV PORT=3007
EXPOSE 3007

# entrypoint compilado é dist/main.js (corrigido: antes apontava p/ dist/server.js, que não existe)
CMD ["node", "dist/main.js"]
