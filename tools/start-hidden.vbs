' Legacy shortcut entry — delegates to launch-cqr.ps1 (path-safe).
If WScript.Arguments.Count < 1 Then WScript.Quit 1
root = WScript.Arguments(0)
If Right(root, 1) <> "\" Then root = root & "\"
ps1 = root & "tools\launch-cqr.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & ps1 & """ -Root """ & Left(root, Len(root) - 1) & """"
CreateObject("Wscript.Shell").Run cmd, 0, False
