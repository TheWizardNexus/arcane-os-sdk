<#
Build one explicitly selected Windows x64 Kokoro helper component from prepared
upstream sources. SourceRoot contains espeak-ng at
ed530aa113046142eb5115cf2fc9157854d0ffe1, opus 1.6.1 and libopusenc 0.3.
This recipe acquires nothing and invokes no tests, model inference or playback.

Run espeak, opus and opusenc independently (they may run concurrently), then
helper, then stage, using the same OutputDirectory. Each invocation owns only
its component's build directory and unique logs. Do not run the same component
twice concurrently. The caller owns the selected output and its cleanup.

Use an existing short path to the approved project directory when MSBuild's
path limits require it; this recipe creates no drive mapping. OutputDirectory
must be a subdirectory of ProjectDirectory. Stage contains bin/, the complete
share/espeak-ng-data/, licenses/ and corresponding-source/. Distribute that
complete stage together; model weights and voices remain separately acquired.
#>
param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [ValidateSet('espeak', 'opus', 'opusenc', 'helper', 'stage')][string]$Component,
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$HelperSourceDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/local-ai/kokoro/native'),
    [string]$CMakePath = 'C:\Program Files\CMake\bin\cmake.exe',
    [string]$MSBuildPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe',
    [string]$MsvcToolset = '14.44.35207',
    [string]$WindowsSdkVersion = '10.0.26100.0',
    [int]$Parallel = 2
)

$ErrorActionPreference = 'Stop'
Write-Output "Preparing selected Kokoro $Component operation in $OutputDirectory."
$sdkDirectory = Split-Path -Parent $PSScriptRoot
$sourceDirectory = (Resolve-Path -LiteralPath $SourceRoot).Path
$projectDirectory = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$projectPrefix = $projectDirectory.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (!$outputRoot.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be inside the caller-selected approved ProjectDirectory.'
}
$sourcePrefix = $sourceDirectory.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if ($outputRoot -eq $sourceDirectory -or $outputRoot.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a separate output directory so generated output is not copied back into the prepared source tree.'
}
$helperSource = (Resolve-Path -LiteralPath $HelperSourceDirectory).Path
$buildDirectory = Join-Path $outputRoot 'build'
$stageDirectory = Join-Path $outputRoot 'stage'
$attempt = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
$logDirectory = Join-Path $outputRoot "logs/$Component-$attempt"
$temporaryDirectory = Join-Path $outputRoot "tmp/$Component-$attempt"
New-Item -ItemType Directory -Path $buildDirectory, $logDirectory, $temporaryDirectory -Force | Out-Null
$recordPath = Join-Path $logDirectory 'result.json'
$record = [ordered]@{
    component = $Component
    platform = 'windows-x64'
    sourceDirectory = $sourceDirectory
    outputDirectory = $outputRoot
    selectedSources = [ordered]@{
        espeak = 'ed530aa113046142eb5115cf2fc9157854d0ffe1'
        opus = '1.6.1'
        opusenc = '0.3'
    }
    selectedToolset = $MsvcToolset
    selectedWindowsSdk = $WindowsSdkVersion
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    status = 'running'
    commands = @()
}
$previousEnvironment = @{}
$environment = @{
    TEMP = $temporaryDirectory
    TMP = $temporaryDirectory
    # Archive sources must not derive their version from the containing SDK Git repository.
    GIT_CEILING_DIRECTORIES = $sourceDirectory + ';' + $buildDirectory
}

function Save-ProducerRecord {
    $record | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $recordPath -Encoding utf8
}

