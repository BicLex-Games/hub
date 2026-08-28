!macro NSIS_HOOK_POSTINSTALL
  ; WebView2Loader.dll is required beside the main executable on Windows.
  CopyFiles /SILENT "$INSTDIR\resources\WebView2Loader.dll" "$INSTDIR"
  Delete "$INSTDIR\resources\WebView2Loader.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\WebView2Loader.dll"
!macroend
