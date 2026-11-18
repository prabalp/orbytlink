# OrbytLink scraper: Patchright (undetected Chromium) behind POST /fetch and POST /maps.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && python -m patchright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
COPY service.py .
RUN useradd -m scraper && chown -R scraper /ms-playwright
USER scraper
EXPOSE 8700
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8700"]
