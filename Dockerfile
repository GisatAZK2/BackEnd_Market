# Gunakan Node.js versi LTS (alpine untuk lebih ringan)
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

# Buat group & user non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Buat folder uploads & kasih izin ke appuser
RUN mkdir -p /usr/src/app/uploads && chown -R appuser:appgroup /usr/src/app

# Switch ke user non-root
USER appuser

# Jalankan aplikasi
CMD ["npm", "start"]
