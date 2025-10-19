import json
import io
import bleach
from typing import Optional
from fastapi import APIRouter, Request, Depends, HTTPException, Form, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse, JSONResponse
from fastapi.templating import Jinja2Templates
import pathlib
from .. import jmap
from ..utils import human_size, fmt_when

router = APIRouter()
templates = Jinja2Templates(directory=str(pathlib.Path(__file__).resolve().parent.parent / "templates"))

def require_user(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401)
    return user

def make_csrf(session: dict) -> str:
    import os, base64
    token = base64.urlsafe_b64encode(os.urandom(24)).decode()
    session["csrf"] = token
    return token

def check_csrf(session: dict, token: str):
    if not token or token != session.get("csrf"):
        raise HTTPException(status_code=400, detail="CSRF token invalid")

@router.get("/mail", response_class=HTMLResponse)
async def inbox(request: Request, q: Optional[str] = None, mailbox: Optional[str] = None, user=Depends(require_user)):
    async with jmap.client() as ac:
        api = user["api_url"]
        primary = user.get("primary", {})
        account_id = primary.get("urn:ietf:params:jmap:mail")
        boxes, inbox_id = await get_mailboxes(ac, api, tuple(user["auth"]), account_id)
        box_id = mailbox or inbox_id
        filt = {"text": q} if q else ({"inMailbox": box_id} if box_id else {})
        res = await jmap.call(ac, api, tuple(user["auth"]), [
            ["Email/query", {"accountId": account_id, "filter": filt, "sort": [{"property":"receivedAt","isAscending": False}], "limit": 50}, "c1"],
            ["Email/get", {"accountId": account_id, "#ids": {"resultOf":"c1","name":"Email/query","path":"ids"}, "properties": ["id","subject","from","size","receivedAt"]}, "c2"]
        ])
    emails = []

    for name, data, _ in res.get("methodResponses", []):
        if name == "Email/get":
            for e in data.get("list", []):
                from_str = ", ".join([a.get("name") or a.get("email","") for a in (e.get("from") or [])])
                emails.append({"id": e["id"], "subject": e.get("subject") or "(no subject)", "from": from_str, "when": fmt_when(e.get("receivedAt")), "size": human_size(e.get("size"))})
    return templates.TemplateResponse("mail.html", {"request": request, "messages": emails, "q": q, "user": user, "mailboxes": boxes, "selected": box_id})

