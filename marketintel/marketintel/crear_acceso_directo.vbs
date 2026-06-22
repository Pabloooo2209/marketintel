Set oWS = WScript.CreateObject("WScript.Shell")
sLinkFile = oWS.SpecialFolders("Desktop") & "\MarketIntel.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)

' Get current directory
Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
Dim currentDir
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

oLink.TargetPath = currentDir & "\INICIAR.bat"
oLink.WorkingDirectory = currentDir
oLink.IconLocation = currentDir & "\icon.ico"
oLink.Description = "MarketIntel - Indicadores y Screener"
oLink.WindowStyle = 1
oLink.Save

MsgBox "Acceso directo 'MarketIntel' creado en el escritorio con ícono!", vbInformation, "MarketIntel"
