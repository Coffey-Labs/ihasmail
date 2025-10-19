from typing import Optional
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
import pathlib
from .. import jmap

router = APIRouter()
templates = Jinja2Templates(directory=str(pathlib.Path(__file__).resolve().parent.parent / "templates"))

def require_user(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401)
    return user

@router.get("/contacts", response_class=HTMLResponse)
async def contacts(request: Request, q: Optional[str] = None, user=Depends(require_user)):
    async with jmap.client() as ac:
        api = user["api_url"]
        account_id = None
        filter_cond = {"text": q} if q else {}
        res = await jmap.call(ac, api, tuple(user["auth"]), [
            ["Contact/query", {"accountId": account_id, "filter": filter_cond, "limit": 100}, "c1"],
            ["Contact/get", {"accountId": account_id, "#ids": {"resultOf":"c1","name":"Contact/query","path":"ids"}, "properties":["id","firstName","lastName","emails","company"]}, "c2"]
        ])
    contacts = []
    for name, data, _ in res.get("methodResponses", []):
        if name == "Contact/get":
            for c in data.get("list", []):
                emails = [e.get("email","") for e in (c.get("emails") or [])]
                contacts.append({"name": f"{c.get('firstName','')} {c.get('lastName','')}".strip() or (emails[0] if emails else ""),
                                 "email": ", ".join(emails),
                                 "org": c.get("company")})
    return templates.TemplateResponse("contacts.html", {"request": request, "contacts": contacts, "q": q, "user": user})
