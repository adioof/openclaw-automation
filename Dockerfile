FROM mcr.microsoft.com/playwright:v1.50.0-noble

RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js humanize-script.js medium-publish.js medium-auth.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["bash", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & export DISPLAY=:99 && node server.js"]
