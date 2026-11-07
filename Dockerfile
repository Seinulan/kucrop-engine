# KUCrop: Node.js (сайт) + Python (физика AquaCrop-OSPy). Работает на Hugging Face Spaces, Render, Railway, Fly и обычном VPS.
FROM node:22-slim

# Python для физики; пакеты ставим в venv (системный pip в Debian не даёт ставить пакеты напрямую)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH" \
    PYTHON_BIN=python \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# для работы сайта нужен только физический движок; обучение ИИ - requirements-train.txt (локально)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Hugging Face Spaces запускает контейнер от пользователя с UID 1000; в образах node это пользователь node.
# user_files - сюда сайт сохраняет загруженные пользователем файлы.
RUN mkdir -p user_files && chown -R node:node /app
USER node

# Порт по умолчанию 7860 (как в README для Hugging Face); Render и Railway сами задают PORT.
ENV PORT=7860
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
