# Invoked through stdin by the SDK's owned process; stdout contains one JSON record.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    # Enumerate the installed driver's devices in this helper only. An empty
    # CUDA_VISIBLE_DEVICES value hides every device, so remove the inherited value.
    [Environment]::SetEnvironmentVariable('CUDA_VISIBLE_DEVICES', $null, [EnvironmentVariableTarget]::Process)

    Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Arcane.LocalAI {
    [StructLayout(LayoutKind.Sequential)]
    public struct AdapterLuid {
        public uint LowPart;
        public int HighPart;
    }

    public sealed class CudaDeviceIdentity {
        public string Uuid;
        public uint NodeMask;
        public AdapterLuid Luid;
        public string UuidFunction;

        // NVIDIA CU_DEVICE_ATTRIBUTE_TCC_DRIVER is 35. CUDA's Windows LUID
        // contract is undefined in TCC mode, so only WDDM devices can be matched.
        // https://nvidia.github.io/cuda-python/cuda-bindings/latest/module/driver.html
        private const int TccDriverAttribute = 35;

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuInit(uint flags);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuDeviceGetCount(out int count);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuDeviceGet(out int device, int ordinal);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuDeviceGetAttribute(out int value, int attribute, int device);

        // CUDA writes the native Windows LUID layout: unsigned LowPart followed
        // by signed HighPart. Marshaling the struct preserves that native layout.
        // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-luid
        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuDeviceGetLuid(out AdapterLuid luid, out uint nodeMask, int device);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuDeviceGetUuid_v2([Out] byte[] uuid, int device);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuDeviceGetUuid([Out] byte[] uuid, int device);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuGetErrorName(int error, out IntPtr name);

        [DllImport("nvcuda.dll", ExactSpelling = true)]
        private static extern int cuGetErrorString(int error, out IntPtr message);

        private static void Check(int result, string operation) {
            if (result == 0) return;
            IntPtr name;
            IntPtr message;
            int nameResult = cuGetErrorName(result, out name);
            int messageResult = cuGetErrorString(result, out message);
            throw new InvalidOperationException(
                operation + " returned CUDA error " + result + ": " +
                (nameResult == 0 ? Marshal.PtrToStringAnsi(name) : "cuGetErrorName returned " + nameResult) + "; " +
                (messageResult == 0 ? Marshal.PtrToStringAnsi(message) : "cuGetErrorString returned " + messageResult)
            );
        }

        private static string ReadUuid(int device, out string function) {
            // CUuuid's 16 native octets are unavoidable ABI storage. CUDA UUID
            // text keeps their order; System.Guid would reverse several fields.
            byte[] uuid = new byte[16];
            int result;
            try {
                result = cuDeviceGetUuid_v2(uuid, device);
                function = "cuDeviceGetUuid_v2";
            } catch (EntryPointNotFoundException) {
                // Older drivers expose the original function for this same
                // device. No device or backend selection changes on this path.
                result = cuDeviceGetUuid(uuid, device);
                function = "cuDeviceGetUuid";
            }
            Check(result, function);
            StringBuilder text = new StringBuilder("GPU-");
            for (int index = 0; index < uuid.Length; index++) {
                if (index == 4 || index == 6 || index == 8 || index == 10) text.Append('-');
                text.Append(uuid[index].ToString("x2", CultureInfo.InvariantCulture));
            }
            return text.ToString();
        }

        public static CudaDeviceIdentity Resolve(uint lowPart, int highPart) {
            Check(cuInit(0), "cuInit");
            int count;
            Check(cuDeviceGetCount(out count), "cuDeviceGetCount");
            CudaDeviceIdentity matched = null;
            int tccCount = 0;
            for (int ordinal = 0; ordinal < count; ordinal++) {
                int device;
                Check(cuDeviceGet(out device, ordinal), "cuDeviceGet(" + ordinal + ")");
                int tcc;
                Check(cuDeviceGetAttribute(out tcc, TccDriverAttribute, device), "cuDeviceGetAttribute(TCC_DRIVER, " + ordinal + ")");
                if (tcc != 0) {
                    tccCount++;
                    continue;
                }
                AdapterLuid luid;
                uint nodeMask;
                Check(cuDeviceGetLuid(out luid, out nodeMask, device), "cuDeviceGetLuid(" + ordinal + ")");
                if (luid.LowPart != lowPart || luid.HighPart != highPart) continue;
                if (matched != null) {
                    throw new InvalidOperationException("Multiple CUDA devices share the selected adapter LUID; the catalog selection cannot identify one CUDA device.");
                }
                string function;
                string uuid = ReadUuid(device, out function);
                matched = new CudaDeviceIdentity { Uuid = uuid, NodeMask = nodeMask, Luid = luid, UuidFunction = function };
            }
            if (matched == null) {
                throw new InvalidOperationException(
                    "No WDDM CUDA device matches the selected adapter LUID. CUDA devices enumerated: " + count +
                    "; TCC devices without a defined LUID: " + tccCount + "."
                );
            }
            return matched;
        }
    }
}
'@

    $lowPart = [uint32]::Parse($env:ARCANE_LLAMA_LUID_LOW, [Globalization.CultureInfo]::InvariantCulture)
    $highPart = [int32]::Parse($env:ARCANE_LLAMA_LUID_HIGH, [Globalization.CultureInfo]::InvariantCulture)
    $device = [Arcane.LocalAI.CudaDeviceIdentity]::Resolve($lowPart, $highPart)
    [ordered]@{
        uuid = $device.Uuid
        nodeMask = $device.NodeMask
        adapterLuid = [ordered]@{
            lowPart = $device.Luid.LowPart
            highPart = $device.Luid.HighPart
        }
        driverMode = 'wddm'
        uuidFunction = $device.UuidFunction
    } | ConvertTo-Json -Depth 4 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    if ($null -ne $_.ErrorDetails) { [Console]::Error.WriteLine($_.ErrorDetails.Message) }
    if ($null -ne $_.InvocationInfo) { [Console]::Error.WriteLine($_.InvocationInfo.PositionMessage) }
    if ($_.ScriptStackTrace) { [Console]::Error.WriteLine($_.ScriptStackTrace) }
    exit 1
}
