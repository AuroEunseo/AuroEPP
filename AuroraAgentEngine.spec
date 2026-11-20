# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['C:/Users/김은서/Desktop/Project_etc/PC_Agent/agent/service.py'],
    pathex=['C:/Users/김은서/Desktop/Project_etc/PC_Agent/agent'],
    binaries=[],
    datas=[('C:/Users/김은서/Desktop/Project_etc/PC_Agent/agent/worker.py', '.')],
    hiddenimports=['worker', 'win32timezone', 'acl', 'win32security'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='AuroraAgentEngine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='AuroraAgentEngine',
)
