FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["npm", "start"]
