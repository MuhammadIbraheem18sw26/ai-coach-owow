FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

# Copy dependency definitions first for layer caching
COPY pyproject.toml uv.lock* ./

# Install dependencies (including psycopg, pgvector, pytest, httpx)
RUN uv sync --no-install-project

# Copy application source, SQL schema, fixture data, and evaluation scripts
COPY db ./db
COPY data ./data
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY sitecustomize.py ./

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "coach.main:app", "--host", "0.0.0.0", "--port", "8000"]