function Invoke-Producer([string]$Phase, [string]$Executable, [string[]]$Arguments) {
    $command = (Get-Command $Executable -ErrorAction Stop).Source
    $log = Join-Path $logDirectory "$Phase.log"
    $entry = [ordered]@{
        phase = $Phase
        executable = $command
        arguments = $Arguments
        startedAt = [DateTimeOffset]::UtcNow.ToString('o')
        log = $log
        exitCode = $null
    }
    $record.commands += ,$entry
    Save-ProducerRecord
    Write-Output "Kokoro $Component $Phase starting. Complete output: $log"
    $savedErrorAction = $ErrorActionPreference
    try {
        # Windows PowerShell presents native stderr as ErrorRecords. Preserve
        # those lines and determine native success from the actual exit code.
        $ErrorActionPreference = 'Continue'
        & $command @Arguments 2>&1 | Tee-Object -FilePath $log -ErrorAction Stop
        $entry.exitCode = $LASTEXITCODE
    } catch {
        $entry.error = $_.Exception.ToString()
        throw
    } finally {
        $ErrorActionPreference = $savedErrorAction
        $entry.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Save-ProducerRecord
    }
    if ($entry.exitCode -ne 0) {
        throw "Kokoro $Component $Phase exited $($entry.exitCode). Complete output: $log"
    }
    Write-Output "Kokoro $Component $Phase completed."
}

function Copy-SourceTree([string]$Source, [string]$Destination, [string]$Relative = '') {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        $relativeName = if ($Relative) { $Relative + '/' + $item.Name } else { $item.Name }
        # These are upstream version-control metadata and the observed MSBuild
        # output directories, not source, language data or license exclusions.
        if ($item.PSIsContainer -and $relativeName -in @(
            '.git', 'win32/VS2015/x64', 'win32/VS2015/Win32', 'win32/VS2015/.vs'
        )) { continue }
        $destinationPath = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) {
            Copy-SourceTree $item.FullName $destinationPath $relativeName
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination $destinationPath -Force
        }
    }
}

$espeakSource = Join-Path $sourceDirectory 'espeak-ng'
$opusSource = Join-Path $sourceDirectory 'opus'
$opusencSource = Join-Path $sourceDirectory 'libopusenc'
$opusencWorkingRoot = Join-Path $buildDirectory 'opusenc-source'
$opusencWorkingSource = Join-Path $opusencWorkingRoot 'libopusenc'
$espeakBuild = Join-Path $buildDirectory 'espeak'
$opusBuild = Join-Path $buildDirectory 'opus'
$opusencBuild = Join-Path $buildDirectory 'opusenc'
$helperBuild = Join-Path $buildDirectory 'helper'
$cmakeSelection = @(
    '-G', 'Visual Studio 17 2022', '-A', 'x64', '-T', "version=$MsvcToolset",
    "-DCMAKE_SYSTEM_VERSION=$WindowsSdkVersion"
)

