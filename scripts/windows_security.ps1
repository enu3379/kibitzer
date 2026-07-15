function Protect-KibitzerPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Directory
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($Directory) {
    $Acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit `
      -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $Identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $Inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  }
  else {
    $Acl = [System.Security.AccessControl.FileSecurity]::new()
    $Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $Identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  }

  $Acl.SetOwner($Identity)
  $Acl.SetAccessRuleProtection($true, $false)
  [void]$Acl.AddAccessRule($Rule)
  Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Protect-KibitzerSecrets {
  param([Parameter(Mandatory = $true)][string]$Root)

  Protect-KibitzerPath -Path (Join-Path $Root "data") -Directory
  Protect-KibitzerPath -Path (Join-Path $Root ".env")
  Protect-KibitzerPath -Path (Join-Path $Root "configs\models.local.yaml")
}
