FROM python:3.12-slim
WORKDIR /srv/vihanga-cloud
COPY pyproject.toml .
COPY vihanga_cloud ./vihanga_cloud
RUN pip install --no-cache-dir .
USER 65534:65534
EXPOSE 8750
CMD ["uvicorn","vihanga_cloud.app:app","--host","127.0.0.1","--port","8750"]
