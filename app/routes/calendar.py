from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
import pathlib, datetime
from .. import jmap
from ..utils import fmt_when

router = APIRouter()
templates = Jinja2Templates(directory=str(pathlib.Path(__file__).resolve().parent.parent / "templates"))

def require_user(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401)
    return user

@router.get("/calendar", response_class=HTMLResponse)
async def calendar(request: Request, user=Depends(require_user)):
    async with jmap.client() as ac:
        api = user["api_url"]
        account_id = None
        now = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc)
        until = now + datetime.timedelta(days=30)
        res = await jmap.call(ac, api, tuple(user["auth"]), [
            ["CalendarEvent/query", {"accountId": account_id, "limit": 200, "sort":[{"property":"start","isAscending": True}]}, "q1"],
            ["CalendarEvent/get", {"accountId": account_id, "#ids": {"resultOf":"q1","name":"CalendarEvent/query","path":"ids"}, "properties":["id","title","start","end","location"]}, "g1"]
        ])
    events = []
    for name, data, _ in res.get("methodResponses", []):
        if name == "CalendarEvent/get":
            for e in data.get("list", []):
                try:
                    s = datetime.datetime.fromisoformat((e.get("start") or "").replace("Z","+00:00"))
                    if s < now - datetime.timedelta(days=1) or s > until:
                        continue
                except Exception:
                    pass
                events.append({"title": e.get("title") or "(no title)", "start": fmt_when(e.get("start")), "end": fmt_when(e.get("end")), "loc": e.get("location")})
    return templates.TemplateResponse("calendar.html", {"request": request, "events": events, "user": user})
