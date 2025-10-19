from typing import Any, Dict, List, Tuple
import httpx
from . import config

def client() -> httpx.AsyncClient:
    limits = httpx.Limits(max_connections=20, max_keepalive_connections=10)
    return httpx.AsyncClient(timeout=config.UPSTREAM_TIMEOUT, limits=limits, trust_env=True)

async def get_session(ac: httpx.AsyncClient, base: str, username: str, password: str) -> Dict[str, Any]:
    r = await ac.get(base, auth=(username, password))
    if r.status_code == 401:
        raise PermissionError("Invalid credentials")
    r.raise_for_status()
    return r.json()

async def call(ac: httpx.AsyncClient, api_url: str, auth: Tuple[str,str] | None, method_calls: List[list]) -> Dict[str, Any]:
    payload = {
        "using": [
            "urn:ietf:params:jmap:core",
            "urn:ietf:params:jmap:mail",
            "urn:ietf:params:jmap:contacts",
            "urn:ietf:params:jmap:calendars"
        ],
        "methodCalls": method_calls
    }
    kwargs: Dict[str, Any] = {"json": payload}
    if auth:
        kwargs["auth"] = auth
    r = await ac.post(api_url, **kwargs)
    r.raise_for_status()
    return r.json()
