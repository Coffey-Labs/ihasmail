import datetime

def human_size(n: int | None) -> str:
    if n is None: return ""
    units = ["B","KB","MB","GB","TB","PB"]
    i = 0
    x = float(n)
    while x >= 1024 and i < len(units)-1:
        x /= 1024.0
        i += 1
    return f"{x:.0f} {units[i]}"

def fmt_when(iso: str | None) -> str:
    if not iso: return ""
    try:
        dt = datetime.datetime.fromisoformat(iso.replace("Z","+00:00")).astimezone()
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso or ""
