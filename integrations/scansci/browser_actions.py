"""Open setup links in Ego rather than the operating system's default browser."""

from urllib.parse import urlsplit

from .config import load_config
from .egolite_bridge import navigate


def open_url(url):
    if urlsplit(url).scheme not in {"https", "http"}:
        raise ValueError("Only browser URLs are supported")
    navigate(url, load_config())
    return True
