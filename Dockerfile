# Gunakan Node.js versi LTS
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json & package-lock.json ke container
COPY package*.json ./

# Install dependencies (production mode)
RUN npm install --omit=dev

# Copy semua file project ke container
COPY . .

# Set environment (default production)
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Gunakan user non-root demi security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Jalankan aplikasi
CMD ["npm", "start"]
