import sys
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent
CONFIG_DIR = ROOT / "configs"

datas = [
    (str(CONFIG_DIR / "default.yaml"), "configs"),
    (str(CONFIG_DIR / "personas.yaml"), "configs"),
    (str(CONFIG_DIR / "sensitive_domains.json"), "configs"),
    (
        str(ROOT / "apps" / "server" / "app" / "port-candidates.json"),
        "apps/server/app",
    ),
    (
        str(
            ROOT
            / "apps"
            / "extension"
            / "icons"
            / "variants"
            / "monitor-v1-mono-128.png"
        ),
        "icons",
    ),
]

persona_fragments = CONFIG_DIR / "personas"
if persona_fragments.is_dir():
    datas.append((str(persona_fragments), "configs/personas"))

hidden_imports = [
    "apps.server.app.main",
    "uvicorn.lifespan.off",
    "uvicorn.lifespan.on",
    "uvicorn.logging",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
]

server_analysis = Analysis(
    [str(ROOT / "packaging" / "kibitzer_entry.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "pytest_asyncio"],
    noarchive=False,
    optimize=0,
)
server_pyz = PYZ(server_analysis.pure)

server_exe = EXE(
    server_pyz,
    server_analysis.scripts,
    [],
    exclude_binaries=True,
    name="kibitzer-server" if sys.platform == "win32" else "kibitzer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    contents_directory="_internal",
)

if sys.platform == "win32":
    tray_analysis = Analysis(
        [str(ROOT / "packaging" / "windows_tray_entry.py")],
        pathex=[str(ROOT)],
        binaries=[],
        datas=datas,
        hiddenimports=[
            *hidden_imports,
            "PIL.Image",
            "PIL.ImageDraw",
            "pystray._win32",
        ],
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=["pytest", "pytest_asyncio"],
        noarchive=False,
        optimize=0,
    )
    tray_pyz = PYZ(tray_analysis.pure)
    tray_exe = EXE(
        tray_pyz,
        tray_analysis.scripts,
        [],
        exclude_binaries=True,
        name="Kibitzer",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        contents_directory="_internal",
    )
    coll = COLLECT(
        tray_exe,
        server_exe,
        tray_analysis.binaries,
        tray_analysis.datas,
        server_analysis.binaries,
        server_analysis.datas,
        strip=False,
        upx=False,
        name="kibitzer",
    )
else:
    coll = COLLECT(
        server_exe,
        server_analysis.binaries,
        server_analysis.datas,
        strip=False,
        upx=False,
        name="kibitzer",
    )
