FROM node:20

# 1. Definir diretório de trabalho
WORKDIR /app

# 2. Copiar apenas os ficheiros de dependências
COPY package*.json ./

# 3. COPIAR A PASTA PRISMA ANTES DO INSTALL (Crucial para o postinstall)
COPY prisma ./prisma/

# 4. Instalar dependências (isto vai correr o prisma generate agora com sucesso)
RUN npm install

# 5. Copiar o restante código fonte
COPY . .

# 6. Compilar o TypeScript
RUN npm run build

# 7. Expor a porta da nossa API
EXPOSE 8080

# 8. Comando para iniciar o motor
CMD ["npm", "start"]
