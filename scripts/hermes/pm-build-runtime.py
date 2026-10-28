"""Prepare a new sshs3 distribution through Hermes' own PM and assembler APIs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import subprocess
import time
import shutil
import runpy


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--desktop-version", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--extras", required=True)
    parser.add_argument("--managed-tools", action="store_true")
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    if not source.is_relative_to(out):
        raise ValueError("All runtime build outputs must belong to the fresh distribution")
    runpy.run_path(str(Path(__file__).with_name("runtime-target-adapter.py")))["apply"](source)
    sys.path.insert(0, str(source))
    from pm.runtime import is_runtime, runtime_command
    if not is_runtime():
        # Run the distribution adapter inside PM's independent interpreter.
        # Tool extensions resolve their parent package in the selected store;
        # a foreign worker store would make npm lose the node just prepared.
        raise SystemExit(subprocess.run(runtime_command(Path(__file__).resolve(), sys.argv[1:]),
                                        env=dict(os.environ)).returncode)
    from pm import build_environment, prepare_tools, stage_manager_runtime
    from pm.features import installed_extras, write_features
    from scripts.bundles.payload import seal_pm_runtime
    from scripts.build.agent import assemble
    from scripts.build.inputs import AgentInputs, RESOURCE_ENV, dependency_site

    extras = [extra for extra in args.extras.split(",") if extra]
    target = args.target
    names = ["uv", "python", "ffmpeg", "node", "npm", "ripgrep"]
    if args.managed_tools:
        from scripts.bundles.native import _bundle_package_names
        from pm.registry import get_package
        names = [name for name in _bundle_package_names() if get_package(name).missing_reason(target) is None]
    tools = out / "tools"
    manager_store = os.environ.get("HERMES_RUNTIME_DIR")
    os.environ["HERMES_RUNTIME_DIR"] = str(tools)
    try:
        prepare_tools(names, out=tools, target=target, cache=args.cache)
    finally:
        if manager_store is None:
            os.environ.pop("HERMES_RUNTIME_DIR", None)
        else:
            os.environ["HERMES_RUNTIME_DIR"] = manager_store
    from pm.lock import Facts
    from pm.registry import get_package
    facts = Facts(tools / "facts.json", strict=True)
    python_fact = facts.get("python")
    python = get_package("python").binary(tools / python_fact["entry"], target)
    if python is None or not python.is_file() or not python.resolve().is_relative_to(out):
        raise ValueError("PM did not stage a self-contained pinned Python interpreter")
    environment = out / "venv"
    build_environment(source=source, out=environment, python=python, cache=args.cache,
                      extras=extras, env=dict(os.environ), frozen=True, sealed=True,
                      explicit=True, timeout=2 * 60 * 60)
    site = dependency_site(environment, python_fact["version"], target)
    base_site = Path(subprocess.check_output([str(python), "-I", "-B", "-c",
                    "import sysconfig; print(sysconfig.get_paths()['purelib'])"], text=True).strip())
    if not base_site.resolve().is_relative_to(out):
        raise ValueError("Pinned Python's site-packages escaped the distribution")
    base_site.mkdir(parents=True, exist_ok=True)
    relative_root = Path(os.path.relpath(out, base_site)).as_posix()
    relative_site = site.relative_to(out).as_posix()
    # Desktop's explicit interpreter runs python -m hermes_cli. Bind this to
    # the same sealed environment as the original assembler's CLI launchers.
    audio_bootstrap = ""
    if target.startswith("win32"):
        # sounddevice uses the native host's platform.machine() under Windows
        # emulation, while the wheel contains the interpreter's own ABI. Its
        # normal ctypes lookup accepts an explicit package-owned DLL on PATH.
        suffix = "arm64" if target.endswith("arm64") else "64bit"
        for variant, ending in (("default", ""), ("asio", "-asio")):
            library = site / f"_sounddevice_data/portaudio-binaries/libportaudio{suffix}{ending}.dll"
            if library.is_file():
                destination = python.parent / "sshs3-audio" / variant
                destination.mkdir(parents=True, exist_ok=True)
                shutil.copy2(library, destination / "portaudio.dll")
        audio_bootstrap = (
            f"_audio = _root / {python.parent.relative_to(out).as_posix()!r} / 'sshs3-audio' / ('asio' if 'SD_ENABLE_ASIO' in os.environ else 'default')\n"
            "if _audio.is_dir(): os.environ['PATH'] = str(_audio) + os.pathsep + os.environ.get('PATH', '')\n"
        )
    (base_site / "sitecustomize.py").write_text(
        "import os, site, sys\nfrom pathlib import Path\n"
        f"_root = (Path(__file__).resolve().parent / {relative_root!r}).resolve()\n"
        f"site.addsitedir(str(_root / {relative_site!r}))\n"
        "sys.path.insert(0, str(_root / 'hermes-agent'))\n" + audio_bootstrap, encoding="utf-8")
    stage_manager_runtime(python=python, destination=out / "pm-runtime", project=source / "pm", cache=args.cache)
    # Windows' executable scanner can briefly retain the newly checked redirector
    # after PM's verification process exits. Retry only this observed sharing hold.
    for attempt in range(6):
        try:
            seal_pm_runtime(out, python)
            break
        except PermissionError:
            if os.name != "nt" or attempt == 5:
                raise
            time.sleep(0.25 * (2 ** attempt))
    features = installed_extras(source, environment, python_exe=python)
    feature_file = write_features(features, out)
    from pm.store import current_target
    if current_target() == target:
        from pm.packages import Venv
        Facts(tools / "facts.json", strict=True).record_state(
            "venv", Venv(source).expected_stamp(features, plugin_dirs=[]), features)
    stamp = {
        "schemaVersion": 1, "commit": args.commit, "branch": None,
        "dirty": True, "source": "local", "distribution": "sshs3",
        "updateMechanism": "external", "baseVersion": args.desktop_version,
        "displayVersion": f"{args.desktop_version} (sshs3)", "payload": "bundled", "tag": None,
    }
    stamp_file = source / "install-stamp.json"
    stamp_file.write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
    inputs = AgentInputs(project=source / "pyproject.toml", code=source, repo="hermes-agent",
                         placement="contained", target=target, python=python,
                         site_packages=site, environment=environment, tools=tools,
                         pm_runtime=out / "pm-runtime", ref=args.commit,
                         resources={name: source / name for name in RESOURCE_ENV},
                         stamp=stamp_file, features=feature_file)
    manifest = assemble(inputs, out)
    manifest["requestedExtras"] = extras
    manifest["managedTools"] = names
    manifest["nativeBuildTarget"] = current_target()
    # The interpreter now contains the package-owned portable bootstrap; record
    # its final bytes as upstream's native payload builder does before signing.
    Facts(tools / "facts.json", strict=True).refresh_digests(tools)
    # After assembly the declared payload ABI is available. The resolver now
    # binds the expected venv stamp to the same Python/wheels we actually built.
    if current_target() == target:
        from pm.packages import Venv
        Facts(tools / "facts.json", strict=True).record_state(
            "venv", Venv(source).expected_stamp(features, plugin_dirs=[]), features)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
