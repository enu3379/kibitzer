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

a = Analysis(
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
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="kibitzer",
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
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="kibitzer",
)
