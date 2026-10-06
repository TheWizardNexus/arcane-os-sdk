# Invoked through stdin by the SDK's owned PowerShell process. Keep stdout JSON-only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$inventoryDevices = [System.Collections.Generic.List[object]]::new()
$inventoryIssues = [System.Collections.Generic.List[object]]::new()

function Add-InventoryIssue {
    param([string]$Source, [string]$Code, [string]$Message, $DeviceId = $null)

    $inventoryIssues.Add([ordered]@{
        source = $Source
        code = $Code
        message = $Message
        deviceId = $DeviceId
    })
}

function Get-InventoryErrorText {
    param([System.Management.Automation.ErrorRecord]$Record)

    $details = [System.Collections.Generic.List[string]]::new()
    $details.Add($Record.Exception.ToString())
    if ($null -ne $Record.ErrorDetails) {
        $details.Add($Record.ErrorDetails.Message)
    }
    if ($null -ne $Record.InvocationInfo) {
        $details.Add($Record.InvocationInfo.PositionMessage)
    }
    if ($Record.ScriptStackTrace) {
        $details.Add($Record.ScriptStackTrace)
    }
    return [string]::Join([Environment]::NewLine, $details)
}

function Add-HostCpu {
    try {
        $processors = [System.Collections.Generic.List[object]]::new()
        $names = [System.Collections.Generic.List[string]]::new()
        $reportedProcessors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
        foreach ($processor in $reportedProcessors) {
            $processorName = [string]$processor.Name
            $processorId = [string]$processor.DeviceID
            if ($processorName -ne '') {
                $names.Add($processorName)
            }
            if ($processorName -eq '' -or $processorId -eq '') {
                Add-InventoryIssue 'cpu' 'property-unavailable' 'Win32_Processor did not report a processor Name or DeviceID.' 'cpu'
            }
            $processors.Add([ordered]@{
                deviceId = $processorId
                name = $processorName
                socketDesignation = if ($null -eq $processor.SocketDesignation) { $null } else { [string]$processor.SocketDesignation }
                cores = if ($null -eq $processor.NumberOfCores) { $null } else { [uint32]$processor.NumberOfCores }
                logicalProcessors = if ($null -eq $processor.NumberOfLogicalProcessors) { $null } else { [uint32]$processor.NumberOfLogicalProcessors }
            })
        }
        if ($processors.Count -eq 0) {
            Add-InventoryIssue 'cpu' 'enumeration-failed' 'Win32_Processor returned no processor records.'
            return
        }
        $cpuName = if ($names.Count -gt 0) { [string]::Join(' / ', $names) } else { 'Host CPU' }
        $inventoryDevices.Add([ordered]@{
            deviceId = 'cpu'
            identitySource = 'host-cpu'
            kind = 'cpu'
            name = $cpuName
            present = $true
            isHardware = $null
            isIntegrated = $null
            dedicatedMemoryMiB = $null
            addresses = [ordered]@{
                adapterLuid = $null
                pci = $null
                dxgiAdapterIndex = $null
            }
            processors = $processors.ToArray()
        })
    } catch {
        Add-InventoryIssue 'cpu' 'enumeration-failed' (Get-InventoryErrorText $_)
    }
}

