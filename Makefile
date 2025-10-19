.PHONY: run dev test build

run:
	uvicorn app.main:app --host 0.0.0.0 --port 8000

dev:
	uvicorn app.main:app --reload

test:
	pytest

build:
	docker compose build
