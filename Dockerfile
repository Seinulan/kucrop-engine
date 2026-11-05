FROM python:3.11-slim

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# для работы сайта нужен только физический движок; обучение ИИ - requirements-train.txt (локально)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHON_BIN=python3
EXPOSE 3000

CMD ["node", "server.js"]