@router.get("/mail/{email_id}", response_class=HTMLResponse)
async def read_message(request: Request, email_id: str, user=Depends(require_user)):
    async with jmap.client() as ac:
        api = user["api_url"]
        res = await jmap.call(ac, api, tuple(user["auth"]), [
            ["Email/get", {"ids": [email_id], "properties": ["id","subject","from","to","receivedAt","size","keywords","preview","bodyStructure","htmlBody","textBody"]}, "c1"]
        ])
    msg = {"id": email_id, "subject":"", "from":"", "to":[], "when":"", "textBody":"", "htmlBody":"", "attachments":[]}
    bstruct = None
    cid_map = {}
    for name, data, _ in res.get("methodResponses", []):
        if name == "Email/get":
            lst = data.get("list", [])
            if lst:
                e = lst[0]
                msg["subject"] = e.get("subject") or msg["subject"]
                msg["from"] = ", ".join([a.get("name") or a.get("email","") for a in (e.get("from") or [])]) or msg["from"]
                msg["to"] = [a.get("email","") for a in (e.get("to") or [])] or msg["to"]
                msg["when"] = fmt_when(e.get("receivedAt")) or msg["when"]
                if "textBody" in e:
                    msg["textBody"] = e.get("textBody") or msg["textBody"]
                if "htmlBody" in e:
                    raw_html = e.get("htmlBody")
                    if raw_html:
                        msg["htmlBody"] = bleach.clean(raw_html, tags=bleach.sanitizer.ALLOWED_TAGS.union({"p","span","div","br","hr","pre","code","blockquote","ul","ol","li","table","thead","tbody","tr","th","td","img","a","b","i","strong","em"}), attributes={"a":["href","title"],"img":["src","alt","title","width","height"]}, strip=True)
                bstruct = bstruct or e.get("bodyStructure")
                def walk_cid(bs):
                    if not isinstance(bs, dict): return
                    cid = bs.get("cid")
                    if cid and bs.get("blobId"):
                        cid_map[cid.strip("<>")] = {"blobId": bs["blobId"], "name": bs.get("name") or "inline"}
                    for p in bs.get("subParts", []) or []:
                        walk_cid(p)
                if bstruct:
                    walk_cid(bstruct)

    def walk_bs(bs, out):
        if not isinstance(bs, dict): return
        if bs.get("disposition") == "attachment":
            out.append({"name": bs.get("name") or "attachment", "type": bs.get("type") or "application/octet-stream", "size": bs.get("size"), "blobId": bs.get("blobId")})
        for p in bs.get("subParts", []) or []:
            walk_bs(p, out)
    att = []
    walk_bs(bstruct, att)
    msg["attachments"] = att
    # Inline CID images via internal route
    if msg.get("htmlBody") and cid_map:
        import re as _re
        def _repl(m):
            cid = m.group(1)
            return f'src="/mail/{email_id}/cid/{cid}"'
        msg["htmlBody"] = _re.sub(r'src=\"cid:([^\"]+)\"', _repl, msg["htmlBody"])  # cid_rewrite
    return templates.TemplateResponse("message.html", {"request": request, "msg": msg, "user": user})

@router.get("/compose", response_class=HTMLResponse)
async def compose_form(request: Request, user=Depends(require_user)):
    csrf = make_csrf(request.session)
    return templates.TemplateResponse("compose.html", {"request": request, "csrf": csrf, "user": user})

@router.post("/compose")
async def compose_send(request: Request, to: str = Form(...), subject: str = Form(""), body: str = Form(""), csrf: str = Form(...), action: str = Form("send"), files: list[UploadFile] = File(default=[]), user=Depends(require_user)):
    check_csrf(request.session, csrf)
    async with jmap.client() as ac:
        api = user["api_url"]
        primary = user.get("primary", {})
        account_id = primary.get("urn:ietf:params:jmap:mail")
        # Upload attachments if any
        upload_url = user.get("upload_url")
        blobs = []
        form = await request.form()
        for k, v in form.multi_items():
            if k == 'preblob':
                try:
                    b = json.loads(v)
                    if b.get('blobId'): blobs.append(b)
                except Exception:
                    pass
        if files:
            for f in files:
                data = await f.read()
                if upload_url:
                    url = upload_url.replace("{accountId}", account_id or "")
                    ru = await ac.post(url, content=data, headers={"Content-Type": f.content_type or "application/octet-stream"}, auth=tuple(user["auth"]))
                    ru.raise_for_status()
                    up = ru.json()
                    blobs.append({"blobId": up.get("blobId"), "type": f.content_type or "application/octet-stream", "name": f.filename, "size": len(data)})
        email_creation_id = "k1"
        submission_creation_id = "k2"
        create_email = {
            "accountId": account_id,
            "create": {
                email_creation_id: {
                    "mailboxIds": {},
                    "from": [{"email": user["username"]}],
                    "to": [{"email": x.strip()} for x in to.split(",") if x.strip()],
                    "subject": subject,
                    "textBody": body,
                    "attachments": [{"blobId": b["blobId"], "type": b["type"], "name": b["name"]} for b in blobs]
                }
            }
        }
        # Move to Drafts if requested, else submit and move to Sent
        special = await get_special_mailboxes(ac, api, tuple(user["auth"]), account_id)
        sent_id = special.get("sent")
        drafts_id = special.get("drafts")
        calls = []
        calls.append(["Email/set", create_email, "s1"])
        if action == "draft":
            if drafts_id:
                calls.append(["Email/set", {"accountId": account_id, "onSuccessUpdateEmail": {"#kEmail": {"mailboxIds": {drafts_id: True}}}}, "sdraft"])
        else:
            calls.append(["EmailSubmission/set", {"accountId": account_id, "create": {submission_creation_id: {"emailId": {"resultOf":"s1","name":"Email/set","path": f"created/{email_creation_id}/id"}}}}, "s2"])
            if sent_id:
                calls.append(["Email/set", {"accountId": account_id, "onSuccessUpdateEmail": {"#kEmail": {"mailboxIds": {sent_id: True}}}}, "ssent"])
        await jmap.call(ac, api, tuple(user["auth"]), calls)
    return RedirectResponse("/mail", status_code=303)

