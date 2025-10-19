from typing import List, Dict, Any, Tuple, Optional
import httpx
from urllib.parse import urljoin
from . import config

DAV_PROPFIND = """<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>"""

async def propfind(ac: httpx.AsyncClient, base: str, path: Optional[str], auth: Tuple[str,str]) -> List[Dict[str, Any]]:
    href = urljoin(base, path or "/")
    r = await ac.request("PROPFIND", href, content=DAV_PROPFIND, headers={"Depth": "1"}, auth=auth)
    if r.status_code not in (207, 200):
        raise RuntimeError(f"WebDAV error {r.status_code}")
    import xml.etree.ElementTree as ET
    tree = ET.fromstring(r.text)
    ns = {"d":"DAV:"}
    items: List[Dict[str, Any]] = []
    for resp in tree.findall("d:response", ns):
        href_el = resp.find("d:href", ns)
        prop = resp.find("d:propstat/d:prop", ns)
        if href_el is None or prop is None:
            continue
        name = prop.find("d:displayname", ns)
        cl = prop.find("d:getcontentlength", ns)
        rtype = prop.find("d:resourcetype", ns)
        is_collection = rtype is not None and rtype.find("d:collection", ns) is not None
        items.append({
            "href": href_el.text,
            "name": (name.text if name is not None and name.text else href_el.text.rstrip("/").split("/")[-1] or "/"),
            "type": "directory" if is_collection else "file",
            "size": int(cl.text) if (cl is not None and cl.text and cl.text.isdigit()) else None
        })
    if items:
        items = items[1:]
    return items
