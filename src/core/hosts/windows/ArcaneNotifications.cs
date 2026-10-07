using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>
    /// Owns live Windows notifications independently of renderer documents. Native
    /// calls and retained state run on one MTA; caller content is never persisted.
    /// The changed callback must not synchronously wait for this adapter's tasks.
    /// </summary>
    internal sealed class ArcaneNotifications
    {
        private readonly string applicationId;
        private readonly string profileDirectory;
        private readonly string title;
        private readonly string iconPath;
        private readonly Action<Dictionary<string, object>> changed;
        private readonly object gate = new object();
        private readonly Queue<Work> work = new Queue<Work>();
        private readonly Dictionary<string, Notice> notices = new Dictionary<string, Notice>(StringComparer.Ordinal);
        private readonly Dictionary<string, Notice> nativeNotices = new Dictionary<string, Notice>(StringComparer.Ordinal);
        private readonly List<Notice> orderedNotices = new List<Notice>();
        private readonly List<Exception> lifetimeErrors = new List<Exception>();
        private readonly TaskCompletionSource<object> completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        private AutoResetEvent wake;
        private Thread worker;
        private bool stopping;
        private bool callbacksOpen = true;
        private bool finishRequested;
        private bool comInitialized;
        private bool initialized;
        private Mutex nativeOwner;
        private bool ownsMutex;
        private uint classCookie;
        private bool classRegistered;
        private ArcaneNotificationCom.Factory factory;
        private ToastNotifier notifier;
        private string nativeApplicationId;
        private Guid nativeClassId;
        private long revision;
        private Exception initializationError;
        private string unavailableReason;

        internal ArcaneNotifications(string applicationId, string profileDirectory, string title,
            string iconPath, Action<Dictionary<string, object>> changed)
        {
            this.applicationId = applicationId;
            this.profileDirectory = profileDirectory;
            this.title = title;
            this.iconPath = iconPath;
            this.changed = changed;
        }

        internal Task<Dictionary<string, object>> InvokeAsync(string method,
            Dictionary<string, object> parameters, CancellationToken cancellation)
        {
            TaskCompletionSource<Dictionary<string, object>> result =
                new TaskCompletionSource<Dictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (gate)
            {
                if (stopping)
                {
                    result.SetException(new ObjectDisposedException("ArcaneNotifications"));
                    return result.Task;
                }
                try
                {
                    StartWorker();
                    work.Enqueue(new Work(delegate
                    {
                        try
                        {
                            cancellation.ThrowIfCancellationRequested();
                            Dictionary<string, object> value;
                            switch (method)
                            {
                                case "notifications.status": value = Status(); break;
                                case "notifications.state": value = Snapshot(parameters); break;
                                case "notifications.show": value = Show(parameters, cancellation); break;
                                case "notifications.close": value = CloseNotice(FindNotice(RequiredString(parameters, "id"))); break;
                                default: throw Error("NOTIFICATIONS_METHOD_UNKNOWN", "Unknown notification method: " + method);
                            }
                            result.TrySetResult(value);
                        }
                        catch (OperationCanceledException)
                        {
                            if (cancellation.IsCancellationRequested) result.TrySetCanceled();
                            else throw;
                        }
                        catch (Exception error) { result.TrySetException(error); }
                    }, delegate(Exception error) { result.TrySetException(error); }));
                    wake.Set();
                }
                catch (Exception error) { result.TrySetException(error); }
            }
            return result.Task;
        }

        internal Task CloseAsync()
        {
            lock (gate)
            {
                if (stopping) return completion.Task;
                stopping = true;
                if (worker == null)
                {
                    callbacksOpen = false;
                    completion.TrySetResult(null);
                    return completion.Task;
                }
                work.Enqueue(new Work(Shutdown, RecordLifetimeError));
                wake.Set();
                return completion.Task;
            }
        }

        private void StartWorker()
        {
            if (worker != null) return;
            wake = new AutoResetEvent(false);
            worker = new Thread(Run) { IsBackground = true, Name = "Arcane native notifications" };
            try
            {
                worker.SetApartmentState(ApartmentState.MTA);
                worker.Start();
            }
            catch
            {
                worker = null;
                wake.Dispose();
                wake = null;
                throw;
            }
        }

        private void Run()
        {
            try
            {
                while (true)
                {
                    Work next = null;
                    lock (gate)
                    {
                        if (work.Count != 0) next = work.Dequeue();
                        else if (finishRequested) break;
                    }
                    if (next == null) { wake.WaitOne(); continue; }
                    try { next.Run(); }
                    catch (Exception error) { next.Reject(error); }
                }
            }
            catch (Exception error)
            {
                RecordLifetimeError(error);
                lock (gate)
                {
                    stopping = true;
                    callbacksOpen = false;
                    while (work.Count != 0) work.Dequeue().Reject(error);
                }
                Shutdown();
            }
            finally
            {
                if (comInitialized) Native.CoUninitialize();
                lock (gate)
                {
                    callbacksOpen = false;
                    wake.Dispose();
                }
                if (lifetimeErrors.Count == 0) completion.TrySetResult(null);
                else completion.TrySetException(new AggregateException("Native notification shutdown encountered errors.", lifetimeErrors));
            }
        }

        private bool QueueCallback(Action action)
        {
            lock (gate)
            {
                if (!callbacksOpen) return false;
                work.Enqueue(new Work(action, RecordLifetimeError));
                wake.Set();
                return true;
            }
        }

        private Dictionary<string, object> Status()
        {
            TryInitialize();
            Dictionary<string, object> status = new Dictionary<string, object>
            {
                { "platform", "windows" }, { "applicationId", applicationId },
                { "supported", initialized ? (object)true : null },
                { "available", initialized }, { "permissionDisabled", false },
                { "activation", "live-process" }, { "coldActivation", false },
                { "revision", revision }, { "errors", LifetimeErrorRecords() }
            };
            if (initialized)
            {
                try
                {
                    NotificationSetting setting = notifier.Setting;
                    status["setting"] = setting.ToString();
                    status["permissionDisabled"] = setting != NotificationSetting.Enabled;
                    status["available"] = setting == NotificationSetting.Enabled;
                    if (setting != NotificationSetting.Enabled) status["reason"] = "notification-permission-disabled";
                }
                catch (Exception error)
                {
                    status["available"] = false;
                    status["permissionDisabled"] = null;
                    status["reason"] = "notification-settings-unavailable";
                    status["error"] = ArcaneHost.ErrorRecord(error, "NOTIFICATIONS_STATUS_FAILED");
                }
            }
            else
            {
                status["permissionDisabled"] = null;
                status["reason"] = unavailableReason;
                if (initializationError != null) status["error"] = ArcaneHost.ErrorRecord(initializationError, "NOTIFICATIONS_UNAVAILABLE");
            }
            return status;
        }

        private void TryInitialize()
        {
            if (initialized) return;
            initializationError = null;
            unavailableReason = null;
            try
            {
                if (classRegistered || nativeOwner != null)
                {
                    List<Exception> cleanup = new List<Exception>();
                    ReleaseNativeOwner(cleanup);
                    if (cleanup.Count != 0) throw new AggregateException("The previous native notification owner could not be released.", cleanup);
                }
                if (!comInitialized)
                {
                    Marshal.ThrowExceptionForHR(Native.CoInitializeEx(IntPtr.Zero, 0));
                    comInitialized = true;
                }
                nativeClassId = ReadIdentity();
                nativeApplicationId = "Arcane.Notifications." + nativeClassId.ToString("N");
                nativeOwner = new Mutex(false, "Local\\" + nativeApplicationId);
                try { ownsMutex = nativeOwner.WaitOne(0); }
                catch (AbandonedMutexException) { ownsMutex = true; }
                if (!ownsMutex)
                {
                    unavailableReason = "notification-owner-already-running";
                    nativeOwner.Dispose();
                    nativeOwner = null;
                    return;
                }
                factory = new ArcaneNotificationCom.Factory(Activate);
                Marshal.ThrowExceptionForHR(Native.CoRegisterClassObject(ref nativeClassId, factory, 4, 1, out classCookie));
                classRegistered = true;
                InstallShortcut();
                RegisterDisplayIdentity();
                notifier = ToastNotificationManager.CreateToastNotifier(nativeApplicationId);
                initialized = true;
            }
            catch (Exception error)
            {
                List<Exception> errors = new List<Exception> { error };
                ReleaseNativeOwner(errors);
                initializationError = errors.Count == 1 ? error : new AggregateException("Native notification initialization and cleanup failed.", errors);
                unavailableReason = "notification-initialization-failed";
            }
        }

        private void RegisterDisplayIdentity()
        {
            // Functional unpackaged-app identity, retained with the profile. This
            // registers no executable launcher and never changes notification settings.
            // https://learn.microsoft.com/windows/apps/develop/notifications/app-notifications/send-local-toast-other-apps
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Software\\Classes\\AppUserModelId\\" + nativeApplicationId))
            {
                key.SetValue("DisplayName", title ?? applicationId, RegistryValueKind.String);
                key.SetValue("CustomActivator", nativeClassId.ToString("B"), RegistryValueKind.String);
                if (!String.IsNullOrEmpty(iconPath)) key.SetValue("IconUri", iconPath, RegistryValueKind.String);
                else key.DeleteValue("IconUri", false);
            }
        }

        private Guid ReadIdentity()
        {
            Directory.CreateDirectory(profileDirectory);
            string identityPath = Path.Combine(profileDirectory, "arcane-notification-identity.json");
            Guid identity = Guid.NewGuid();
            FileStream output;
            try { output = new FileStream(identityPath, FileMode.CreateNew, FileAccess.Write, FileShare.None); }
            catch (IOException)
            {
                if (!File.Exists(identityPath)) throw;
                Dictionary<string, object> saved;
                using (FileStream input = new FileStream(identityPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (StreamReader reader = new StreamReader(input))
                    saved = ArcaneHost.Serializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                return Guid.Parse(RequiredString(saved, "identity"));
            }
            using (output)
            using (StreamWriter writer = new StreamWriter(output, new UTF8Encoding(false)))
                writer.Write(ArcaneHost.Serializer().Serialize(new Dictionary<string, object> { { "identity", identity.ToString("D") } }));
            return identity;
        }

        private void InstallShortcut()
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            if (String.IsNullOrEmpty(programs)) throw new InvalidOperationException("Windows did not provide the user's Start menu Programs directory.");
            Directory.CreateDirectory(programs);
            string shortcut = Path.Combine(programs, "Arcane Notifications " + nativeClassId.ToString("N") + ".lnk");
            object linkObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
            List<Exception> errors = new List<Exception>();
            try
            {
                IShellLink link = (IShellLink)linkObject;
                using (Process process = Process.GetCurrentProcess()) link.SetPath(process.MainModule.FileName);
                link.SetDescription(title ?? applicationId);
                if (!String.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, 0);
                IPropertyStore properties = (IPropertyStore)linkObject;
                PropertyKey appIdKey = new PropertyKey(5);
                PropertyKey activatorKey = new PropertyKey(26);
                PropertyVariant appId = PropertyVariant.FromString(nativeApplicationId);
                SetProperty(properties, ref appIdKey, ref appId);
                PropertyVariant classId = PropertyVariant.FromGuid(nativeClassId);
                SetProperty(properties, ref activatorKey, ref classId);
                properties.Commit();
                ((System.Runtime.InteropServices.ComTypes.IPersistFile)linkObject).Save(shortcut, true);
            }
            catch (Exception error) { errors.Add(error); }
            try { Marshal.ReleaseComObject(linkObject); }
            catch (Exception error) { errors.Add(error); }
            if (errors.Count != 0) throw new AggregateException("Windows notification shortcut registration failed.", errors);
        }

        private static void SetProperty(IPropertyStore properties, ref PropertyKey key, ref PropertyVariant value)
        {
            List<Exception> errors = new List<Exception>();
            try { properties.SetValue(ref key, ref value); }
            catch (Exception error) { errors.Add(error); }
            try { Marshal.ThrowExceptionForHR(Native.PropVariantClear(ref value)); }
            catch (Exception error) { errors.Add(error); }
            if (errors.Count != 0) throw new AggregateException("Windows notification shortcut property operation failed.", errors);
        }

        private Dictionary<string, object> Show(Dictionary<string, object> parameters, CancellationToken cancellation)
        {
            string id = RequiredString(parameters, "id");
            string notificationTitle = RequiredString(parameters, "title");
            string body = RequiredString(parameters, "body");
            Notice existing;
            if (notices.TryGetValue(id, out existing))
            {
                Exception duplicate = Error("NOTIFICATION_ID_EXISTS", "This notification ID was already accepted during the current host lifetime.");
                duplicate.Data["existing"] = Record(existing);
                throw duplicate;
            }
            object data;
            parameters.TryGetValue("data", out data);
            // A fresh native correlation also keeps clicks on notices from a crashed
            // prior host from being attributed to a new caller with the same ID.
            Notice notice = new Notice(this, id, notificationTitle, body, data, Guid.NewGuid().ToString("N"));
            notices.Add(id, notice);
            nativeNotices.Add(notice.NativeId, notice);
            orderedNotices.Add(notice);
            Publish(notice, "pending", "accepted", null, null);
            try
            {
                TryInitialize();
                if (!initialized)
                {
                    Exception unavailable = new InvalidOperationException("Windows notifications are unavailable: " + unavailableReason, initializationError);
                    unavailable.Data["code"] = "NOTIFICATIONS_UNAVAILABLE";
                    unavailable.Data["reason"] = unavailableReason;
                    throw unavailable;
                }
                NotificationSetting setting = notifier.Setting;
                if (setting != NotificationSetting.Enabled)
                {
                    Exception disabled = Error("NOTIFICATIONS_PERMISSION_DISABLED", "Windows notifications are disabled: " + setting);
                    disabled.Data["setting"] = setting.ToString();
                    throw disabled;
                }
                XmlDocument xml = new XmlDocument();
                XmlElement toastElement = xml.CreateElement("toast");
                toastElement.SetAttribute("launch", notice.NativeId);
                xml.AppendChild(toastElement);
                XmlElement visual = xml.CreateElement("visual");
                XmlElement binding = xml.CreateElement("binding");
                binding.SetAttribute("template", "ToastGeneric");
                AddText(xml, binding, notice.Title);
                AddText(xml, binding, notice.Body);
                visual.AppendChild(binding);
                toastElement.AppendChild(visual);
                XmlElement audio = xml.CreateElement("audio");
                audio.SetAttribute("silent", "true");
                toastElement.AppendChild(audio);
                notice.Toast = new ToastNotification(xml) { Tag = notice.NativeId, Group = "arcane" };
                notice.Toast.Activated += notice.Activated;
                notice.ActivatedAttached = true;
                notice.Toast.Dismissed += notice.Dismissed;
                notice.DismissedAttached = true;
                notice.Toast.Failed += notice.Failed;
                notice.FailedAttached = true;
                cancellation.ThrowIfCancellationRequested();
                notice.ShowAttempted = true;
                notifier.Show(notice.Toast);
                // Cancellation after this call cannot retract a possible interaction.
                notice.SubmittedAt = Now();
                Publish(notice, "submitted", "submitted", null, null);
                return Record(notice);
            }
            catch (Exception error)
            {
                List<Exception> errors = new List<Exception> { error };
                // Before Show, Windows cannot own this notice. Once Show has been
                // attempted, retain callbacks until explicit removal or shutdown,
                // including the ambiguous case where that native call throws.
                if (!notice.ShowAttempted) DetachCallbacks(notice, errors);
                Exception failure = errors.Count == 1 ? error : new AggregateException("Notification submission and callback cleanup failed.", errors);
                string state = error is OperationCanceledException ? "cancelled" : "failed";
                Publish(notice, state, state, null, failure);
                failure.Data["notification"] = Record(notice);
                if (!Object.ReferenceEquals(failure, error)) throw failure;
                throw;
            }
        }

        private static void AddText(XmlDocument xml, XmlElement binding, string content)
        {
            XmlElement text = xml.CreateElement("text");
            text.AppendChild(xml.CreateTextNode(content));
            binding.AppendChild(text);
        }

        private Dictionary<string, object> Snapshot(Dictionary<string, object> parameters)
        {
            object requestedId;
            bool filtered = parameters != null && parameters.TryGetValue("id", out requestedId);
            string id = filtered ? RequiredString(parameters, "id") : null;
            List<object> records = new List<object>();
            foreach (Notice notice in orderedNotices)
                if (!filtered || notice.Id == id) records.Add(Record(notice));
            return new Dictionary<string, object>
            {
                { "revision", revision }, { "notifications", records }, { "errors", LifetimeErrorRecords() }
            };
        }

        private Notice FindNotice(string id)
        {
            Notice notice;
            if (!notices.TryGetValue(id, out notice)) throw Error("NOTIFICATION_NOT_FOUND", "No notification has this ID in the current host lifetime.");
            return notice;
        }

        private Dictionary<string, object> CloseNotice(Notice notice)
        {
            if (notice.Closed) return Record(notice);
            List<Exception> errors = new List<Exception>();
            notice.CloseRequestedAt = Now();
            if (notice.ShowAttempted && notice.Toast != null && notifier != null)
            {
                try { notifier.Hide(notice.Toast); }
                catch (Exception error) { errors.Add(error); }
                try { ToastNotificationManager.History.Remove(notice.NativeId, "arcane", nativeApplicationId); }
                catch (Exception error) { errors.Add(error); }
            }
            // Successful native removal retires per-toast subscriptions. Already
            // queued events still drain, and the host-level COM correlation remains
            // available for a click that raced removal.
            if (errors.Count == 0) DetachCallbacks(notice, errors);
            if (errors.Count != 0)
            {
                AggregateException failure = new AggregateException("Windows could not complete notification removal.", errors);
                Publish(notice, "closeFailed", "closeFailed", null, failure);
                failure.Data["notification"] = Record(notice);
                throw failure;
            }
            notice.Closed = true;
            notice.ClosedAt = Now();
            Publish(notice, "closed", "closed", "application", null);
            return Record(notice);
        }

        private void Activated(Notice notice)
        {
            if (notice.ActivationObserved) return;
            notice.ActivationObserved = true;
            Publish(notice, notice.Closed ? notice.State : "activated", "activated", null, null);
        }

        private bool Activate(string aumid, string arguments)
        {
            return QueueCallback(delegate
            {
                Notice notice;
                if (aumid == nativeApplicationId && arguments != null && nativeNotices.TryGetValue(arguments, out notice)) Activated(notice);
                else throw new InvalidOperationException("Windows notification activation did not identify a notice owned by this host.");
            });
        }

        private void Publish(Notice notice, string state, string eventName, string reason, Exception error)
        {
            notice.State = state;
            notice.Event = eventName;
            notice.Revision = ++revision;
            notice.UpdatedAt = Now();
            notice.Reason = reason;
            if (error != null) notice.Error = ArcaneHost.ErrorRecord(error, "NOTIFICATION_FAILED");
            Dictionary<string, object> observed = new Dictionary<string, object>
            {
                { "event", eventName }, { "revision", revision }, { "timestamp", notice.UpdatedAt }
            };
            if (reason != null) observed["reason"] = reason;
            if (error != null) observed["error"] = notice.Error;
            notice.Events.Add(observed);
            if (changed == null) return;
            try { changed(Record(notice)); }
            catch (Exception deliveryError)
            {
                notice.DeliveryErrors.Add(ArcaneHost.ErrorRecord(deliveryError, "NOTIFICATION_EVENT_DELIVERY_FAILED"));
                RecordLifetimeError(deliveryError);
            }
        }

        private Dictionary<string, object> Record(Notice notice)
        {
            Dictionary<string, object> record = new Dictionary<string, object>
            {
                { "id", notice.Id }, { "title", notice.Title }, { "body", notice.Body }, { "data", notice.Data },
                { "state", notice.State }, { "event", notice.Event }, { "revision", notice.Revision },
                { "createdAt", notice.CreatedAt }, { "updatedAt", notice.UpdatedAt },
                { "events", new List<Dictionary<string, object>>(notice.Events) }
            };
            if (notice.SubmittedAt != null) record["submittedAt"] = notice.SubmittedAt;
            if (notice.CloseRequestedAt != null) record["closeRequestedAt"] = notice.CloseRequestedAt;
            if (notice.ClosedAt != null) record["closedAt"] = notice.ClosedAt;
            if (notice.Reason != null) record["reason"] = notice.Reason;
            if (notice.Error != null) record["error"] = notice.Error;
            if (notice.DeliveryErrors.Count != 0) record["deliveryErrors"] = new List<object>(notice.DeliveryErrors);
            return record;
        }

        private void Shutdown()
        {
            try
            {
                foreach (Notice notice in orderedNotices)
                {
                    try { CloseNotice(notice); }
                    catch (Exception error) { RecordLifetimeError(error); }
                    DetachCallbacks(notice, lifetimeErrors);
                }
                ReleaseNativeOwner(lifetimeErrors);
            }
            finally
            {
                lock (gate)
                {
                    callbacksOpen = false;
                    finishRequested = true;
                }
            }
        }

        private static void DetachCallbacks(Notice notice, List<Exception> errors)
        {
            if (notice.Toast == null) return;
            try
            {
                if (notice.ActivatedAttached) notice.Toast.Activated -= notice.Activated;
                notice.ActivatedAttached = false;
            }
            catch (Exception error) { errors.Add(error); }
            try
            {
                if (notice.DismissedAttached) notice.Toast.Dismissed -= notice.Dismissed;
                notice.DismissedAttached = false;
            }
            catch (Exception error) { errors.Add(error); }
            try
            {
                if (notice.FailedAttached) notice.Toast.Failed -= notice.Failed;
                notice.FailedAttached = false;
            }
            catch (Exception error) { errors.Add(error); }
            if (!notice.ActivatedAttached && !notice.DismissedAttached && !notice.FailedAttached) notice.Toast = null;
        }

        private void ReleaseNativeOwner(List<Exception> errors)
        {
            initialized = false;
            notifier = null;
            if (classRegistered)
            {
                try { Marshal.ThrowExceptionForHR(Native.CoRevokeClassObject(classCookie)); classRegistered = false; }
                catch (Exception error) { errors.Add(error); }
            }
            if (!classRegistered) factory = null;
            if (ownsMutex && !classRegistered)
            {
                try { nativeOwner.ReleaseMutex(); ownsMutex = false; }
                catch (Exception error) { errors.Add(error); }
            }
            if (nativeOwner != null && !ownsMutex)
            {
                try { nativeOwner.Dispose(); nativeOwner = null; }
                catch (Exception error) { errors.Add(error); }
            }
        }

        private void RecordLifetimeError(Exception error) { lifetimeErrors.Add(error); }
        private List<object> LifetimeErrorRecords()
        {
            List<object> errors = new List<object>();
            foreach (Exception error in lifetimeErrors) errors.Add(ArcaneHost.ErrorRecord(error, "NOTIFICATIONS_LIFETIME_FAILED"));
            return errors;
        }
        private static string Now() { return DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture); }

        private static string RequiredString(Dictionary<string, object> parameters, string name)
        {
            object value;
            if (parameters == null || !parameters.TryGetValue(name, out value) || !(value is string))
                throw Error("NOTIFICATIONS_ARGUMENT_REQUIRED", "Notification field '" + name + "' must be a string.");
            return (string)value;
        }

        private static Exception Error(string code, string message)
        {
            InvalidOperationException error = new InvalidOperationException(message);
            error.Data["code"] = code;
            return error;
        }

        private sealed class Work
        {
            internal readonly Action Run;
            internal readonly Action<Exception> Reject;
            internal Work(Action run, Action<Exception> reject) { Run = run; Reject = reject; }
        }

        private sealed class Notice
        {
            private readonly ArcaneNotifications owner;
            internal readonly string Id;
            internal readonly string Title;
            internal readonly string Body;
            internal readonly object Data;
            internal readonly string NativeId;
            internal readonly string CreatedAt = Now();
            internal readonly List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
            internal readonly List<object> DeliveryErrors = new List<object>();
            internal ToastNotification Toast;
            internal bool ActivatedAttached;
            internal bool DismissedAttached;
            internal bool FailedAttached;
            internal bool ShowAttempted;
            internal bool ActivationObserved;
            internal bool Closed;
            internal string State;
            internal string Event;
            internal long Revision;
            internal string UpdatedAt;
            internal string SubmittedAt;
            internal string CloseRequestedAt;
            internal string ClosedAt;
            internal string Reason;
            internal object Error;

            internal Notice(ArcaneNotifications owner, string id, string title, string body, object data, string nativeId)
            {
                this.owner = owner;
                Id = id; Title = title; Body = body; Data = data; NativeId = nativeId;
            }
            internal void Activated(ToastNotification sender, object arguments)
            {
                owner.QueueCallback(delegate { owner.Activated(this); });
            }
            internal void Dismissed(ToastNotification sender, ToastDismissedEventArgs arguments)
            {
                owner.QueueCallback(delegate { owner.Publish(this, Closed ? State : "dismissed", "dismissed", arguments.Reason.ToString(), null); });
            }
            internal void Failed(ToastNotification sender, ToastFailedEventArgs arguments)
            {
                owner.QueueCallback(delegate { owner.Publish(this, Closed ? State : "failed", "failed", null, arguments.ErrorCode); });
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PropertyKey
        {
            internal Guid Format;
            internal uint Id;
            internal PropertyKey(uint id) { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); Id = id; }
        }

        // The union layout follows the native PROPVARIANT ABI, including its blob member.
        [StructLayout(LayoutKind.Sequential)]
        private struct VariantBlob { internal uint Count; internal IntPtr Pointer; }
        [StructLayout(LayoutKind.Explicit)]
        private struct PropertyVariant
        {
            [FieldOffset(0)] internal ushort Type;
            [FieldOffset(8)] internal IntPtr Pointer;
            [FieldOffset(8)] internal VariantBlob Blob;
            internal static PropertyVariant FromString(string value)
            {
                return new PropertyVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(value) };
            }
            internal static PropertyVariant FromGuid(Guid value)
            {
                IntPtr memory = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(Guid)));
                Marshal.StructureToPtr(value, memory, false);
                return new PropertyVariant { Type = 72, Pointer = memory };
            }
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            void GetCount(out uint count);
            void GetAt(uint index, out PropertyKey key);
            void GetValue(ref PropertyKey key, out PropertyVariant value);
            void SetValue(ref PropertyKey key, ref PropertyVariant value);
            void Commit();
        }

        [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellLink
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr data, uint flags);
            void GetIDList(out IntPtr list);
            void SetIDList(IntPtr list);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out short key);
            void SetHotkey(short key);
            void GetShowCmd(out int command);
            void SetShowCmd(int command);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
        }

        private static class Native
        {
            [DllImport("ole32.dll")] internal static extern int CoInitializeEx(IntPtr reserved, uint flags);
            [DllImport("ole32.dll")] internal static extern void CoUninitialize();
            [DllImport("ole32.dll")] internal static extern int CoRegisterClassObject(ref Guid clsid,
                [MarshalAs(UnmanagedType.Interface)] ArcaneNotificationCom.IClassFactory factory, uint context, uint flags, out uint cookie);
            [DllImport("ole32.dll")] internal static extern int CoRevokeClassObject(uint cookie);
            [DllImport("ole32.dll")] internal static extern int PropVariantClear(ref PropertyVariant value);
        }
    }

    // COM callable interfaces must be public CLR types. The adapter and its
    // managed construction remain internal; these types implement only the OS ABI.
    public static class ArcaneNotificationCom
    {
        [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
        public sealed class Factory : IClassFactory
        {
            private readonly Callback callback;
            internal Factory(Func<string, string, bool> activate) { callback = new Callback(activate); }
            public int CreateInstance(IntPtr outer, ref Guid iid, out IntPtr instance)
            {
                instance = IntPtr.Zero;
                if (outer != IntPtr.Zero) return unchecked((int)0x80040110);
                IntPtr unknown = Marshal.GetIUnknownForObject(callback);
                try { return Marshal.QueryInterface(unknown, ref iid, out instance); }
                finally { Marshal.Release(unknown); }
            }
            public int LockServer(bool locked) { return 0; }
        }

        [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
        public sealed class Callback : INotificationActivationCallback
        {
            private readonly Func<string, string, bool> activate;
            internal Callback(Func<string, string, bool> activate) { this.activate = activate; }
            public int Activate(string aumid, string arguments, IntPtr inputs, uint count)
            {
                try { return activate(aumid, arguments) ? 0 : unchecked((int)0x800401FD); }
                catch (Exception error) { return Marshal.GetHRForException(error); }
            }
        }

        [ComVisible(true), Guid("00000001-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IClassFactory
        {
            [PreserveSig] int CreateInstance(IntPtr outer, ref Guid iid, out IntPtr instance);
            [PreserveSig] int LockServer([MarshalAs(UnmanagedType.Bool)] bool locked);
        }

        [ComVisible(true), Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface INotificationActivationCallback
        {
            [PreserveSig] int Activate([MarshalAs(UnmanagedType.LPWStr)] string aumid,
                [MarshalAs(UnmanagedType.LPWStr)] string arguments, IntPtr inputs, uint count);
        }
    }
}
