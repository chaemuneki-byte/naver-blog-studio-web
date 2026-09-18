FROM mcr.microsoft.com/playwright/python:v1.62.0-noble
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY docs ./docs
RUN mkdir /app/data && chown -R pwuser:pwuser /app
USER pwuser
ENV DATA_DIR=/app/data
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "server.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--no-proxy-headers"]
