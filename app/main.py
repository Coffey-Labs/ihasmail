import bleach
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.proxy_headers import ProxyHeadersMiddleware
from . import config
from .routes import auth, mail, contacts, calendar, webdav, sieve

app = FastAPI(title="Stalwart Webmail (Python)")

if config.TRUST_PROXY:
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

app.add_middleware(SessionMiddleware, secret_key=config.APP_SECRET, session_cookie=config.COOKIE_NAME, same_site="lax", https_only=True)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

@app.get("/", include_in_schema=False)
async def root(request: Request):
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/mail" if request.session.get("user") else "/login")

# Routers
app.include_router(auth.router)
app.include_router(mail.router)
app.include_router(contacts.router)
app.include_router(calendar.router)
app.include_router(webdav.router)
app.include_router(sieve.router)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True}
