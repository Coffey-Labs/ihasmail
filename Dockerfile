FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1     PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pyproject.toml README.md /app/
RUN pip install --no-cache-dir -e .

COPY app /app/app
COPY .env.example /app/.env.example

ENV PORT=8000
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host=0.0.0.0", "--port=8000"]