Save-ProducerRecord
Write-Output "Preparing selected Kokoro $Component operation. Record: $recordPath"
try {
    foreach ($entry in $environment.GetEnumerator()) {
        $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    switch ($Component) {
        'espeak' {
            Invoke-Producer 'configure' $CMakePath (@('-S', $espeakSource, '-B', $espeakBuild) + $cmakeSelection + @(
                '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
                '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF', '-DBUILD_ESPEAK_NG_TESTS=OFF',
                '-DBUILD_ESPEAK_NG_EXE=ON', '-DESPEAK_BUILD_MANPAGES=OFF', '-DUSE_LIBSONIC=OFF',
                '-DUSE_LIBPCAUDIO=OFF', '-DUSE_ASYNC=OFF', '-DUSE_MBROLA=OFF', '-DUSE_KLATT=OFF',
                '-DUSE_SPEECHPLAYER=OFF', '-DESPEAK_COMPAT=OFF'
            ))
            # Upstream data owns the complete language/Unicode generation and its CLI dependency.
            Invoke-Producer 'build' $CMakePath @('--build', $espeakBuild, '--config', 'Release', '--target', 'data', '--parallel', [string]$Parallel)
        }
        'opus' {
            Invoke-Producer 'configure' $CMakePath (@('-S', $opusSource, '-B', $opusBuild) + $cmakeSelection + @(
                '-DBUILD_SHARED_LIBS=OFF', '-DOPUS_BUILD_SHARED_LIBRARY=OFF', '-DBUILD_TESTING=OFF',
                '-DOPUS_BUILD_TESTING=OFF', '-DOPUS_BUILD_PROGRAMS=OFF', '-DOPUS_STATIC_RUNTIME=ON',
                '-DOPUS_ENABLE_FLOAT_API=ON', '-DOPUS_FIXED_POINT=OFF', '-DOPUS_DRED=OFF',
                '-DOPUS_OSCE=OFF', '-DOPUS_DEEP_PLC=OFF', '-DOPUS_HARDENING=OFF', '-DOPUS_STACK_PROTECTOR=OFF'
            ))
            Invoke-Producer 'build' $CMakePath @('--build', $opusBuild, '--config', 'Release', '--target', 'opus', '--parallel', [string]$Parallel)
        }
        'opusenc' {
            Write-Output 'Preparing libopusenc source inside the selected output; upstream generates win32/version.h there.'
            Copy-SourceTree $opusencSource $opusencWorkingSource
            # The upstream project locates its public Opus headers at this sibling path.
            Copy-SourceTree (Join-Path $opusSource 'include') (Join-Path $opusencWorkingRoot 'opus/include')
            Invoke-Producer 'build' $MSBuildPath @(
                (Join-Path $opusencWorkingSource 'win32/VS2015/opusenc.vcxproj'), '/t:Build',
                '/p:Configuration=Release', '/p:Platform=x64', '/p:PlatformToolset=v143',
                "/p:VCToolsVersion=$MsvcToolset", "/p:WindowsTargetPlatformVersion=$WindowsSdkVersion",
                ('/p:OutDir=' + $opusencBuild + '/'), ('/p:IntDir=' + (Join-Path $opusencBuild 'obj') + '/'),
                '/p:MultiProcessorCompilation=false', "/m:$Parallel"
            )
        }
        'helper' {
            Invoke-Producer 'configure' $CMakePath (@('-S', $helperSource, '-B', $helperBuild) + $cmakeSelection + @(
                '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
                # This selected recipe links every component's static runtime.
                # Do not install unrelated DLLs discovered by CMake's generic module.
                '-DCMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_SKIP=TRUE',
                ('-DESPEAK_NG_INCLUDE_DIRECTORY=' + (Join-Path $espeakSource 'src/include')),
                ('-DESPEAK_NG_LIBRARY=' + (Join-Path $espeakBuild 'src/libespeak-ng/Release/espeak-ng.lib')),
                ('-DUCD_LIBRARY=' + (Join-Path $espeakBuild 'src/ucd-tools/Release/ucd.lib')),
                ('-DOPUS_INCLUDE_DIRECTORY=' + (Join-Path $opusSource 'include')),
                ('-DOPUS_LIBRARY=' + (Join-Path $opusBuild 'Release/opus.lib')),
                ('-DOPUSENC_INCLUDE_DIRECTORY=' + (Join-Path $opusencWorkingSource 'include')),
                ('-DOPUSENC_LIBRARY=' + (Join-Path $opusencBuild 'opusenc.lib')),
                ('-DESPEAK_NG_DATA_DIRECTORY=' + (Join-Path $espeakBuild 'espeak-ng-data')),
                ('-DCMAKE_INSTALL_PREFIX=' + $stageDirectory)
            ))
            Invoke-Producer 'build' $CMakePath @('--build', $helperBuild, '--config', 'Release', '--target', 'arcane-kokoro', '--parallel', [string]$Parallel)
        }
        'stage' {
            Invoke-Producer 'install' $CMakePath @('--install', $helperBuild, '--config', 'Release', '--prefix', $stageDirectory)
            Write-Output 'Staging complete corresponding source, build instructions and upstream terms.'
            $correspondingSource = Join-Path $stageDirectory 'corresponding-source'
            Copy-SourceTree $espeakSource (Join-Path $correspondingSource 'upstream/espeak-ng')
            Copy-SourceTree $opusSource (Join-Path $correspondingSource 'upstream/opus')
            Copy-SourceTree $opusencWorkingSource (Join-Path $correspondingSource 'upstream/libopusenc')
            Copy-SourceTree $helperSource (Join-Path $correspondingSource 'arcane/src/local-ai/kokoro/native')
            $producerTools = Join-Path $correspondingSource 'arcane/tools'
            $licenses = Join-Path $stageDirectory 'licenses'
            New-Item -ItemType Directory -Path $producerTools, $licenses -Force | Out-Null
            Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $producerTools 'build-kokoro-runtime-windows.ps1') -Force
            Copy-Item -LiteralPath (Join-Path $sdkDirectory 'LICENSE') -Destination (Join-Path $correspondingSource 'arcane/LICENSE') -Force
            Copy-Item -LiteralPath (Join-Path $sdkDirectory 'LICENSE') -Destination (Join-Path $licenses 'arcane-AGPL-3.0.txt') -Force
            foreach ($name in @('COPYING', 'COPYING.BSD2', 'COPYING.APACHE', 'COPYING.UCD')) {
                Copy-Item -LiteralPath (Join-Path $espeakSource $name) -Destination (Join-Path $licenses ('espeak-ng-' + $name + '.txt')) -Force
            }
            Copy-Item -LiteralPath (Join-Path $espeakSource 'src/ucd-tools/COPYING') -Destination (Join-Path $licenses 'ucd-tools-COPYING.txt') -Force
            Copy-Item -LiteralPath (Join-Path $espeakSource 'src/ucd-tools/COPYING.UCD') -Destination (Join-Path $licenses 'ucd-tools-COPYING.UCD.txt') -Force
            Copy-Item -LiteralPath (Join-Path $opusSource 'COPYING') -Destination (Join-Path $licenses 'libopus-COPYING.txt') -Force
            Copy-Item -LiteralPath (Join-Path $opusencWorkingSource 'COPYING') -Destination (Join-Path $licenses 'libopusenc-COPYING.txt') -Force
            @'
Arcane native Kokoro phonemizer and Ogg Opus encoder
Copyright (c) The Wizard Nexus and contributors. First-party source: AGPL-3.0-only.

This helper statically links the following upstream components. Their source
notices and complete terms remain in corresponding-source/ and licenses/:
- csukuangfj/espeak-ng ed530aa113046142eb5115cf2fc9157854d0ffe1, including UCD
  and complete language data: GPL-3.0-or-later and the included Unicode,
  BSD and Apache notices for their respective files.
  https://github.com/csukuangfj/espeak-ng/tree/ed530aa113046142eb5115cf2fc9157854d0ffe1
- libopus 1.6.1: its BSD terms and patent-license references in COPYING.
  https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz
- libopusenc 0.3: its BSD terms, including its in-tree Ogg packing/resampling.
  https://downloads.xiph.org/releases/opus/libopusenc-0.3.tar.gz

Corresponding source accompanies this distribution, including the actual
upstream source, first-party helper, CMake target and Windows producer recipe.
Retain it and these notices with redistribution. This selected static-runtime
recipe does not bundle compiler-runtime DLLs.
The source is supplied without warranty under the included licenses.

To rebuild with the installed Visual Studio 2022 C++ Build Tools and CMake,
run corresponding-source/arcane/tools/build-kokoro-runtime-windows.ps1 with:
  -SourceRoot <corresponding-source/upstream>
  -ProjectDirectory <your approved project directory>
  -OutputDirectory <a separate subdirectory of that project>
  -Component <espeak, opus, opusenc, helper, or stage>
Select espeak, opus and opusenc independently; after they finish, select helper,
then stage. The default selected toolset is MSVC 14.44.35207 and Windows SDK
10.0.26100.0; explicit path/toolset parameters select already installed tools.
No acquisition, tests, model inference or audio playback is performed.
The resulting bin/arcane-kokoro.exe uses --data <stage/share>. Its native pipe
protocol is defined completely in corresponding-source/arcane/src/local-ai/
kokoro/native/main.cpp. Replace that executable and its matching complete
share/espeak-ng-data together when using a rebuilt helper.
'@ | Set-Content -LiteralPath (Join-Path $stageDirectory 'NOTICE.txt') -Encoding utf8
            $record.stageDirectory = $stageDirectory
        }
    }
    $record.status = 'completed'
} catch {
    $record.status = 'failed'
    $record.error = $_.Exception.ToString()
    $record.position = $_.InvocationInfo.PositionMessage
    $record.scriptStackTrace = $_.ScriptStackTrace
    throw
} finally {
    foreach ($entry in $previousEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    $record.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Save-ProducerRecord
}
Write-Output "Kokoro $Component completed. Record: $recordPath"
