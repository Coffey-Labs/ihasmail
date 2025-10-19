from fastapi import APIRouter, Request, Form, HTTPException
from fastapi.responses import RedirectResponse, HTMLResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import PlainTextResponse
from .. import config, jmap
from fastapi.templating import Jinja2Templates
from jinja2 import FileSystemLoader, Environment, select_autoescape
import pathlib, base64, os

router = APIRouter()

templates = Jinja2Templates(directory=str(pathlib.Path(__file__).resolve().parent.parent / "templates"))

def make_csrf(session: dict) -> str:
    token = base64.urlsafe_b64encode(os.urandom(24)).decode()
    session["csrf"] = token
    return token

def check_csrf(session: dict, token: str):
    if not token or token != session.get("csrf"):
        raise HTTPException(status_code=400, detail="CSRF token invalid")

@router.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    csrf = make_csrf(request.session)
    return templates.TemplateResponse("login.html", {"request": request, "csrf": csrf, "jmap_base": config.JMAP_BASE})

@router.post("/login")
async def login_submit(request: Request, username: str = Form(...), password: str = Form(...), jmap_base: str = Form(...), csrf: str = Form(...)):
    check_csrf(request.session, csrf)
    async with jmap.client() as ac:
        try:
            session = await jmap.get_session(ac, jmap_base, username, password)
        except PermissionError:
            raise HTTPException(status_code=401, detail="Invalid credentials")
    api_url = session.get("apiUrl") or jmap_base
    download_url = session.get("downloadUrl") or ""
    primary = session.get("primaryAccounts") or {}
    request.session["user"] = {"username": username, "jmap_base": jmap_base, "api_url": api_url, "auth": (username, password), "download_url": download_url, "primary": primary, "session": session}
    return RedirectResponse("/mail", status_code=303)

@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)
