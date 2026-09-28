Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like '*chrome_automation\deepsea*' } | ForEach-Object {
  $type = 'browser'; if ($_.CommandLine -match '--type=(\S+)') { $type = $Matches[1] }
  '{0,-16} {1,6} MB (private {2,6} MB)' -f $type, [int]($_.WorkingSetSize/1MB), [int]((Get-Process -Id $_.ProcessId).PrivateMemorySize64/1MB)
}
