# Nexus backend — built for Google Cloud Run (CPU-only).
#
# Deliberately does NOT install requirements-gpu.txt: Cloud Run has no GPU, and
# the CUDA wheels would add ~1.3GB of dead weight to every cold start. For
# public deployments set STT_BACKEND=openai (each user's own key pays) — the
# local faster-whisper path still works here, just slowly, as the fallback.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependency layer first so code edits don't re-run pip.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY backend/ backend/

# Cloud Run injects PORT; default matches local dev. .env is NOT copied —
# configuration comes from the platform's environment variables.
ENV PORT=8001
CMD exec python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}
