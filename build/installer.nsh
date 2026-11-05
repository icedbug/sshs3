; Custom NSIS script for sshs3 Windows installer
; Configures Windows Firewall for bundled X Server during installation

!macro customInstall
  ; SECURITY: scoped to Private/Domain networks only (never "any", which
  ; includes Public networks such as open/hotel/coffee-shop Wi-Fi). SSH X11
  ; forwarding never needs this X server to be reachable from another
  ; machine at all -- ssh itself talks to it over loopback -- so this rule
  ; is defense-in-depth only, in case a locally-installed firewall product
  ; treats the loopback interface as covered by the active network profile.
  ; It must never be widened back to profile=any.
  DetailPrint "Configuring Windows Firewall for sshs3 X Server..."
  nsExec::Exec 'netsh advfirewall firewall add rule name="sshs3 X Server" dir=in action=allow program="$INSTDIR\resources\vcxsrv\vcxsrv.exe" enable=yes profile=private,domain'

  ; Enables the built-in Windows OpenSSH Authentication Agent service, which is
  ; disabled by default on Windows. Only needed for smartcard "Once Per Terminal
  ; Connection" / "Global" PIN caching modes (Win32-OpenSSH's ssh-agent.exe can
  ; only run as this single system service, never as a per-app private agent —
  ; see the user guide's Windows page, docs.sshs3.com/docs/windows/). Everything else,
  ; including "Always Prompt" mode, works without it, so this is best-effort:
  ; failure (declined UAC prompt, OpenSSH Client feature not installed, locked
  ; -down group policy, ...) is silently ignored rather than blocking install.
  ;
  ; The installer is per-user (not elevated), and changing a service needs
  ; admin rights, so a plain `sc config` here silently failed. Elevate just
  ; this one step through a UAC prompt instead. Startup type is Automatic so
  ; the agent is also running after a reboot (Manual left it stopped, which is
  ; what caused "Startup unlock failed" on the next launch). Skipped for silent
  ; installs/auto-updates so they never pop a UAC dialog.
  IfSilent skipAgentService
  DetailPrint "Enabling Windows OpenSSH Authentication Agent service..."
  ExecShellWait "runas" "powershell.exe" "-NoProfile -WindowStyle Hidden -Command $\"Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent$\"" SW_HIDE
  skipAgentService:
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule for sshs3 X Server..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="sshs3 X Server"'
!macroend
