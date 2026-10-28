; Included by electron-builder (build/installer.nsh).
; Registers PDF Reader under Default Apps and, on an interactive first
; install, offers to open the Settings page where it can be made the
; default PDF app. Windows 10/11 do not let an installer set the default
; itself; silent installs (/S) never prompt, so IT can use the GPO in DEPLOY.md.

!define CAPS_KEY "Software\PDF Reader\Capabilities"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${CAPS_KEY}" "ApplicationName" "PDF Reader"
  WriteRegStr SHELL_CONTEXT "${CAPS_KEY}" "ApplicationDescription" "อ่าน แก้ไข และเซ็นเอกสาร PDF"
  WriteRegStr SHELL_CONTEXT "${CAPS_KEY}" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  ; ProgID written by electron-builder from fileAssociations[0].name.
  WriteRegStr SHELL_CONTEXT "${CAPS_KEY}\FileAssociations" ".pdf" "PDF Document"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "PDF Reader" "${CAPS_KEY}"
  ; SHCNE_ASSOCCHANGED: refresh Explorer's association cache.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ${ifNot} ${Silent}
  ${andIfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "ต้องการตั้ง PDF Reader เป็นโปรแกรมเริ่มต้นสำหรับเปิดไฟล์ PDF หรือไม่$\r$\n$\r$\nถ้าเลือก Yes จะเปิดหน้า Settings ของ Windows ให้คลิกช่องใต้ .pdf แล้วเลือก PDF Reader และกด Set default" /SD IDNO IDNO skipDefaultApp
      ${if} $installMode == "all"
        ExecShell "open" "ms-settings:defaultapps?registeredAppMachine=PDF%20Reader"
      ${else}
        ExecShell "open" "ms-settings:defaultapps?registeredAppUser=PDF%20Reader"
      ${endIf}
    skipDefaultApp:
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "PDF Reader"
    DeleteRegKey SHELL_CONTEXT "Software\PDF Reader"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
