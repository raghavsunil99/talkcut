; The speech engine (whisper.cpp) needs Microsoft's Visual C++ runtime. Most PCs have it;
; when this one doesn't, install it quietly (Windows asks once for permission).
!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 != 1
    DetailPrint "Installing the Microsoft Visual C++ runtime..."
    ExecShellWait "runas" "$INSTDIR\resources\vc_redist.x64.exe" "/install /quiet /norestart"
  ${EndIf}
  SetRegView lastused
!macroend
