import json

from fastapi.testclient import TestClient

from scansci_pdf import config
from scansci_pdf import browser_backend
from scansci_pdf.ego_host import app, TOKEN


def test_host_settings_and_authorization():
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        ping = client.get("/api/ping").json()
        assert ping["version"] == "1.19.0"
        assert ping["protocol"] == "ego-scansci-v1"
        assert client.get("/settings").status_code == 200
        assert client.post("/api/config", json={"key": "email", "value": "test@example.invalid"}).status_code == 403
        assert client.post("/api/config", headers={"origin": "https://evil.example"}, json={"key": "email", "value": "bad"}).status_code == 403
        response = client.post("/api/config", headers={"origin": "http://127.0.0.1:8765"}, json={"key": "email", "value": "test@example.test"})
        assert response.status_code == 200, response.text
        assert client.get("/api/dashboard").status_code == 200
        for channel in ("webvpn", "carsi", "ezproxy", "elsevier", "grey", "tor"):
            result = client.post("/api/channel/action", headers={"x-ego-scansci-token": TOKEN}, json={"channel": channel, "action": "check"})
            assert result.status_code in (200, 400, 409), result.text
            assert "Traceback" not in result.text
        assert client.get("/api/ping", headers={"host": "evil.example"}).status_code == 403


def test_config_preserves_unknown_and_secrets():
    original = {"email": "saved@example.invalid", "elsevier_api_key": "test-only-secret", "custom_setting": 42, "scihub_enabled": True}
    config.CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.CONFIG_FILE.write_text(json.dumps(original), encoding="utf-8")
    loaded = config.load_config()
    assert loaded["scihub_enabled"] is True
    assert loaded["custom_setting"] == 42
    assert config.get_config_safe()["elsevier_api_key"] == "***"
    config.update_config("batch_workers", "3")
    assert config.load_config()["elsevier_api_key"] == "test-only-secret"


def test_browser_launches_are_strictly_ego(monkeypatch):
    from scansci_pdf import egolite_bridge as bridge
    marker = object()
    monkeypatch.setenv("SCANSCI_EGO_HOSTED", "1")
    monkeypatch.setattr(bridge, "launch", lambda cfg=None: marker)
    monkeypatch.setattr(bridge, "launch_persistent_context", lambda cfg=None: marker)
    assert browser_backend.resolve_backend({"browser_backend": "cloakbrowser"}) == "egolite"
    assert browser_backend.launch(config={"browser_backend": "patchright"}) is marker
    assert browser_backend.launch_persistent_context("unused") is marker


def test_pdf_and_login_route_to_ego(monkeypatch, tmp_path):
    from scansci_pdf import browser_engine, browser_login, egolite_bridge as bridge
    monkeypatch.setenv("SCANSCI_EGO_HOSTED", "1")
    calls = []
    monkeypatch.setattr(bridge, "download_pdf", lambda url, path, cfg, **kwargs: calls.append(url) or True)
    assert browser_engine.download_pdf_via_browser("https://example.test/a.pdf", tmp_path / "a.pdf", {})
    assert calls == ["https://example.test/a.pdf"]
    monkeypatch.setattr(bridge, "interactive_login", lambda *args, **kwargs: [{"name": "session", "value": "fixture", "domain": "example.test", "path": "/"}])
    assert browser_login.open_login_browser("https://example.test", {}, cookie_file=tmp_path / "cookies.json", auto_import=False)
    assert (tmp_path / "cookies.json").exists()


def test_pdf_validation_rejects_html_and_pdf_shells(tmp_path):
    import fitz
    from scansci_pdf.pdf_utils import is_pdf_file
    path = tmp_path / "result.pdf"
    path.write_bytes(b"<html>Login required</html>")
    assert not is_pdf_file(path)
    path.write_bytes(b"%PDF-1.7\n" + b"x" * 2000 + b"\n%%EOF")
    assert not is_pdf_file(path)
    document = fitz.open()
    document.new_page().insert_text((30, 30), "Ego ScanSci validation fixture")
    document.save(path)
    document.close()
    assert is_pdf_file(path)


def test_atomic_download_preserves_existing_on_failure(tmp_path):
    from scansci_pdf.ego_atomic_pdf import write_pdf_atomic
    path = tmp_path / "existing.pdf"
    path.write_bytes(b"original bytes")
    assert not write_pdf_atomic(path, b"%PDF-1.7\n", [b"invalid\n%%EOF"])
    assert path.read_bytes() == b"original bytes"
    assert not list(tmp_path.glob("*.part"))


def test_api_setup_links_use_ego(monkeypatch):
    from scansci_pdf import ego_browser_actions as actions
    calls = []
    monkeypatch.setattr(actions, "navigate", lambda url, cfg: calls.append(url))
    assert actions.open_url("https://dev.elsevier.com/") is True
    assert calls == ["https://dev.elsevier.com/"]


def test_browser_fetch_and_html_routes(monkeypatch, tmp_path):
    from scansci_pdf import browser_engine, egolite_bridge as bridge
    monkeypatch.setenv("SCANSCI_EGO_HOSTED", "1")
    monkeypatch.setattr(bridge, "navigate", lambda *args, **kwargs: None)
    monkeypatch.setattr(bridge, "snapshot", lambda cfg: {"url": "https://example.test", "html": "<h1>fixture</h1>"})
    monkeypatch.setattr(bridge, "export_cookies", lambda *args, **kwargs: [])
    result = browser_engine.solve_url("https://example.test", {})
    assert result["solution"]["response"] == "<h1>fixture</h1>"
    def download(url, path, cfg, **kwargs):
        path.write_bytes(b"%PDF-fixture")
        return True
    monkeypatch.setattr(bridge, "download_pdf", download)
    result = browser_engine.fetch_url("fixture-tab", "https://example.test/a.pdf", {})
    assert result["data"] == b"%PDF-fixture"
