# Deployable Playwright image
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .

# Ensure Chromium deps are installed via postinstall
EXPOSE 8080
CMD ["npm","start"]