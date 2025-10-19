from typing import Optional
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
import pathlib
from .. import dav, jmap, config

router = APIRouter()
templates = Jinja2Templates(directory=str(pathlib.Path(__file__).resolve().parent.parent / "templates"))

def require_user(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401)
    return user

@router.get("/webdav", response_class=HTMLResponse)
async def webdav_browse(request: Request, path: Optional[str]=None, user=Depends(require_user)):
    async with jmap.client() as ac:
        items = await dav.propfind(ac, config.WEBDAV_BASE, path, tuple(user["auth"]))
    return templates.TemplateResponse("webdav.html", {"request": request, "items": items, "base": config.WEBDAV_BASE, "user": user})
