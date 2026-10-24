import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scansci_pdf import config
from scansci_pdf import ego_config_state as storage
from scansci_pdf import ego_setup as setup
from scansci_pdf.ego_host import app, TOKEN


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setitem(config.DEFAULT_CONFIG, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setitem(config.DEFAULT_CONFIG, "output_dir", str(tmp_path / "papers"))


def request(channel, **values):
    return setup.SetupRequest(channel=channel, values=values)


def test_school_search_and_atomic_group_save():
    config.save_config({"elsevier_api_key": "preserved-test-secret", "custom_setting": 42})
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        schools = client.get("/api/setup/schools?query=").json()["schools"]
        assert schools and schools[0]["host"].startswith("https://")
        name = schools[0]["name"]
        payload = {"channel": "webvpn", "school": name, "values": {}}
        assert client.post("/api/setup", json=payload).status_code == 403
        result = client.post("/api/setup", headers={"x-ego-scansci-token": TOKEN}, json=payload)
        assert result.status_code == 200, result.text
        assert "preserved-test-secret" not in result.text
    saved = config.load_config()
    assert saved["vpnsci_school"] == name
    assert saved["vpnsci_base_url"] == schools[0]["host"]
    assert saved["vpnsci_enabled"] is True
    assert saved["custom_setting"] == 42
    assert saved["elsevier_api_key"] == "preserved-test-secret"


@pytest.mark.parametrize("payload", [
    request("basic", email="scansci-pdf@example.invalid", output_dir="new"),
    request("webvpn", vpnsci_enabled=True, vpnsci_base_url="file:///private"),
    request("webvpn", vpnsci_enabled=True, vpnsci_base_url="https://user:secret@example.test"),
    request("carsi", carsi_enabled=True, carsi_idp_name=""),
    request("ezproxy", ezproxy_enabled=True, ezproxy_login_url=""),
    request("basic", elsevier_api_key="wrong-channel"),
    request("elsevier", elsevier_api_key=""),
])
def test_invalid_setup_preserves_all_existing_values(payload):
    config.save_config({"email": "reader@example.test", "custom_setting": 42})
    before = config.CONFIG_FILE.read_bytes()
    with pytest.raises(ValueError):
        setup.apply_setup(payload)
    assert config.CONFIG_FILE.read_bytes() == before


def test_write_failure_retains_previous_config(monkeypatch):
    config.save_config({"email": "original@example.test", "elsevier_api_key": "fixture-secret"})
    before = config.CONFIG_FILE.read_bytes()
    original = storage.os.replace

    def fail_config(source, target):
        if Path(target) == config.CONFIG_FILE:
            raise OSError("Simulated interruption")
        return original(source, target)

    monkeypatch.setattr(storage.os, "replace", fail_config)
    with pytest.raises(OSError):
        config.update_config("email", "changed@example.test")
    assert config.CONFIG_FILE.read_bytes() == before
    assert config.CONFIG_FILE.with_suffix(".json.bak").read_bytes() == before
    assert not list(config.DATA_DIR.glob("*.tmp"))


def test_corrupt_config_recovers_backup_and_preserves_damaged_bytes():
    config.save_config({"email": "previous@example.test", "elsevier_api_key": "fixture-secret"})
    config.update_config("email", "new@example.test")
    config.CONFIG_FILE.write_bytes(b'{"interrupted')
    recovered = config.load_config()
    assert recovered["email"] == "previous@example.test"
    assert recovered["elsevier_api_key"] == "fixture-secret"
    damaged = list(config.DATA_DIR.glob("config.corrupt-*.json"))
    assert len(damaged) == 1 and damaged[0].read_bytes() == b'{"interrupted'


def test_corrupt_config_without_backup_is_not_silently_reset():
    config.CONFIG_FILE.write_bytes(b"broken")
    with pytest.raises(ValueError):
        config.load_config()
    assert config.CONFIG_FILE.read_bytes() == b"broken"


def _environment():
    return {**os.environ, "SCANSCI_PDF_DATA_DIR": str(config.DATA_DIR), "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}


def test_separate_processes_preserve_concurrent_config_updates():
    config.save_config({"custom_setting": 42})
    code = "from scansci_pdf.config import update_config; import sys; [update_config(sys.argv[1],sys.argv[2]) for _ in range(15)]"
    def run(item):
        subprocess.run([sys.executable, "-c", code, *item], env=_environment(), check=True, capture_output=True, timeout=30)
    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(run, [("batch_workers", "7"), ("connect_timeout", "17"), ("read_timeout", "37")]))
    saved = config.load_config()
    assert (saved["batch_workers"], saved["connect_timeout"], saved["read_timeout"]) == (7, 17, 37)
    assert saved["custom_setting"] == 42


def _saved_session():
    setup.apply_setup(request("webvpn", vpnsci_enabled=True, vpnsci_school="Fixture University", vpnsci_base_url="https://vpn.example.test"))
    cache = Path(config.load_config()["cache_dir"])
    cache.mkdir(parents=True, exist_ok=True)
    cookie = cache / "instsci-cookies.json"
    cookie.write_text('[{"name":"session","value":"fixture-cookie-secret","domain":"vpn.example.test"}]')
    return cookie


def test_session_and_settings_survive_new_process():
    _saved_session()
    setup.record_check("webvpn", {"session_state": "valid"})
    code = "import json; from scansci_pdf import config,ego_setup; print(json.dumps(ego_setup.session_summary('webvpn',config.load_config())))"
    result = subprocess.run([sys.executable, "-c", code], env=_environment(), check=True, capture_output=True, text=True, timeout=30)
    saved = json.loads(result.stdout)
    assert saved["session_valid"] and saved["has_cookies"] and saved["last_check"]
    assert "fixture-cookie-secret" not in result.stdout
    history = (config.DATA_DIR / "ego-setup-state.json").read_text()
    assert "fixture-cookie-secret" not in history


def test_stale_or_changed_school_cannot_claim_valid_session(monkeypatch):
    _saved_session()
    setup.record_check("webvpn", {"session_state": "valid"})
    current = setup.time.time()
    monkeypatch.setattr(setup.time, "time", lambda: current + 301)
    assert setup.session_summary("webvpn", config.load_config())["session_state"] == "unverified"
    assert setup.session_summary("webvpn", config.load_config())["has_cookies"]
    monkeypatch.setattr(setup.time, "time", lambda: current)
    config.update_config("vpnsci_school", "Different university")
    assert not setup.session_summary("webvpn", config.load_config())["session_valid"]


def test_network_failure_and_expiry_keep_cookie_bytes(monkeypatch):
    from scansci_pdf.sources import instsci
    cookie = _saved_session()
    before = cookie.read_bytes()
    for result in ("unreachable", "expired"):
        monkeypatch.setattr(instsci, "session_status", lambda cfg: result)
        observed = setup.verify_session("webvpn")
        assert observed["session_state"] == result
        assert cookie.read_bytes() == before


def test_dashboard_refresh_does_not_probe_institution_login(monkeypatch):
    from scansci_pdf.sources import instsci
    from scansci_pdf.web import _dashboard_payload
    _saved_session()
    def fail_probe(cfg):
        raise AssertionError("Dashboard refresh must not probe or open a login page")
    monkeypatch.setattr(instsci, "session_status", fail_probe)
    payload = _dashboard_payload()
    assert payload["channels"]["webvpn"]["has_cookies"]
    assert payload["channels"]["webvpn"]["session_state"] == "unverified"
    assert payload["storage"]["config_saved"]


@pytest.mark.parametrize("timestamp", ["broken", None, float("inf"), 10**30])
def test_invalid_session_observation_is_unverified(timestamp):
    _saved_session()
    setup.record_check("webvpn", {"session_state": "valid"})
    path = config.DATA_DIR / "ego-setup-state.json"
    history = json.loads(path.read_text())
    history["webvpn"]["at"] = timestamp
    path.write_text(json.dumps(history))
    summary = setup.session_summary("webvpn", config.load_config())
    assert summary["session_state"] == "unverified"
    assert summary["last_check"] is None
    assert summary["has_cookies"]