async def get_mailboxes(ac, api, auth, account_id):
    res = await jmap.call(ac, api, auth, [
        ["Mailbox/query", {"accountId": account_id, "sort":[{"property":"sortOrder","isAscending": True},{"property":"name","isAscending": True}], "limit": 200}, "q1"],
        ["Mailbox/get", {"accountId": account_id, "#ids": {"resultOf":"q1","name":"Mailbox/query","path":"ids"}, "properties":["id","name","role","totalEmails","unreadEmails"]}, "g1"]
    ])
    boxes = []
    inbox_id = None
    for name, data, _ in res.get("methodResponses", []):
        if name == "Mailbox/get":
            for b in data.get("list", []):
                boxes.append({"id": b["id"], "name": b.get("name",""), "role": b.get("role"), "total": b.get("totalEmails",0), "unread": b.get("unreadEmails",0)})
                if b.get("role") == "inbox":
                    inbox_id = b["id"]
    return boxes, inbox_id or (boxes[0]["id"] if boxes else None)

@router.get("/mail/{email_id}/attach/{index}")
async def download_attachment(request: Request, email_id: str, index: int, user=Depends(require_user)):
    atts = request.query_params.get("atts")
    # Re-fetch message to resolve bodyStructure (simple approach; could cache)
    async with jmap.client() as ac:
        api = user["api_url"]
        res = await jmap.call(ac, api, tuple(user["auth"]), [
            ["Email/get", {"ids": [email_id], "properties": ["bodyStructure"]}, "c1"]
        ])
    bstruct = None
    cid_map = {}
    for name, data, _ in res.get("methodResponses", []):
        if name == "Email/get":
            lst = data.get("list", [])
            if lst:
                bstruct = lst[0].get("bodyStructure")
    parts = []
    def walk(bs, out):
        if not isinstance(bs, dict): return
        if bs.get("disposition") == "attachment":
            out.append(bs)
        for p in bs.get("subParts", []) or []:
            walk(p, out)
    walk(bstruct, parts)
    if index < 0 or index >= len(parts):
        raise HTTPException(status_code=404, detail="Attachment not found")
    p = parts[index]
    blob = p.get("blobId")
    name = p.get("name") or "attachment"
    ctype = p.get("type") or "application/octet-stream"

    # Build download URL from session template
    tmpl = user.get("download_url") or ""
    primary = user.get("primary", {})
    account_id = primary.get("urn:ietf:params:jmap:mail")
    url = tmpl
    if "{accountId}" in url:
        url = url.replace("{accountId}", account_id or "")
    if "{blobId}" in url:
        url = url.replace("{blobId}", blob or "")
    if "{name}" in url:
        from urllib.parse import quote
        url = url.replace("{name}", quote(name))
    # Fallback naive pattern if template missing
    if not url or "{" in url:
        from urllib.parse import urljoin, quote
        base = user.get("jmap_base")
        url = urljoin(base, f"/download/{quote(account_id or '')}/{quote(blob or '')}/{quote(name)}")

    async with jmap.client() as ac:
        r = await ac.get(url, auth=tuple(user["auth"]))
        r.raise_for_status()
        return StreamingResponse(io.BytesIO(r.content), media_type=ctype, headers={"Content-Disposition": f'attachment; filename="{name}"'})


