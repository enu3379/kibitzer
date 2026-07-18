# Windows launch notification follow-up — 2026-07-18

## Outcome

Manual `Kibitzer.exe` launches now provide a visible acknowledgement on Windows,
including when the tray is already running. Login autostart remains quiet. The
packaged app uses a modern WinRT toast under the stable `Kibitzer.Tray`
AppUserModelID and falls back to a topmost native status message when Windows is
suppressing ordinary toast banners or WinRT delivery fails.

This is a follow-up to the tray/server lifecycle introduced in PR #105. It does
not change server ownership, the candidate-port protocol, or `idle`/`active`
state transitions.

## Root cause

Both the first-launch and duplicate-launch paths used
`pystray.Icon.notify()`. On Windows, pystray 0.19.5 implements that method with
the legacy `Shell_NotifyIcon(NIM_MODIFY, NIF_INFO)` balloon API rather than the
WinRT toast platform. Its wrapper also discards the API's Boolean return value,
so a rejected or suppressed balloon leaves no actionable error in the tray log.

The affected QA device had global toast delivery enabled and no Kibitzer block
policy, but WinRT reported the current user notification mode as
`PRIORITY_ONLY`. Windows stores an ordinary app toast in notification history in
that mode while suppressing its banner. The duplicate-instance attention file
was consumed correctly, so the single-instance protocol was not the failure.

Microsoft references:

- [ToastNotificationMode values](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmode?view=winrt-26100)
- [ToastNotificationManagerForUser.NotificationMode](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanagerforuser.notificationmode?view=winrt-26100)
- [Desktop toast identity through an AppUserModelID](https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid)

## Delivery contract

`WindowsToastNotifier` owns the Windows notification transport:

1. Register `HKCU\Software\Classes\AppUserModelId\Kibitzer.Tray` with the
   Kibitzer display name and bundled icon.
2. Set the process AppUserModelID and create a WinRT notifier through
   `windows-toasts`/PyWinRT.
3. Queue the title and status text as a modern toast.
4. Read `ToastNotificationManager.get_default().notification_mode`.
5. Report that a banner is expected only in unrestricted mode.

A newly registered unpackaged AUMID can return `ERROR_ELEMENT_NOT_FOUND` when
its notification setting is read before its first toast. That setting is
treated as uninitialized, not disabled, so the first toast is allowed to create
the per-app notification record.

For manual startup, duplicate launch, and lifecycle failures, a false delivery
result also opens an asynchronous topmost `MessageBoxW`. The toast remains in
notification history, while the fallback provides immediate feedback in
Priority-only/Alarms-only modes. Routine login autostart and automatic
`idle`/`active` changes never open the fallback.

WinRT can report delivery failure after `show_toast()` has returned. The
failure event therefore calls the same one-shot fallback directly instead of
being sampled through a fixed delay. Synchronous failure, suppressed-banner
mode, and a later WinRT failure can race safely without opening duplicate
fallback windows.

A duplicate manual launch writes an instance-scoped request with a unique
`request_id` and waits up to three seconds for the existing tray to write a
matching acknowledgement. This exceeds the tray's two-second poll interval.
If the old tray is already shutting down, or otherwise never acknowledges the
request, the duplicate process shows its own topmost status message instead of
exiting silently. Login `--autostart` remains silent.

## Packaging and installation

- The `package` and `windows` extras include `windows-toasts>=1.3.1,<2`.
- The PyInstaller tray analysis explicitly includes the Windows-Toasts and
  PyWinRT notification modules.
- `windows_install_startup_app.ps1` registers `Kibitzer.Tray`, its display name,
  and the correct packaged or development icon path.
- `windows_uninstall_startup_app.ps1` removes that current-user registration.
- Startup and uninstall cleanup remove stale attention request and
  acknowledgement files.
- `scripts/__init__.py` makes repository `scripts.*` imports deterministic;
  Windows-Toasts also installs a generic top-level `scripts` package.

The installed Startup shortcut remains:

```text
Target:    dist\kibitzer\Kibitzer.exe
Arguments: --autostart
```

## Windows QA evidence

Validated on Windows 11 with notification mode `PRIORITY_ONLY`:

- Source notifier registered `Kibitzer.Tray`, queued a toast, created the
  per-app notification settings entry, and left one item in notification
  history.
- First packaged manual launch produced one tray and one packaged server,
  logged `Kibitzer started`, and opened the topmost fallback window.
- A second packaged launch preserved the original tray PID and instance ID,
  consumed the attention request, kept tray/server counts at one each, logged
  `Kibitzer is already running`, and opened the corresponding fallback.
- A duplicate `--autostart` launch left both the toast timestamp and queued-toast
  log count unchanged.
- The installed shortcut targets the rebuilt executable with `--autostart`; its
  registered icon path exists.
- QA-only popup windows and temporary test AUMIDs were removed afterward. The
  rebuilt tray and its server were left running.

Validation gates:

```text
Server:      297 passed, 6 skipped, 40 subtests passed
Extension:   45 passed; TypeScript check and bundle build passed
Packaging:   PyInstaller onedir build passed
Smoke:       packaged tray dependency smoke and server lifecycle smoke passed
Static:      git diff --check and PowerShell parser checks passed
```

## Reproduction

```powershell
python -m pip install -e ".[test,package]"
python -m pytest apps/server/tests -q
npm.cmd --prefix apps\extension run build
python -m PyInstaller --clean --noconfirm packaging/kibitzer.spec
python scripts/smoke_packaged_server.py --dist-dir dist/kibitzer
.\scripts\windows_install_startup_app.ps1
```

For interactive QA, exit the existing tray, start `dist\kibitzer\Kibitzer.exe`
without arguments, and then start it a second time. Use `--autostart` only for
the quiet login path.
