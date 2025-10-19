from fastapi.testclient import TestClient
from app.main import app

def test_root_redirect():
    client = TestClient(app)
    r = client.get("/", allow_redirects=False)
    assert r.status_code in (302, 303)
