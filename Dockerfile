FROM mcr.microsoft.com/playwright:v1.50.0-noble

RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