async def get_special_mailboxes(ac, api, auth, account_id):
    res = await jmap.call(ac, api, auth, [
        ["Mailbox/query", {"accountId": account_id, "limit": 200}, "q1"],
        ["Mailbox/get", {"accountId": account_id, "#ids": {"resultOf":"q1","name":"Mailbox/query","path":"ids"}, "properties":["id","role","name"]}, "g1"]
    ])
    sent_id = drafts_id = inbox_id = None
    boxes = {}
    for name, data, _ in res.get("methodResponses", []):
        if name == "Mailbox/get":
            for b in data.get("list", []):
                boxes[b["id"]] = b
                role = b.get("role")
                if role == "sent": sent_id = b["id"]
                if role == "drafts": drafts_id = b["id"]
                if role == "inbox": inbox_id = b["id"]
    return {"sent": sent_id, "drafts": drafts_id, "inbox": inbox_id, "all": boxes}


@router.get("/mail/{email_id}/cid/{cid}")
async def fetch_cid(request: Request, email_id: str, cid: str, user=Depends(require_user)):
    # Walk bodyStructure to find matching cid, then download via downloadUrl
    async with jmap.client() as ac:
        api = user["api_url"]
        res = await jmap.call(ac, api, tuple(user["auth"]), [
            ["Email/get", {"ids": [email_id], "properties": ["bodyStructure"]}, "c1"]
        ])
    bstruct = None
    for name, data, _ in res.get("methodResponses", []):
        if name == "Email/get":
            lst = data.get("list", [])
            if lst:
                bstruct = lst[0].get("bodyStructure")
    target = None
    def walk(bs):
        nonlocal target
        if not isinstance(bs, dict) or target is not None: return
        if bs.get("cid") and bs.get("cid").strip("<>") == cid:
            target = bs
            return
        for p in bs.get("subParts", []) or []:
            walk(p)
    walk(bstruct)
    if not target:
        raise HTTPException(status_code=404, detail="Inline part not found")
    blob = target.get("blobId")
    ctype = target.get("type") or "application/octet-stream"
    name = target.get("name") or "inline"
    tmpl = user.get("download_url") or ""
    primary = user.get("primary", {})
    account_id = primary.get("urn:ietf:params:jmap:mail")
    from urllib.parse import quote, urljoin
    if tmpl and "{accountId}" in tmpl and "{blobId}" in tmpl:
        url = tmpl.replace("{accountId}", account_id or "").replace("{blobId}", blob or "")
        if "{name}" in url:
            url = url.replace("{name}", quote(name))
    else:
        url = urljoin(user.get("jmap_base"), f"/download/{quote(account_id or '')}/{quote(blob or '')}/{quote(name)}")
    async with jmap.client() as ac:
        r = await ac.get(url, auth=tuple(user["auth"]))
        r.raise_for_status()
        return StreamingResponse(io.BytesIO(r.content), media_type=ctype)


@router.post("/upload")
async def upload_file(request: Request, file: UploadFile = File(...), user=Depends(require_user)):
    async with jmap.client() as ac:
        primary = user.get("primary", {})
        account_id = user.get("active_account") or primary.get("urn:ietf:params:jmap:mail")
        upload_url = user.get("upload_url")
        if not upload_url or not account_id:
            raise HTTPException(status_code=400, detail="Upload not available")
        url = upload_url.replace("{accountId}", account_id)
        data = await file.read()
        r = await ac.post(url, content=data, headers={"Content-Type": file.content_type or "application/octet-stream"}, auth=tuple(user["auth"]))
        r.raise_for_status()
        up = r.json()
        return JSONResponse({"blobId": up.get("blobId"), "type": file.content_type or "application/octet-stream", "name": file.filename, "size": len(data)})
