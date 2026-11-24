; Remove the tray monitor's logon task on a real uninstall (not when an update replaces the app).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /Delete /TN "smartDisk Monitor" /F'
  ${endIf}
!macroend
