"""Bind sshs3's sealed Windows package to its declared executable ABI.

Hermes machine facts remain native. Only package resolution in a validated,
externally managed sshs3 payload may select x64 under Windows ARM64 emulation.
"""
from pathlib import Path


ADAPTER = '''def _sshs3_payload_target(machine: str) -> str | None:
    """The steward's sealed ABI; never a profile/environment override."""
    if sys.platform != "win32" or machine not in ("arm64", "aarch64"):
        return None
    import json
    from pm import paths
    from pm.environments import _payload_manifest
    from pm.package import machine_matches_binary

    root = paths.repo_root().resolve()
    manifest = _payload_manifest(root)
    if manifest is None or manifest.get("target") != "win32-x64":
        return None
    try:
        stamp = json.loads((root / "install-stamp.json").read_text(encoding="utf-8-sig"))
        if (not isinstance(stamp, dict) or stamp.get("distribution") != "sshs3"
                or stamp.get("updateMechanism") != "external"
                or stamp.get("payload") != "bundled"):
            return None
        relative = manifest.get("runtime", {}).get("storePython")
        if not isinstance(relative, str) or Path(relative).is_absolute():
            return None
        python = (root.parent / relative).resolve()
        if not python.is_relative_to(root.parent) or not python.is_file():
            return None
        if machine_matches_binary(python, "win32-x64") is not True:
            return None
    except (OSError, ValueError, TypeError):
        return None
    return "win32-x64"


'''


def apply(source: Path) -> None:
    file = source / "pm/store.py"
    text = file.read_text(encoding="utf-8")
    if "def _sshs3_payload_target(" in text:
        return
    anchor = "def current_target() -> str:\n    machine = _native_machine()\n"
    if text.count(anchor) != 1:
        raise ValueError("Pinned Hermes package-target resolver anchor changed")
    replacement = ADAPTER + anchor + "    packaged = _sshs3_payload_target(machine)\n    if packaged is not None:\n        return packaged\n"
    file.write_text(text.replace(anchor, replacement), encoding="utf-8")
