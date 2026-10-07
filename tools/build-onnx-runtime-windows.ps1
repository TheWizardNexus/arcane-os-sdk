<#
SDK-producer recipe for the corrected Microsoft ONNX Runtime 1.30.0 engine.
Supply the extracted upstream v1.30.0 source and an owned build directory.
Use a short path for BuildRoot (an existing drive mapping to the owned project
directory is suitable); MSBuild intermediate files still have Windows path
limits. DawnSourceRoot can reuse the already acquired pinned Dawn source.
Supply DxcRuntimeDirectory from the official onnxruntime-node 1.30.0 Windows
x64 distribution and DxcImportLibrary from the selected Windows SDK.
The upstream build acquires its pinned native dependency tree. End users
receive the resulting native distribution through the SDK installer.
#>
param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$PythonPath,
    [Parameter(Mandatory = $true)][string]$DxcRuntimeDirectory,
    [Parameter(Mandatory = $true)][string]$DxcImportLibrary,
    [string]$DawnSourceRoot,
    [string]$CMakePath = 'cmake',
    [string]$PatchPath = 'patch',
    [string]$MsvcToolset = '14.44.35207',
    [string]$WindowsSdkVersion = '10.0.26100.0',
    [int]$Parallel = 4
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = (Resolve-Path -LiteralPath $SourceRoot).Path
$buildDirectory = [System.IO.Path]::GetFullPath($BuildRoot)
$pythonExecutable = (Get-Command $PythonPath -ErrorAction Stop).Source
$cmakeExecutable = (Get-Command $CMakePath -ErrorAction Stop).Source
$patchExecutable = (Get-Command $PatchPath -ErrorAction Stop).Source
$patchFile = Join-Path $PSScriptRoot 'patches/onnxruntime-1.30.0-directml-reshape.patch'
$dawnPatchFile = Join-Path $PSScriptRoot 'patches/dawn-v20260818.211311-prebuilt-dxc.patch'
$dxcDirectory = (Resolve-Path -LiteralPath $DxcRuntimeDirectory).Path
$dxcLibrary = (Resolve-Path -LiteralPath $DxcImportLibrary).Path
$dawnDirectory = if ($DawnSourceRoot) { (Resolve-Path -LiteralPath $DawnSourceRoot).Path } else { $null }
$sourceVersion = (Get-Content -Raw -LiteralPath (Join-Path $sourceDirectory 'VERSION_NUMBER')).Trim()
if ($sourceVersion -ne '1.30.0') {
    throw "This recipe applies the ONNX Runtime 1.30.0 DirectML correction; received $sourceVersion."
}
[System.IO.Directory]::CreateDirectory($buildDirectory) | Out-Null
$temporaryDirectory = Join-Path $buildDirectory 'tmp'
[System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
$attempt = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
$logFile = Join-Path $buildDirectory "build-$attempt.log"
$recordFile = Join-Path $buildDirectory "build-$attempt.json"
$buildArguments = @(
    '-S', (Join-Path $sourceDirectory 'tools/ci_build/build.py'),
    '--build_dir', $buildDirectory,
    '--config', 'RelWithDebInfo',
    '--cmake_generator', 'Visual Studio 17 2022',
    '--cmake_path', $cmakeExecutable,
    '--msvc_toolset', $MsvcToolset,
    '--windows_sdk_version', $WindowsSdkVersion,
    '--build_shared_lib', '--enable_generic_interface', '--enable_wcos',
    '--use_dml', '--use_webgpu', '--enable_lto',
    '--update', '--build', '--skip_submodule_sync', '--skip_tests', '--skip_pip_install',
    '--disable_memleak_checker', '--target', 'onnxruntime', '--parallel', [string]$Parallel,
    '--cmake_extra_defines', 'onnxruntime_BUILD_UNIT_TESTS=OFF',
    "Python3_EXECUTABLE=$pythonExecutable", "Patch_EXECUTABLE=$patchExecutable",
    "DAWN_DXC_RUNTIME_DIR=$dxcDirectory", "DAWN_DXC_IMPORT_LIBRARY=$dxcLibrary"
)
$gitConfigIndex = if ($env:GIT_CONFIG_COUNT) { [int]$env:GIT_CONFIG_COUNT } else { 0 }
$environment = [ordered]@{
    TEMP = $temporaryDirectory
    TMP = $temporaryDirectory
    PYTHONNOUSERSITE = '1'
    PYTHONUTF8 = '1'
    GIT_CEILING_DIRECTORIES = (Split-Path -Parent $sourceDirectory)
    GIT_CONFIG_COUNT = [string]($gitConfigIndex + 1)
}
$environment["GIT_CONFIG_KEY_$gitConfigIndex"] = 'core.longpaths'
$environment["GIT_CONFIG_VALUE_$gitConfigIndex"] = 'true'
$previousEnvironment = @{}
$record = [ordered]@{
    sourceVersion = $sourceVersion
    nativeDistributionRevision = '1.30.0-directml-reshape-1'
    platform = 'windows-x64'
    sourceDirectory = $sourceDirectory
    buildDirectory = $buildDirectory
    executable = $pythonExecutable
    arguments = $buildArguments
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    log = $logFile
    status = 'running'
}
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordFile -Encoding utf8
Write-Output "Building the selected Windows x64 ONNX Runtime with CPU, DirectML and WebGPU. Complete log: $logFile"
Push-Location -LiteralPath $sourceDirectory
try {
    # Determine whether this exact source correction is already applied. The
    # dry run leaves source untouched before selecting the required operation.
    & $patchExecutable --batch --dry-run --forward -p1 --input $patchFile 2>&1 | Tee-Object -FilePath $logFile
    if ($LASTEXITCODE -eq 0) {
        & $patchExecutable --batch --forward -p1 --input $patchFile 2>&1 | Tee-Object -FilePath $logFile -Append
        if ($LASTEXITCODE -ne 0) { throw 'Applying the DirectML source correction failed.' }
    } else {
        & $patchExecutable --batch --dry-run --reverse -p1 --input $patchFile 2>&1 | Tee-Object -FilePath $logFile -Append
        if ($LASTEXITCODE -ne 0) { throw 'The selected source cannot apply or recognize the DirectML correction.' }
    }
    if (!$dawnDirectory) {
        # Prepare this pinned dependency before configuring so its diagnostic
        # cannot copy the producer's credential environment into the build log.
        $dawnDependency = Get-Content -LiteralPath (Join-Path $sourceDirectory 'cmake/deps.txt') |
            Where-Object { $_.StartsWith('dawn;') }
        $dawnUrl = $dawnDependency.Split(';')[1]
        $dependencyDirectory = Join-Path $buildDirectory 'dependencies'
        [System.IO.Directory]::CreateDirectory($dependencyDirectory) | Out-Null
        $dawnArchive = Join-Path $dependencyDirectory 'dawn-v20260818.211311.zip'
        if (!(Test-Path -LiteralPath $dawnArchive)) {
            $downloadAttempt = Join-Path $dependencyDirectory "dawn-$attempt.zip.partial"
            Invoke-WebRequest -Uri $dawnUrl -OutFile $downloadAttempt
            Move-Item -LiteralPath $downloadAttempt -Destination $dawnArchive
        }
        $dawnDirectory = Join-Path $dependencyDirectory 'dawn'
        if (!(Test-Path -LiteralPath $dawnDirectory)) {
            $extractionAttempt = Join-Path $dependencyDirectory "dawn-$attempt"
            $archive = [System.IO.Compression.ZipFile]::OpenRead($dawnArchive)
            try { $extractedDirectory = Join-Path $extractionAttempt $archive.Entries[0].FullName.Split('/')[0] }
            finally { $archive.Dispose() }
            [System.IO.Compression.ZipFile]::ExtractToDirectory($dawnArchive, $extractionAttempt)
            # Only move this completed attempt within the selected build tree.
            $ownedRoot = [System.IO.Path]::GetFullPath($dependencyDirectory) + [System.IO.Path]::DirectorySeparatorChar
            foreach ($movePath in @($extractedDirectory, $dawnDirectory)) {
                if (![System.IO.Path]::GetFullPath($movePath).StartsWith($ownedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw 'The generated source move leaves the selected build directory.'
                }
            }
            Move-Item -LiteralPath $extractedDirectory -Destination $dawnDirectory
        }
    }
    & $patchExecutable --directory $dawnDirectory --batch --dry-run --forward -p1 --input $dawnPatchFile 2>&1 | Tee-Object -FilePath $logFile -Append
    if ($LASTEXITCODE -eq 0) {
        & $patchExecutable --directory $dawnDirectory --batch --forward -p1 --input $dawnPatchFile 2>&1 | Tee-Object -FilePath $logFile -Append
        if ($LASTEXITCODE -ne 0) { throw 'Preparing the existing DXC companion linkage failed.' }
    } else {
        & $patchExecutable --directory $dawnDirectory --batch --dry-run --reverse -p1 --input $dawnPatchFile 2>&1 | Tee-Object -FilePath $logFile -Append
        if ($LASTEXITCODE -ne 0) { throw 'The selected Dawn source cannot apply or recognize the DXC companion linkage.' }
    }
    $sdkCopyScript = Join-Path $dawnDirectory 'third_party/CopyWindowsSDKDLL.cmake'
    $sdkCopySource = [System.IO.File]::ReadAllText($sdkCopyScript)
    $sdkCopySource = $sdkCopySource.Replace('    message(STATUS "Display environment variables:")', '')
    $sdkCopySource = $sdkCopySource.Replace('    execute_process(COMMAND ${CMAKE_COMMAND} -E environment COMMAND_ECHO STDOUT)', '')
    [System.IO.File]::WriteAllText($sdkCopyScript, $sdkCopySource, [System.Text.UTF8Encoding]::new($false))
    $buildArguments += "FETCHCONTENT_SOURCE_DIR_DAWN=$dawnDirectory"
    $record.arguments = $buildArguments
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordFile -Encoding utf8
    foreach ($entry in $environment.GetEnumerator()) {
        $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    & $pythonExecutable @buildArguments 2>&1 | Tee-Object -FilePath $logFile -Append
    $record.exitCode = $LASTEXITCODE
    if ($record.exitCode -ne 0) { throw "ONNX Runtime configure/build exited $($record.exitCode)." }
    $record.status = 'completed'
} catch {
    $record.status = 'failed'
    $record.error = $_.ToString()
    $_ | Out-String | Add-Content -LiteralPath $logFile -Encoding utf8
    throw
} finally {
    foreach ($entry in $previousEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    Pop-Location
    $record.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordFile -Encoding utf8
}
Write-Output "ONNX Runtime build completed. Output: $buildDirectory/RelWithDebInfo/RelWithDebInfo; record: $recordFile"