function Get-PresentPciDevices {
    # One present-device census and one batched property query serve both kinds.
    # A PCI bus address is a correlation fact, never a persisted selection key.
    $devicesById = @{}
    try {
        $census = @(Get-PnpDevice -PresentOnly -ErrorAction Continue 2>&1 3>&1)
        foreach ($item in $census) {
            if ($item -is [System.Management.Automation.ErrorRecord]) {
                Add-InventoryIssue 'identity' 'enumeration-failed' (Get-InventoryErrorText $item)
                continue
            }
            if ($item -is [System.Management.Automation.WarningRecord]) {
                Add-InventoryIssue 'identity' 'enumeration-failed' $item.Message
                continue
            }
            $instanceId = [string]$item.InstanceId
            if ($instanceId.StartsWith('PCI\', [StringComparison]::OrdinalIgnoreCase)) {
                $devicesById[$instanceId] = [ordered]@{
                    instanceId = $instanceId
                    bus = $null
                    address = $null
                }
            }
        }
        if ($devicesById.Count -gt 0) {
            $properties = @(
                Get-PnpDeviceProperty -InstanceId ([string[]]@($devicesById.Keys)) -KeyName 'DEVPKEY_Device_BusNumber', 'DEVPKEY_Device_Address' -ErrorAction Continue 2>&1 3>&1
            )
            foreach ($property in $properties) {
                if ($property -is [System.Management.Automation.ErrorRecord]) {
                    Add-InventoryIssue 'identity' 'property-failed' (Get-InventoryErrorText $property)
                    continue
                }
                if ($property -is [System.Management.Automation.WarningRecord]) {
                    Add-InventoryIssue 'identity' 'property-failed' $property.Message
                    continue
                }
                $entry = $devicesById[[string]$property.InstanceId]
                if ($null -eq $entry -or $null -eq $property.Data) {
                    continue
                }
                if ($property.KeyName -eq 'DEVPKEY_Device_BusNumber') {
                    $entry.bus = [uint32]$property.Data
                } elseif ($property.KeyName -eq 'DEVPKEY_Device_Address') {
                    # DEVPKEY_Device_Address is INT32; preserve its unsigned bits.
                    $address = [uint32]([int64]$property.Data -band 4294967295L)
                    if ($address -eq 4294967295L) {
                        Add-InventoryIssue 'identity' 'property-unavailable' 'The PCI bus driver did not supply a device address.' $entry.instanceId
                    } else {
                        $entry.address = $address
                    }
                }
            }
        }
    } catch [System.Management.Automation.CommandNotFoundException] {
        Add-InventoryIssue 'identity' 'enumeration-unavailable' (Get-InventoryErrorText $_)
    } catch {
        Add-InventoryIssue 'identity' 'enumeration-failed' (Get-InventoryErrorText $_)
    }
    return $devicesById
}

# SDK-authored ABI declarations for the Windows system libraries. Buffer lengths
# below are native-call framing only; no inventory content limit is imposed.
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Arcane.ExecutionDevices
{
    public sealed class InventoryIssue
    {
        public string Source;
        public string Code;
        public string Message;

        public InventoryIssue(string source, string code, string message)
        {
            Source = source;
            Code = code;
            Message = message;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AdapterLuid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PciAddress
    {
        public uint Bus;
        public uint Device;
        public uint Function;
    }

    public sealed class Adapter
    {
        public string Kind;
        public string Name;
        public bool Present;
        public bool? IsHardware;
        public bool? IsIntegrated;
        public double? DedicatedMemoryMiB;
        public AdapterLuid? Luid;
        public PciAddress? Pci;
        public uint? DxgiAdapterIndex;
        public List<InventoryIssue> Issues = new List<InventoryIssue>();

        public Adapter(string kind)
        {
            Kind = kind;
            Name = "Windows " + kind.ToUpperInvariant();
        }
    }

    public sealed class Inventory
    {
        public List<Adapter> Adapters = new List<Adapter>();
        public List<InventoryIssue> Issues = new List<InventoryIssue>();
    }

    public static class WindowsInventory
    {
        private enum AdapterProperty : uint
        {
            InstanceLuid = 0,
            DriverDescription = 2,
            DedicatedAdapterMemory = 7,
            IsHardware = 11,
            IsIntegrated = 12
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct OpenAdapterFromLuid
        {
            public AdapterLuid Luid;
            public uint Handle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct QueryAdapterInfo
        {
            public uint Handle;
            public uint Type;
            public IntPtr Data;
            public uint DataLength;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CloseAdapter
        {
            public uint Handle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DxgiAdapterDescription
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string Description;
            public uint VendorId;
            public uint DeviceId;
            public uint SubSystemId;
            public uint Revision;
            public UIntPtr DedicatedVideoMemory;
            public UIntPtr DedicatedSystemMemory;
            public UIntPtr SharedSystemMemory;
            public AdapterLuid Luid;
        }

        [DllImport("dxcore.dll", ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        private static extern int DXCoreCreateAdapterFactory(ref Guid iid, out IntPtr factory);

        [DllImport("dxgi.dll", ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        private static extern int CreateDXGIFactory(ref Guid iid, out IntPtr factory);

        [DllImport("gdi32.dll", ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        private static extern int D3DKMTOpenAdapterFromLuid(ref OpenAdapterFromLuid adapter);

        [DllImport("gdi32.dll", ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        private static extern int D3DKMTQueryAdapterInfo(ref QueryAdapterInfo query);

        [DllImport("gdi32.dll", ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        private static extern int D3DKMTCloseAdapter(ref CloseAdapter adapter);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CreateAdapterList(IntPtr self, uint count, ref Guid attribute, ref Guid iid, out IntPtr list);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetAdapter(IntPtr self, uint index, ref Guid iid, out IntPtr adapter);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate uint GetAdapterCount(IntPtr self);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.I1)]
        private delegate bool GetNativeBoolean(IntPtr self);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.I1)]
        private delegate bool IsPropertySupported(IntPtr self, AdapterProperty property);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetProperty(IntPtr self, AdapterProperty property, UIntPtr bufferLength, IntPtr data);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetPropertySize(IntPtr self, AdapterProperty property, out UIntPtr bufferLength);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnumerateDxgiAdapter(IntPtr self, uint index, out IntPtr adapter);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetDxgiDescription(IntPtr self, out DxgiAdapterDescription description);

        public static Inventory Read()
        {
            Inventory inventory = new Inventory();
            IntPtr factory = IntPtr.Zero;
            try
            {
                Guid factoryId = new Guid("78ee5945-c36e-4b13-a669-005dd11c0f06");
                int result = DXCoreCreateAdapterFactory(ref factoryId, out factory);
                RequireComResult(result, factory);
                Guid gpuAttribute = new Guid("b69eb219-3ded-4464-979f-a00bd4687006");
                Guid npuAttribute = new Guid("d46140c4-add7-451b-9e56-06fe8c3b58ed");
                ReadAdapterKind(factory, "gpu", gpuAttribute, inventory);
                ReadAdapterKind(factory, "npu", npuAttribute, inventory);
            }
            catch (Exception error)
            {
                string code = IsApiUnavailable(error) ? "enumeration-unavailable" : "enumeration-failed";
                inventory.Issues.Add(
                    new InventoryIssue("gpu", code, "DXCore factory: " + error.ToString())
                );
                inventory.Issues.Add(
                    new InventoryIssue("npu", code, "DXCore factory: " + error.ToString())
                );
            }
            finally
            {
                ReleaseCom(factory, "identity", inventory.Issues);
            }

            if (inventory.Adapters.Count > 0)
            {
                ReadDxgiAddresses(inventory);
            }
            return inventory;
        }

        private static void ReadAdapterKind(IntPtr factory, string kind, Guid attribute, Inventory inventory)
        {
            IntPtr list = IntPtr.Zero;
            try
            {
                Guid listId = new Guid("526c7776-40e9-459b-b711-f32ad76dfc28");
                CreateAdapterList createList = GetMethod<CreateAdapterList>(factory, 3);
                int result = createList(factory, 1, ref attribute, ref listId, out list);
                RequireComResult(result, list);
                GetAdapterCount getCount = GetMethod<GetAdapterCount>(list, 4);
                GetAdapter getAdapter = GetMethod<GetAdapter>(list, 3);
                uint count = getCount(list);
                Guid adapterId = new Guid("f0db4c7f-fe5a-42a2-bd62-f2a6cf6fc83e");
                for (uint index = 0; index < count; index++)
                {
                    IntPtr pointer = IntPtr.Zero;
                    Adapter adapter = null;
                    try
                    {
                        result = getAdapter(list, index, ref adapterId, out pointer);
                        RequireComResult(result, pointer);
                        adapter = new Adapter(kind);
                        inventory.Adapters.Add(adapter);
                        GetNativeBoolean isValid = GetMethod<GetNativeBoolean>(pointer, 3);
                        adapter.Present = isValid(pointer);
                        ReadProperties(pointer, adapter);
                        if (adapter.Luid.HasValue)
                        {
                            ReadPciAddress(adapter);
                        }
                        if (!isValid(pointer))
                        {
                            adapter.Present = false;
                            adapter.Issues.Add(
                                new InventoryIssue(kind, "enumeration-failed", "The DXCore adapter became invalid during discovery.")
                            );
                        }
                    }
                    catch (Exception error)
                    {
                        List<InventoryIssue> issues = adapter == null ? inventory.Issues : adapter.Issues;
                        issues.Add(
                            new InventoryIssue(kind, "enumeration-failed", "DXCore adapter " + index + ": " + error.ToString())
                        );
                    }
                    finally
                    {
                        ReleaseCom(pointer, kind, adapter == null ? inventory.Issues : adapter.Issues);
                    }
                }
                GetNativeBoolean isStale = GetMethod<GetNativeBoolean>(list, 5);
                if (isStale(list))
                {
                    inventory.Issues.Add(
                        new InventoryIssue(kind, "enumeration-failed", "The DXCore adapter list changed during discovery; refresh the inventory.")
                    );
                }
            }
            catch (Exception error)
            {
                string code = IsApiUnavailable(error) ? "enumeration-unavailable" : "enumeration-failed";
                inventory.Issues.Add(
                    new InventoryIssue(kind, code, "DXCore " + kind + " enumeration: " + error.ToString())
                );
            }
            finally
            {
                ReleaseCom(list, kind, inventory.Issues);
            }
        }

        private static void ReadProperties(IntPtr pointer, Adapter adapter)
        {
            IsPropertySupported isSupported = GetMethod<IsPropertySupported>(pointer, 5);
            GetProperty getProperty = GetMethod<GetProperty>(pointer, 6);
            GetPropertySize getPropertySize = GetMethod<GetPropertySize>(pointer, 7);
            AdapterProperty[] properties =
            {
                AdapterProperty.InstanceLuid,
                AdapterProperty.DriverDescription,
                AdapterProperty.IsHardware,
                AdapterProperty.IsIntegrated,
                AdapterProperty.DedicatedAdapterMemory
            };
            foreach (AdapterProperty property in properties)
            {
                IntPtr data = IntPtr.Zero;
                try
                {
                    if (!isSupported(pointer, property))
                    {
                        adapter.Issues.Add(
                            new InventoryIssue(adapter.Kind, "property-unavailable", "DXCore does not expose " + property + " for this adapter.")
                        );
                        continue;
                    }
                    UIntPtr nativeLength;
                    int result = getPropertySize(pointer, property, out nativeLength);
                    Marshal.ThrowExceptionForHR(result);
                    int length = checked((int)nativeLength.ToUInt64());
                    int requiredLength = property == AdapterProperty.DriverDescription
                        || property == AdapterProperty.IsHardware
                        || property == AdapterProperty.IsIntegrated ? 1 : 8;
                    if (length < requiredLength)
                    {
                        throw new InvalidOperationException("DXCore returned an incomplete native " + property + " representation.");
                    }
                    data = Marshal.AllocHGlobal(length);
                    result = getProperty(pointer, property, nativeLength, data);
                    Marshal.ThrowExceptionForHR(result);
                    switch (property)
                    {
                        case AdapterProperty.InstanceLuid:
                            adapter.Luid = (AdapterLuid)Marshal.PtrToStructure(data, typeof(AdapterLuid));
                            break;
                        case AdapterProperty.DriverDescription:
                            byte[] description = new byte[length];
                            Marshal.Copy(data, description, 0, length);
                            int terminator = Array.IndexOf(description, (byte)0);
                            if (terminator < 0)
                            {
                                throw new InvalidOperationException("DXCore returned a driver description without its required null terminator.");
                            }
                            adapter.Name = Encoding.UTF8.GetString(description, 0, terminator);
                            break;
                        case AdapterProperty.IsHardware:
                            adapter.IsHardware = Marshal.ReadByte(data) != 0;
                            break;
                        case AdapterProperty.IsIntegrated:
                            adapter.IsIntegrated = Marshal.ReadByte(data) != 0;
                            break;
                        case AdapterProperty.DedicatedAdapterMemory:
                            adapter.DedicatedMemoryMiB = unchecked((ulong)Marshal.ReadInt64(data)) / 1048576.0;
                            break;
                    }
                }
                catch (Exception error)
                {
                    adapter.Issues.Add(
                        new InventoryIssue(adapter.Kind, "property-failed", "DXCore " + property + ": " + error.ToString())
                    );
                }
                finally
                {
                    FreeBuffer(data, adapter.Kind, adapter.Issues);
                }
            }
        }

        private static void ReadPciAddress(Adapter adapter)
        {
            OpenAdapterFromLuid opened = new OpenAdapterFromLuid();
            opened.Luid = adapter.Luid.Value;
            IntPtr data = IntPtr.Zero;
            bool ownsHandle = false;
            try
            {
                int status = D3DKMTOpenAdapterFromLuid(ref opened);
                RequireNtSuccess(status, "D3DKMTOpenAdapterFromLuid");
                ownsHandle = true;
                int length = Marshal.SizeOf(typeof(PciAddress));
                data = Marshal.AllocHGlobal(length);
                QueryAdapterInfo query = new QueryAdapterInfo();
                query.Handle = opened.Handle;
                query.Type = 6; // KMTQAITYPE_ADAPTERADDRESS
                query.Data = data;
                query.DataLength = (uint)length;
                status = D3DKMTQueryAdapterInfo(ref query);
                RequireNtSuccess(status, "D3DKMTQueryAdapterInfo(KMTQAITYPE_ADAPTERADDRESS)");
                adapter.Pci = (PciAddress)Marshal.PtrToStructure(data, typeof(PciAddress));
            }
            catch (Exception error)
            {
                string code = IsApiUnavailable(error) ? "property-unavailable" : "property-failed";
                adapter.Issues.Add(
                    new InventoryIssue("identity", code, "LUID to PCI address: " + error.ToString())
                );
            }
            finally
            {
                FreeBuffer(data, "identity", adapter.Issues);
                if (ownsHandle)
                {
                    try
                    {
                        CloseAdapter closed = new CloseAdapter();
                        closed.Handle = opened.Handle;
                        int status = D3DKMTCloseAdapter(ref closed);
                        RequireNtSuccess(status, "D3DKMTCloseAdapter");
                    }
                    catch (Exception error)
                    {
                        adapter.Issues.Add(
                            new InventoryIssue("identity", "cleanup-failed", error.ToString())
                        );
                    }
                }
            }
        }

        private static void ReadDxgiAddresses(Inventory inventory)
        {
            IntPtr factory = IntPtr.Zero;
            List<AdapterLuid> luids = new List<AdapterLuid>();
            List<uint> indexes = new List<uint>();
            try
            {
                Guid factoryId = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
                int factoryResult = CreateDXGIFactory(ref factoryId, out factory);
                RequireComResult(factoryResult, factory);
                EnumerateDxgiAdapter enumerate = GetMethod<EnumerateDxgiAdapter>(factory, 7);
                for (uint index = 0; ; index++)
                {
                    IntPtr pointer = IntPtr.Zero;
                    bool enumerated = false;
                    try
                    {
                        int result = enumerate(factory, index, out pointer);
                        if (result == unchecked((int)0x887A0002)) // DXGI_ERROR_NOT_FOUND
                        {
                            break;
                        }
                        RequireComResult(result, pointer);
                        enumerated = true;
                        GetDxgiDescription getDescription = GetMethod<GetDxgiDescription>(pointer, 8);
                        DxgiAdapterDescription description;
                        int descriptionResult = getDescription(pointer, out description);
                        Marshal.ThrowExceptionForHR(descriptionResult);
                        luids.Add(description.Luid);
                        indexes.Add(index);
                    }
                    catch (Exception error)
                    {
                        string code = enumerated ? "property-failed" : "enumeration-failed";
                        inventory.Issues.Add(
                            new InventoryIssue("dxgi", code, "DXGI adapter " + index + ": " + error.ToString())
                        );
                        if (!enumerated)
                        {
                            // Only description failures leave later indices queryable.
                            break;
                        }
                    }
                    finally
                    {
                        ReleaseCom(pointer, "dxgi", inventory.Issues);
                    }
                }
            }
            catch (Exception error)
            {
                string code = IsApiUnavailable(error) ? "enumeration-unavailable" : "enumeration-failed";
                inventory.Issues.Add(
                    new InventoryIssue("dxgi", code, "DXGI enumeration: " + error.ToString())
                );
            }
            finally
            {
                ReleaseCom(factory, "dxgi", inventory.Issues);
            }

            foreach (Adapter adapter in inventory.Adapters)
            {
                if (!adapter.Luid.HasValue)
                {
                    continue;
                }
                int matches = 0;
                uint matchedIndex = 0;
                for (int index = 0; index < luids.Count; index++)
                {
                    if (SameLuid(adapter.Luid.Value, luids[index]))
                    {
                        matches++;
                        matchedIndex = indexes[index];
                    }
                }
                if (matches == 1)
                {
                    adapter.DxgiAdapterIndex = matchedIndex;
                }
                else
                {
                    string message = matches == 0
                        ? "No DXGI adapter index was observed for this DXCore LUID."
                        : "More than one DXGI adapter index was observed for this DXCore LUID.";
                    adapter.Issues.Add(
                        new InventoryIssue("dxgi", "property-unavailable", message)
                    );
                }
            }
        }

        private static bool SameLuid(AdapterLuid left, AdapterLuid right)
        {
            return left.LowPart == right.LowPart && left.HighPart == right.HighPart;
        }

        private static T GetMethod<T>(IntPtr instance, int slot) where T : class
        {
            IntPtr table = Marshal.ReadIntPtr(instance);
            IntPtr method = Marshal.ReadIntPtr(table, slot * IntPtr.Size);
            return (T)(object)Marshal.GetDelegateForFunctionPointer(method, typeof(T));
        }

        private static void RequireComResult(int result, IntPtr instance)
        {
            Marshal.ThrowExceptionForHR(result);
            if (instance == IntPtr.Zero)
            {
                throw new InvalidOperationException("The Windows COM operation succeeded without returning an interface.");
            }
        }

        private static void RequireNtSuccess(int status, string operation)
        {
            if (status < 0)
            {
                throw new InvalidOperationException(operation + " returned NTSTATUS 0x" + unchecked((uint)status).ToString("X8") + ".");
            }
        }

        private static bool IsApiUnavailable(Exception error)
        {
            return error is DllNotFoundException
                || error is EntryPointNotFoundException
                || error is BadImageFormatException
                || error is PlatformNotSupportedException;
        }

        private static void ReleaseCom(IntPtr instance, string source, List<InventoryIssue> issues)
        {
            if (instance == IntPtr.Zero)
            {
                return;
            }
            try
            {
                Marshal.Release(instance);
            }
            catch (Exception error)
            {
                issues.Add(
                    new InventoryIssue(source, "cleanup-failed", error.ToString())
                );
            }
        }

        private static void FreeBuffer(IntPtr data, string source, List<InventoryIssue> issues)
        {
            if (data == IntPtr.Zero)
            {
                return;
            }
            try
            {
                Marshal.FreeHGlobal(data);
            }
            catch (Exception error)
            {
                issues.Add(
                    new InventoryIssue(source, "cleanup-failed", error.ToString())
                );
            }
        }
    }
}
'@

function Add-NativeAdapters {
    try {
        # Collect all compiler diagnostics as data; none may contaminate stdout.
        $compilerFailed = $false
        $compilerOutput = @(Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Continue -WarningAction Continue 2>&1 3>&1)
        foreach ($diagnostic in $compilerOutput) {
            if ($diagnostic -is [System.Management.Automation.ErrorRecord]) {
                $compilerFailed = $true
                $message = Get-InventoryErrorText $diagnostic
            } else {
                $message = $diagnostic.ToString()
            }
            Add-InventoryIssue 'identity' 'interop-diagnostic' $message
        }
        if ($compilerFailed) {
            Add-InventoryIssue 'gpu' 'enumeration-unavailable' 'The Windows inventory interop could not be compiled; complete diagnostics are included in issues.'
            Add-InventoryIssue 'npu' 'enumeration-unavailable' 'The Windows inventory interop could not be compiled; complete diagnostics are included in issues.'
            return
        }
        $nativeInventory = [Arcane.ExecutionDevices.WindowsInventory]::Read()
        foreach ($issue in $nativeInventory.Issues) {
            Add-InventoryIssue $issue.Source $issue.Code $issue.Message
        }
        $pnpDevices = Get-PresentPciDevices
        $deviceRows = [System.Collections.Generic.List[object]]::new()
        foreach ($adapter in $nativeInventory.Adapters) {
            $deviceId = $null
            $identitySource = $null
            $luid = $null
            $pci = $null
            if ($null -ne $adapter.Luid) {
                $luid = [ordered]@{
                    highPart = $adapter.Luid.HighPart
                    lowPart = $adapter.Luid.LowPart
                }
            }
            if ($null -ne $adapter.Pci) {
                $pci = [ordered]@{
                    bus = $adapter.Pci.Bus
                    device = $adapter.Pci.Device
                    function = $adapter.Pci.Function
                }
                $matchedDevices = [System.Collections.Generic.List[object]]::new()
                foreach ($candidate in $pnpDevices.Values) {
                    if ($null -ne $candidate.bus -and $null -ne $candidate.address -and
                        $candidate.bus -eq $pci.bus -and
                        (($candidate.address -shr 16) -band 65535) -eq $pci.device -and
                        ($candidate.address -band 65535) -eq $pci.function) {
                        $matchedDevices.Add($candidate)
                    }
                }
                if ($matchedDevices.Count -eq 1 -and $adapter.Present) {
                    $deviceId = $matchedDevices[0].instanceId
                    $identitySource = 'windows-pnp-instance'
                } elseif ($matchedDevices.Count -gt 1) {
                    Add-InventoryIssue 'identity' 'identity-ambiguous' 'Multiple present PnP instances share this adapter PCI address.'
                }
            }
            $row = [ordered]@{
                deviceId = $deviceId
                identitySource = $identitySource
                kind = $adapter.Kind
                name = $adapter.Name
                present = $adapter.Present
                isHardware = $adapter.IsHardware
                isIntegrated = $adapter.IsIntegrated
                dedicatedMemoryMiB = $adapter.DedicatedMemoryMiB
                addresses = [ordered]@{
                    adapterLuid = $luid
                    pci = $pci
                    dxgiAdapterIndex = $adapter.DxgiAdapterIndex
                }
                processors = @()
            }
            $deviceRows.Add([ordered]@{row = $row; issues = $adapter.Issues})
        }
        # Both sides of the join must be unique. A single PnP instance cannot
        # establish distinct physical identities for multiple DXCore records.
        $rowsById = @{}
        foreach ($entry in $deviceRows) {
            $deviceId = $entry.row.deviceId
            if ($null -ne $deviceId) {
                if (!$rowsById.ContainsKey($deviceId)) {
                    $rowsById[$deviceId] = [System.Collections.Generic.List[object]]::new()
                }
                $rowsById[$deviceId].Add($entry.row)
            }
        }
        foreach ($rows in $rowsById.Values) {
            if ($rows.Count -gt 1) {
                foreach ($row in $rows) {
                    $row.deviceId = $null
                    $row.identitySource = $null
                }
                Add-InventoryIssue 'identity' 'identity-ambiguous' 'Multiple DXCore adapters correlate to the same present PnP instance.'
            }
        }
        foreach ($entry in $deviceRows) {
            $row = $entry.row
            if ($null -eq $row.deviceId) {
                Add-InventoryIssue 'identity' 'identity-unresolved' ("No unique present PnP instance could be correlated to the Windows {0} '{1}'." -f $row.kind, $row.name)
            }
            foreach ($issue in $entry.issues) {
                Add-InventoryIssue $issue.Source $issue.Code $issue.Message $row.deviceId
            }
            $inventoryDevices.Add($row)
        }
    } catch {
        $message = Get-InventoryErrorText $_
        Add-InventoryIssue 'gpu' 'enumeration-failed' $message
        Add-InventoryIssue 'npu' 'enumeration-failed' $message
    }
}

Add-HostCpu
Add-NativeAdapters

$inventoryState = if ($inventoryDevices.Count -eq 0) { 'unavailable' } elseif ($inventoryIssues.Count -gt 0) { 'partial' } else { 'ready' }
$inventory = [ordered]@{
    platform = 'win32'
    state = $inventoryState
    devices = $inventoryDevices.ToArray()
    issues = $inventoryIssues.ToArray()
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $inventory -Depth 12 -Compress))
