# OrbytLink browser sidecar: Jev Ultrafast + headless Chrome behind POST /run.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY service.py .
RUN useradd -m browser
USER browser
# Jev reaches Chrome through browser-harness; headless Chromium is started with the sandbox flags a container needs.
ENV CHROME_BIN=/usr/bin/chromium BROWSER_CONCURRENCY=2
EXPOSE 8800
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8800"]
