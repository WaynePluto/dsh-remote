; DSH 工作站 Windows 安装包（NSIS）。
; 由 scripts/pack-desktop.mjs 填充 {{OUTPUT}}（产物路径）与 {{INSTALL}}（待安装目录）后调用 makensis。
; 安装到 Program Files\dsh-station，创建开始菜单/桌面快捷方式与卸载项；
; 用户数据在 ~/.dsh-station 与 ~/.dsh，卸载不触碰。
Unicode true
ManifestDPIAware true

!define APPNAME "DSH 工作站"
!define APPID "dsh-station"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\dsh-station"

Name "${APPNAME}"
OutFile "{{OUTPUT}}"
InstallDir "$PROGRAMFILES64\${APPID}"
RequestExecutionLevel admin
SetCompress off

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "install"
  SetOutPath $INSTDIR
  File /r "{{INSTALL}}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\dsh-station.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\dsh-station.exe"

  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "{{VERSION}}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "dsh-station"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "uninstall"
  RMDir /r $INSTDIR
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKLM "${UNINSTKEY}"
SectionEnd
