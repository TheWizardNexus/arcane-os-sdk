using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>Selected by the application launcher; no OS layout is inferred.</summary>
    public sealed class ArcaneHostOptions
    {
        public string ApplicationId { get; set; }
        public string ApplicationRoot { get; set; }
        public string StartPath { get; set; }
        public string OriginHost { get; set; }
        public string ProfileDirectory { get; set; }
        public string Title { get; set; }
        public string IconPath { get; set; }
        public string ClassicClientSource { get; set; }
        public string AppControlEndpoint { get; set; }
        public string AppControlSource { get; set; }
        public string CoreExecutable { get; set; }
        public string CoreArguments { get; set; }
        public string CoreWorkingDirectory { get; set; }
        /// <summary>Optional initial client dimensions in logical pixels at 96 DPI.</summary>
        public double? InitialClientWidth { get; set; }
        public double? InitialClientHeight { get; set; }
        public bool? Resizable { get; set; }
        public string InitialWindowState { get; set; }
    }

    public static class ArcaneHost
    {
        /// <summary>
        /// Called by an STA launcher after it resolves its own launch context.
        /// The message loop remains active while accepted Core work drains.
        /// </summary>
        public static void Run(ArcaneHostOptions options, Action<string> onDiagnostic,
            Action<Exception> onError = null)
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new InvalidOperationException("The Windows WebView2 host requires an STA entry point.");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (ArcaneHostForm window = new ArcaneHostForm(options, onDiagnostic, onError))
            {
                Application.Run(window);
                // FormClosing keeps the loop alive until this drain is complete.
                window.Completion.GetAwaiter().GetResult();
            }
        }

        internal static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = Int32.MaxValue };
        }

        internal static object ErrorRecord(Exception error, string code)
        {
            Dictionary<string, object> record = new Dictionary<string, object>
            {
                { "code", code }, { "name", error.GetType().FullName },
                { "message", error.Message }, { "stack", error.StackTrace },
                { "technicalMessage", error.ToString() }, { "hresult", error.HResult }
            };
            if (error.InnerException != null) record["cause"] = ErrorRecord(error.InnerException, code);
            AggregateException aggregate = error as AggregateException;
            if (aggregate != null)
            {
                List<object> errors = new List<object>();
                foreach (Exception inner in aggregate.InnerExceptions) errors.Add(ErrorRecord(inner, code));
                record["errors"] = errors;
            }
            if (error.Data.Count != 0)
            {
                List<object> entries = new List<object>();
                foreach (DictionaryEntry entry in error.Data)
                    entries.Add(new Dictionary<string, object> { { "key", entry.Key }, { "value", entry.Value } });
                record["data"] = entries;
            }
            return record;
        }
    }

    /// <summary>
    /// Owns one window and Core child. Call CloseAsync rather than disposing an
    /// active window. Diagnostics receive complete stderr and frames belonging
    /// to retired documents; errors stay outside ordinary application content.
    /// Callbacks must not synchronously wait for Ready, Completion or CloseAsync.
    /// </summary>
    public sealed partial class ArcaneHostForm : Form
    {
        private const string CancelRendererRequests = "{\"protocol\":\"arcane/1\",\"type\":\"control\",\"control\":\"requests.cancelAll\"}";
        private readonly ArcaneHostOptions options;
        private readonly Action<string> onDiagnostic;
        private readonly Action<Exception> onError;
        private readonly WebView2 webView;
        private readonly object stateLock = new object();
        private readonly Queue<CoreDelivery> pending = new Queue<CoreDelivery>();
        private readonly Dictionary<string, long> requestGenerations = new Dictionary<string, long>();
        private readonly Dictionary<string, DesktopNotificationRequest> desktopNotificationRequests =
            new Dictionary<string, DesktopNotificationRequest>();
        private readonly List<Exception> failures = new List<Exception>();
        private readonly List<Task> failureNotifications = new List<Task>();
        private readonly TaskCompletionSource<object> ready = new TaskCompletionSource<object>();
        private readonly TaskCompletionSource<object> initialized = new TaskCompletionSource<object>();
        private readonly TaskCompletionSource<object> completion = new TaskCompletionSource<object>();
        private ArcaneCoreProcess core;
        private ArcaneNotifications desktopNotifications;
        private Task desktopNotificationsClosing;
        private ArcaneBridge bridge;
        private ArcaneBridge activeBridge;
        private Task initialization;
        private Task coreLifetime;
        private Task shutdown;
        private Task iconLoading;
        private Icon applicationIcon;
        private string injectedScript;
        private Exception transportFailure;
        private long generation;
        private long nextGeneration;
        private long registeredGeneration;
        private long failureNotifiedGeneration = -1;
        private ulong navigationId;
        private bool started;
        private bool documentReady;
        private bool deliveryScheduled;
        private bool browserProcessExited;
        private bool closing;
        private bool closeAllowed;
        private WindowRestoreSnapshot fullscreenRestore;

        public ArcaneHostForm(ArcaneHostOptions options, Action<string> onDiagnostic,
            Action<Exception> onError = null)
        {
            if (options == null) throw new ArgumentNullException("options");
            if (onDiagnostic == null) throw new ArgumentNullException("onDiagnostic");
            ValidateInitialDimension(options.InitialClientWidth, "InitialClientWidth");
            ValidateInitialDimension(options.InitialClientHeight, "InitialClientHeight");
            if (options.InitialWindowState != null) ValidateWindowState(options.InitialWindowState);
            this.options = options;
            this.onDiagnostic = onDiagnostic;
            this.onError = onError;
            ready.Task.ContinueWith(ObserveReportedFailure, TaskContinuationOptions.OnlyOnFaulted);
            completion.Task.ContinueWith(ObserveReportedFailure, TaskContinuationOptions.OnlyOnFaulted);
            Text = options.Title;
            AutoScaleMode = AutoScaleMode.Dpi;
            if (options.Resizable.HasValue)
            {
                FormBorderStyle = options.Resizable.Value ? FormBorderStyle.Sizable : FormBorderStyle.FixedSingle;
                MaximizeBox = options.Resizable.Value;
            }
            webView = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(webView);
        }

        /// <summary>First document navigation completed; not model readiness.</summary>
        public Task Ready { get { return ready.Task; } }
        public Task Completion { get { return completion.Task; } }

        protected override void OnLoad(EventArgs args)
        {
            // Apply the initial choices before the composing launcher's Load
            // handler. Later app/user sizing remains application-owned.
            if (!started && !closing)
            {
                ApplyInitialWindowSize();
                if (options.InitialWindowState != null) ApplyWindowState(options.InitialWindowState);
            }
            base.OnLoad(args);
            if (started || closing) return;
            started = true;
            initialization = InitializeAsync();
            initialization.ContinueWith(ObserveUnexpectedFailure, TaskContinuationOptions.OnlyOnFaulted);
        }

        private static void ValidateInitialDimension(double? value, string name)
        {
            if (value.HasValue && (Double.IsNaN(value.Value) || Double.IsInfinity(value.Value)
                || value.Value <= 0 || Math.Truncate(value.Value) != value.Value))
                throw new ArgumentOutOfRangeException(name, "Select a positive integral logical client dimension.");
        }

        private void ApplyInitialWindowSize()
        {
            if ((!options.InitialClientWidth.HasValue && !options.InitialClientHeight.HasValue)
                || WindowState != FormWindowState.Normal) return;

            Rectangle workArea = Screen.FromControl(this).WorkingArea;
            int availableWidth = Math.Max(1, workArea.Width - (Width - ClientSize.Width));
            int availableHeight = Math.Max(1, workArea.Height - (Height - ClientSize.Height));
            using (Graphics display = CreateGraphics())
            {
                double width = options.InitialClientWidth.HasValue
                    ? options.InitialClientWidth.Value * display.DpiX / 96.0 : ClientSize.Width;
                double height = options.InitialClientHeight.HasValue
                    ? options.InitialClientHeight.Value * display.DpiY / 96.0 : ClientSize.Height;
                // Fit before converting to native integer coordinates. This is
                // an initial screen fit, not a persistent maximum window size.
                ClientSize = new Size(
                    (int)Math.Max(1, Math.Min(availableWidth, Math.Round(width))),
                    (int)Math.Max(1, Math.Min(availableHeight, Math.Round(height))));
            }
            Location = new Point(
                Math.Max(workArea.Left, Math.Min(Left, workArea.Right - Width)),
                Math.Max(workArea.Top, Math.Min(Top, workArea.Bottom - Height)));
        }

        private static void ValidateWindowState(string state)
        {
            if (state != "normal" && state != "maximized" && state != "fullscreen")
                throw new ArgumentException("Select window state normal, maximized, or fullscreen.");
        }

        private FormWindowState CurrentWindowState()
        {
            if (!IsHandleCreated) return WindowState;
            if (IsIconic(Handle)) return FormWindowState.Minimized;
            return IsZoomed(Handle) ? FormWindowState.Maximized : FormWindowState.Normal;
        }

        private string WindowStateName()
        {
            FormWindowState state = CurrentWindowState();
            if (state != FormWindowState.Normal) return state.ToString();
            return fullscreenRestore != null && FormBorderStyle == FormBorderStyle.None
                ? "Fullscreen" : "Normal";
        }

        private Dictionary<string, object> WindowStateRecord()
        {
            return new Dictionary<string, object>
            {
                { "platform", "windows" }, { "supported", true },
                { "state", WindowStateName().ToLowerInvariant() }
            };
        }

        private void ApplyWindowState(string state)
        {
            ValidateWindowState(state);
            bool visible = IsHandleCreated && IsWindowVisible(Handle);
            if (visible && state == WindowStateName().ToLowerInvariant()
                && (state == "fullscreen" || fullscreenRestore == null)) return;
            // Initial hidden configuration keeps ordinary startup behavior. A
            // visible WinForms state setter can activate through ShowWindow.
            WindowStateTransition transition = visible ? new WindowStateTransition(this) : null;
            Exception mutationError = null;
            try { ChangeWindowState(state); }
            catch (Exception error)
            {
                mutationError = error;
                throw;
            }
            finally
            {
                Exception cleanupError = transition == null ? null : transition.Release();
                if (cleanupError != null)
                {
                    if (mutationError != null)
                        throw new AggregateException("Window state change and activation-hook cleanup failed.",
                            mutationError, cleanupError);
                    throw cleanupError;
                }
            }
        }

        private void ChangeWindowState(string state)
        {
            if (state == "fullscreen")
            {
                Rectangle screen = Screen.FromControl(this).Bounds;
                if (fullscreenRestore == null)
                {
                    fullscreenRestore = new WindowRestoreSnapshot(
                        CurrentWindowState() == FormWindowState.Normal ? Bounds : RestoreBounds,
                        FormBorderStyle, MinimizeBox, MaximizeBox, ControlBox);
                }
                // Retain the normal frame and bounds before removing chrome.
                // This affects this window only: no activation or TopMost.
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = screen;
                return;
            }

            if (fullscreenRestore != null)
            {
                // Restore normal geometry before maximizing so WinForms keeps
                // the same restore bounds for a later Normal selection.
                WindowState = FormWindowState.Normal;
                FormBorderStyle = fullscreenRestore.BorderStyle;
                MinimizeBox = fullscreenRestore.MinimizeBox;
                MaximizeBox = fullscreenRestore.MaximizeBox;
                ControlBox = fullscreenRestore.ControlBox;
                Bounds = fullscreenRestore.Bounds;
                fullscreenRestore = null;
            }
            WindowState = state == "maximized" ? FormWindowState.Maximized : FormWindowState.Normal;
        }

        private string WindowStateResponse(Dictionary<string, object> request, string id, bool apply)
        {
            Dictionary<string, object> previous = WindowStateRecord();
            object parameters;
            request.TryGetValue("parameters", out parameters);
            Dictionary<string, object> response = new Dictionary<string, object>
            {
                { "protocol", "arcane/1" }, { "type", "response" }, { "id", id }
            };
            try
            {
                if (apply)
                {
                    Dictionary<string, object> selection = parameters as Dictionary<string, object>;
                    object state;
                    if (selection == null || !selection.TryGetValue("state", out state) || !(state is string))
                        throw new ArgumentException("Supply a window state selection.");
                    ApplyWindowState((string)state);
                }
                response["ok"] = true;
                response["result"] = WindowStateRecord();
            }
            catch (Exception error)
            {
                Dictionary<string, object> record = (Dictionary<string, object>)ArcaneHost.ErrorRecord(error,
                    error is ArgumentException ? "INVALID_ARGUMENT" : "ARCANE_WINDOW_STATE_FAILED");
                record["details"] = new Dictionary<string, object>
                {
                    { "requested", parameters }, { "previous", previous }, { "actual", WindowStateRecord() }
                };
                response["ok"] = false;
                response["error"] = record;
            }
            return ArcaneHost.Serializer().Serialize(response);
        }

        private sealed class WindowRestoreSnapshot
        {
            internal readonly Rectangle Bounds;
            internal readonly FormBorderStyle BorderStyle;
            internal readonly bool MinimizeBox;
            internal readonly bool MaximizeBox;
            internal readonly bool ControlBox;

            internal WindowRestoreSnapshot(Rectangle bounds, FormBorderStyle borderStyle,
                bool minimizeBox, bool maximizeBox, bool controlBox)
            {
                Bounds = bounds;
                BorderStyle = borderStyle;
                MinimizeBox = minimizeBox;
                MaximizeBox = maximizeBox;
                ControlBox = controlBox;
            }
        }

        private sealed class WindowStateTransition
        {
            private const int WhCbt = 5;
            private const int HcbtActivate = 5;
            private const int HcbtSetFocus = 9;
            private delegate IntPtr HookProcedure(int code, IntPtr target, IntPtr details);
            // A failed native unhook must never retain a collected delegate.
            private static readonly HookProcedure callback = BeforeWindowChange;
            [ThreadStatic] private static WindowStateTransition current;
            [ThreadStatic] private static List<WindowStateTransition> pendingCleanup;
            private readonly ArcaneHostForm owner;
            private readonly WindowStateTransition previous;
            private IntPtr hook;
            private bool active;

            internal WindowStateTransition(ArcaneHostForm owner)
            {
                this.owner = owner;
                previous = current;
                hook = SetWindowsHookEx(WhCbt, callback, IntPtr.Zero, GetCurrentThreadId());
                if (hook == IntPtr.Zero)
                {
                    int code = Marshal.GetLastWin32Error();
                    System.ComponentModel.Win32Exception error = new System.ComponentModel.Win32Exception(code);
                    error.Data["operation"] = "SetWindowsHookExW";
                    error.Data["nativeErrorCode"] = code;
                    throw error;
                }
                active = true;
                current = this;
            }

            private static IntPtr BeforeWindowChange(int code, IntPtr target, IntPtr details)
            {
                if (code == HcbtActivate || code == HcbtSetFocus)
                {
                    for (WindowStateTransition transition = current; transition != null; transition = transition.previous)
                    {
                        if (!transition.active || !transition.owner.IsHandleCreated) continue;
                        IntPtr window = transition.owner.Handle;
                        if (target == window || (code == HcbtSetFocus && IsChild(window, target)))
                            return new IntPtr(1);
                    }
                }
                return CallNextHookEx(IntPtr.Zero, code, target, details);
            }

            internal Exception Release()
            {
                // Stop vetoing immediately, even if the native unhook fails.
                active = false;
                if (current == this) current = previous;
                if (hook == IntPtr.Zero) return null;
                if (UnhookWindowsHookEx(hook))
                {
                    hook = IntPtr.Zero;
                    if (pendingCleanup != null) pendingCleanup.Remove(this);
                    return null;
                }
                int code = Marshal.GetLastWin32Error();
                if (pendingCleanup == null) pendingCleanup = new List<WindowStateTransition>();
                if (!pendingCleanup.Contains(this)) pendingCleanup.Add(this);
                System.ComponentModel.Win32Exception error = new System.ComponentModel.Win32Exception(code);
                error.Data["operation"] = "UnhookWindowsHookEx";
                error.Data["nativeErrorCode"] = code;
                return error;
            }

            internal static void ReleasePending(ArcaneHostForm owner)
            {
                if (pendingCleanup == null) return;
                foreach (WindowStateTransition transition in pendingCleanup.ToArray())
                {
                    if (transition.owner != owner) continue;
                    Exception error = transition.Release();
                    if (error != null) owner.Report(error);
                }
            }

            [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
            private static extern IntPtr SetWindowsHookEx(int kind, HookProcedure procedure, IntPtr module, uint threadId);

            [DllImport("user32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            private static extern bool UnhookWindowsHookEx(IntPtr hook);

            [DllImport("user32.dll")]
            private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr target, IntPtr details);

            [DllImport("user32.dll")]
            [return: MarshalAs(UnmanagedType.Bool)]
            private static extern bool IsChild(IntPtr parent, IntPtr child);

            [DllImport("kernel32.dll")]
            private static extern uint GetCurrentThreadId();
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsZoomed(IntPtr window);

        private async Task InitializeAsync()
        {
            try
            {
                if (String.IsNullOrWhiteSpace(options.ApplicationRoot)) throw new ArgumentException("Select the application root.");
                if (String.IsNullOrWhiteSpace(options.ProfileDirectory)) throw new ArgumentException("Select the WebView2 profile directory.");
                if (String.IsNullOrWhiteSpace(options.OriginHost)) throw new ArgumentException("Select the application's stable virtual origin host.");
                if (String.IsNullOrEmpty(options.StartPath)) throw new ArgumentException("Select the application start path.");
                if (String.IsNullOrEmpty(options.ClassicClientSource)) throw new ArgumentException("Supply the SDK-generated classic Core client.");
                string applicationRoot = Path.GetFullPath(options.ApplicationRoot);
                if (!Directory.Exists(applicationRoot)) throw new DirectoryNotFoundException(applicationRoot);
                string profile = Path.GetFullPath(options.ProfileDirectory);
                Uri origin = new UriBuilder(Uri.UriSchemeHttps, options.OriginHost).Uri;
                Uri start = new Uri(origin, options.StartPath);
                StartAppControl();
                iconLoading = LoadApplicationIconAsync();
                iconLoading.ContinueWith(ObserveUnexpectedFailure, TaskContinuationOptions.OnlyOnFaulted);
                core = ArcaneCoreProcess.Start(options.CoreExecutable, options.CoreArguments,
                    options.CoreWorkingDirectory, ReceiveCoreMessage, DeliverDiagnostic, CoreFailed);
                coreLifetime = ObserveCoreLifetimeAsync();
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                if (closing) return;
                await webView.EnsureCoreWebView2Async(environment);
                if (closing) return;
                CoreWebView2 browser = webView.CoreWebView2;
                browser.SetVirtualHostNameToFolderMapping(options.OriginHost, applicationRoot,
                    CoreWebView2HostResourceAccessKind.Allow);
                InstallDocumentBridge(generation);
                // The selected generator uses replayRuntimeState:true. Both RPC
                // installation and the shared event owner remain SDK-owned.
                Task scripts = Task.WhenAll(InstallClassicClientAsync(browser), InstallAppControlAsync(browser));
                try { await scripts; }
                catch
                {
                    if (scripts.Exception != null) throw scripts.Exception;
                    throw;
                }
                if (closing) return;
                browser.NavigationStarting += NavigationStarting;
                browser.NavigationCompleted += NavigationCompleted;
                browser.ProcessFailed += BrowserProcessFailed;
                browser.Navigate(start.AbsoluteUri);
            }
            catch (Exception error)
            {
                Report(error);
                ready.TrySetException(error);
                BeginClose();
            }
            finally { initialized.TrySetResult(null); }
        }

        private async Task InstallClassicClientAsync(CoreWebView2 browser)
        {
            injectedScript = await browser.AddScriptToExecuteOnDocumentCreatedAsync(options.ClassicClientSource);
        }

        private void NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            if (nextGeneration != 0 && navigationId == args.NavigationId) return;
            navigationId = args.NavigationId;
            if (!closing)
            {
                // An attempted navigation can be cancelled while the original
                // document survives. Its captured bridge remains usable until
                // the next document's SDK client actually connects.
                try { InstallDocumentBridge(++nextGeneration); }
                catch (Exception error) { CoreFailed(error); }
            }
        }

        private void InstallDocumentBridge(long documentGeneration)
        {
            if (bridge != null)
            {
                if (bridge != activeBridge)
                    bridge.Stop(new OperationCanceledException("The pending document navigation was replaced."));
                webView.CoreWebView2.RemoveHostObjectFromScript("arcaneBridge");
            }
            bridge = new ArcaneBridge(delegate(string json) { return SendDocumentMessage(documentGeneration, json); }, CoreFailed,
                delegate { DocumentConnected(documentGeneration); });
            registeredGeneration = documentGeneration;
            if (transportFailure != null) bridge.Stop(transportFailure);
            webView.CoreWebView2.AddHostObjectToScript("arcaneBridge", bridge);
        }

        private Task SendDocumentMessage(long documentGeneration, string json)
        {
            Dictionary<string, object> envelope = ReadEnvelope(json);
            string requestId = EnvelopeString(envelope, "type") == "request" ? EnvelopeString(envelope, "id") : null;
            lock (stateLock)
            {
                if (documentGeneration != generation || closing)
                    throw new InvalidOperationException("The requesting document is no longer connected.");
                string method = EnvelopeString(envelope, "method");
                if (EnvelopeString(envelope, "protocol") == "arcane/1")
                {
                    if (requestId != null && (method == "notifications.status" || method == "notifications.show"
                        || method == "notifications.state" || method == "notifications.close"))
                    {
                        DesktopNotificationRequest operation = new DesktopNotificationRequest(documentGeneration);
                        desktopNotificationRequests.Add(requestId, operation);
                        operation.Completion = CompleteDesktopNotificationAsync(envelope, requestId, method, operation);
                        operation.Completion.ContinueWith(ObserveUnexpectedFailure, TaskContinuationOptions.OnlyOnFaulted);
                        // Bridge acceptance means this host owns the request;
                        // the correlated response carries its native outcome.
                        return Task.FromResult<object>(null);
                    }
                    if (EnvelopeString(envelope, "type") == "control")
                    {
                        string control = EnvelopeString(envelope, "control");
                        DesktopNotificationRequest selected;
                        if (control == "request.cancel" && desktopNotificationRequests.TryGetValue(
                            EnvelopeString(envelope, "requestId") ?? String.Empty, out selected)
                            && selected.Generation == documentGeneration)
                        {
                            selected.Cancellation.Cancel();
                            return Task.FromResult<object>(null);
                        }
                        if (control == "requests.cancelAll") CancelDesktopNotificationRequests(documentGeneration);
                    }
                }
                if (requestId != null && EnvelopeString(envelope, "protocol") == "arcane/1"
                    && (method == "window.setTheme" || method == "window.state" || method == "window.setState"))
                {
                    // This method belongs to this exact window, not the Core
                    // child or a machine-wide appearance service.
                    string response = method == "window.setTheme"
                        ? WindowThemeResponse(envelope, requestId)
                        : WindowStateResponse(envelope, requestId, method == "window.setState");
                    pending.Enqueue(
                        new CoreDelivery(documentGeneration, response)
                    );
                    ScheduleDelivery();
                    return Task.FromResult<object>(null);
                }
                Task accepted = core.SendAsync(json);
                // Hold the same lock used by the reader so an immediate response
                // cannot overtake its accepted transport correlation record.
                if (requestId != null && !accepted.IsFaulted && !accepted.IsCanceled)
                    requestGenerations[requestId] = documentGeneration;
                return accepted;
            }
        }

        private async Task CompleteDesktopNotificationAsync(Dictionary<string, object> request,
            string id, string method, DesktopNotificationRequest operation)
        {
            try
            {
                Dictionary<string, object> response = new Dictionary<string, object>
                {
                    { "protocol", "arcane/1" }, { "type", "response" }, { "id", id }
                };
                try
                {
                    object value;
                    Dictionary<string, object> parameters = request.TryGetValue("parameters", out value)
                        ? value as Dictionary<string, object> : new Dictionary<string, object>();
                    if (parameters == null) throw new ArgumentException("Supply a notification request object.");
                    if (desktopNotifications == null)
                        desktopNotifications = new ArcaneNotifications(options.ApplicationId, options.ProfileDirectory,
                            options.Title, options.IconPath, DesktopNotificationChanged);
                    Dictionary<string, object> result = await desktopNotifications.InvokeAsync(
                        method, parameters, operation.Cancellation.Token).ConfigureAwait(false);
                    // Cancellation after native submission does not rewrite an
                    // accepted result. Its record also remains in host state.
                    response["ok"] = true;
                    response["result"] = result;
                }
                catch (Exception error)
                {
                    string code = error.Data["code"] as string;
                    if (code == null) code = error is OperationCanceledException ? "CANCELLED"
                        : error is ArgumentException ? "INVALID_ARGUMENT" : "ARCANE_NOTIFICATION_FAILED";
                    response["ok"] = false;
                    response["error"] = ArcaneHost.ErrorRecord(error, code);
                }
                response["time"] = DateTime.UtcNow.ToString("o");
                string json = ArcaneHost.Serializer().Serialize(response);
                lock (stateLock) pending.Enqueue(new CoreDelivery(operation.Generation, json));
                ScheduleDelivery();
            }
            catch (Exception error)
            {
                // A bridge-accepted request must receive its response or the
                // owning transport failure, including serialization failures.
                CoreFailed(error);
            }
            finally
            {
                lock (stateLock)
                {
                    desktopNotificationRequests.Remove(id);
                    operation.Cancellation.Dispose();
                }
            }
        }

        private void DesktopNotificationChanged(Dictionary<string, object> record)
        {
            string json = ArcaneHost.Serializer().Serialize(new Dictionary<string, object>
            {
                { "protocol", "arcane/1" }, { "type", "event" },
                { "event", "notifications.state" }, { "data", record }, { "time", DateTime.UtcNow.ToString("o") }
            });
            lock (stateLock) pending.Enqueue(new CoreDelivery(generation, json));
            ScheduleDelivery();
        }

        private void CancelDesktopNotificationRequests(long? documentGeneration)
        {
            lock (stateLock)
            {
                // Cancellation can settle a queued operation synchronously;
                // iterate a snapshot while its completion removes correlation.
                foreach (DesktopNotificationRequest operation in
                    new List<DesktopNotificationRequest>(desktopNotificationRequests.Values))
                    if (!documentGeneration.HasValue || operation.Generation == documentGeneration.Value)
                        operation.Cancellation.Cancel();
            }
        }

        private void StopDesktopNotifications()
        {
            CancelDesktopNotificationRequests(null);
            if (desktopNotifications == null || desktopNotificationsClosing != null) return;
            try { desktopNotificationsClosing = desktopNotifications.CloseAsync(); }
            catch (Exception error) { Report(error); }
        }

        private async Task DrainDesktopNotificationsAsync()
        {
            List<Task> operations = new List<Task>();
            lock (stateLock)
            {
                foreach (DesktopNotificationRequest operation in desktopNotificationRequests.Values)
                    operations.Add(operation.Completion);
            }
            if (desktopNotificationsClosing != null) operations.Add(desktopNotificationsClosing);
            Task settled = Task.WhenAll(operations);
            try { await settled; }
            catch (Exception error) { ReportTaskFailure(settled, error); }
        }

        private sealed class DesktopNotificationRequest
        {
            internal readonly long Generation;
            internal readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
            internal Task Completion;

            internal DesktopNotificationRequest(long generation) { Generation = generation; }
        }

        private async Task LoadApplicationIconAsync()
        {
            if (String.IsNullOrEmpty(options.IconPath)) return;
            try
            {
                Icon loaded = await Task.Run(new Func<Icon>(ReadApplicationIcon));
                if (closing)
                {
                    loaded.Dispose();
                    return;
                }
                applicationIcon = loaded;
                Icon = loaded;
            }
            catch (Exception error)
            {
                // Image codec availability is separate from application
                // execution. Preserve ordinary startup and complete diagnostics.
                object record = ArcaneHost.ErrorRecord(error, "ARCANE_WINDOW_ICON_UNAVAILABLE");
                string diagnostic = ArcaneHost.Serializer().Serialize(record);
                DeliverDiagnostic(diagnostic + Environment.NewLine);
            }
        }

        private Icon ReadApplicationIcon()
        {
            string extension = Path.GetExtension(options.IconPath);
            if (String.Equals(extension, ".ico", StringComparison.OrdinalIgnoreCase))
                return new Icon(options.IconPath);
            using (Bitmap bitmap = new Bitmap(options.IconPath))
            {
                IntPtr handle = bitmap.GetHicon();
                try
                {
                    using (Icon borrowed = System.Drawing.Icon.FromHandle(handle))
                    {
                        return (Icon)borrowed.Clone();
                    }
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        private string WindowThemeResponse(Dictionary<string, object> request, string id)
        {
            Dictionary<string, object> applied = new Dictionary<string, object>();
            List<string> unsupported = new List<string>();
            Dictionary<string, object> response = new Dictionary<string, object>
            {
                { "protocol", "arcane/1" },
                { "type", "response" },
                { "id", id }
            };
            try
            {
                object parameters;
                Dictionary<string, object> presentation = request.TryGetValue("parameters", out parameters)
                    ? parameters as Dictionary<string, object> : null;
                if (presentation == null) throw new ArgumentException("Window presentation must be an object.");
                ApplyWindowColor(presentation, "backgroundColor", 35, applied, unsupported);
                ApplyWindowColor(presentation, "textColor", 36, applied, unsupported);
                response["ok"] = true;
                response["result"] = new Dictionary<string, object>
                {
                    { "platform", "windows" },
                    { "supported", applied.Count != 0 },
                    { "applied", applied },
                    { "unsupported", unsupported }
                };
            }
            catch (Exception error)
            {
                Dictionary<string, object> record = (Dictionary<string, object>)ArcaneHost.ErrorRecord(error,
                    error is ArgumentException ? "INVALID_ARGUMENT" : "ARCANE_WINDOW_THEME_FAILED");
                record["details"] = new Dictionary<string, object>
                {
                    { "applied", applied },
                    { "unsupported", unsupported }
                };
                response["ok"] = false;
                response["error"] = record;
            }
            return ArcaneHost.Serializer().Serialize(response);
        }

        private void ApplyWindowColor(Dictionary<string, object> presentation, string field, int attribute,
            Dictionary<string, object> applied, List<string> unsupported)
        {
            object supplied;
            if (!presentation.TryGetValue(field, out supplied)) return;
            uint nativeColor = UInt32.MaxValue;
            object accepted = null;
            double alpha = 1;
            if (supplied != null)
            {
                Dictionary<string, object> color = supplied as Dictionary<string, object>;
                if (color == null) throw new ArgumentException(field + " must be an RGBA record or null.");
                int red = (int)Math.Round(
                    ColorChannel(color, "red", 255),
                    MidpointRounding.AwayFromZero
                );
                int green = (int)Math.Round(
                    ColorChannel(color, "green", 255),
                    MidpointRounding.AwayFromZero
                );
                int blue = (int)Math.Round(
                    ColorChannel(color, "blue", 255),
                    MidpointRounding.AwayFromZero
                );
                alpha = ColorChannel(color, "alpha", 1);
                nativeColor = (uint)(red | green << 8 | blue << 16);
                accepted = new Dictionary<string, object>
                {
                    { "red", red },
                    { "green", green },
                    { "blue", blue },
                    { "alpha", alpha }
                };
            }
            if (alpha != 1 || !WindowColorsSupported())
            {
                unsupported.Add(field);
                return;
            }
            int result = DwmSetWindowAttribute(Handle, attribute, ref nativeColor, sizeof(uint));
            if (result < 0) throw new COMException("Applying window " + field + " failed.", result);
            applied[field] = accepted;
        }

        private static double ColorChannel(Dictionary<string, object> color, string name, double maximum)
        {
            object value;
            if (!color.TryGetValue(name, out value)
                || !(value is int || value is long || value is double || value is decimal))
                throw new ArgumentException("Window color " + name + " must be numeric.");
            double number = Convert.ToDouble(value);
            if (Double.IsNaN(number) || Double.IsInfinity(number) || number < 0 || number > maximum)
                throw new ArgumentException("Window color " + name + " is outside its color-channel range.");
            return number;
        }

        private static bool WindowColorsSupported()
        {
            WindowsVersion version = new WindowsVersion();
            version.StructureSize = (uint)Marshal.SizeOf(typeof(WindowsVersion));
            int result = RtlGetVersion(ref version);
            if (result != 0) throw new ExternalException("Reading the Windows version failed.", result);
            return version.Major > 10 || (version.Major == 10 && version.Build >= 22000);
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WindowsVersion
        {
            internal uint StructureSize;
            internal uint Major;
            internal uint Minor;
            internal uint Build;
            internal uint Platform;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            internal string ServicePack;
        }

        [DllImport("ntdll.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int RtlGetVersion(ref WindowsVersion version);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref uint value, int valueSize);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DestroyIcon(IntPtr icon);

        private void DocumentConnected(long documentGeneration)
        {
            ArcaneBridge previous;
            long previousGeneration;
            lock (stateLock)
            {
                if (closing) return;
                if (documentGeneration == generation && documentReady) return;
                if (documentGeneration != registeredGeneration) return;
                previous = activeBridge;
                previousGeneration = generation;
                generation = documentGeneration;
                activeBridge = bridge;
                documentReady = true;
            }
            if (previous != null && previous != activeBridge)
            {
                previous.Stop(new OperationCanceledException("The previous document has navigated away."));
                CancelDesktopNotificationRequests(previousGeneration);
                if (transportFailure == null)
                {
                    try { ObserveSend(core.SendAsync(CancelRendererRequests)); }
                    catch (Exception error) { CoreFailed(error); }
                }
            }
            // The canonical client attaches its message listener before its
            // first Send, even if the transport rejects that send. Listener
            // readiness is independent of write acceptance and page load.
            // WebView2 invokes its host objects on the owning UI thread.
            DrainRetiredFrames();
            ScheduleDelivery();
            if (transportFailure != null) NotifyTransportFailure();
        }

        private void NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (navigationId != args.NavigationId) return;
            if (!args.IsSuccess)
            {
                if (activeBridge != null && bridge != activeBridge)
                {
                    // No new SDK connection superseded the surviving document.
                    // Restore its registration without invalidating its existing
                    // JavaScript reference or changing its request generation.
                    try
                    {
                        bridge.Stop(new OperationCanceledException("The pending document navigation did not complete."));
                        webView.CoreWebView2.RemoveHostObjectFromScript("arcaneBridge");
                        bridge = activeBridge;
                        registeredGeneration = generation;
                        webView.CoreWebView2.AddHostObjectToScript("arcaneBridge", bridge);
                    }
                    catch (Exception restoreError) { CoreFailed(restoreError); }
                }
                IOException error = new IOException("Application navigation failed: " + args.WebErrorStatus + ".");
                Report(error);
                ready.TrySetException(error);
                return;
            }
            ready.TrySetResult(null);
        }

        private void BrowserProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs args)
        {
            CoreWebView2ProcessFailedKind kind = args.ProcessFailedKind;
            Exception error = new IOException("WebView2 process failed: " + kind + ".");
            try
            {
                // Read platform properties on their UI thread while this
                // notification is active. Do not retain a live COM wrapper in
                // an error that will later cross the JSON transport boundary.
                JavaScriptSerializer serializer = ArcaneHost.Serializer();
                error.Data["webView2ProcessFailure"] = serializer.DeserializeObject(serializer.Serialize(args));
            }
            catch (Exception diagnosticError)
            {
                error = new AggregateException("Reading WebView2 process-failure diagnostics failed.", error, diagnosticError);
            }
            if (kind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                // WebView2 has closed this browser. Complete the owned host
                // lifetime without trying to notify its vanished document.
                browserProcessExited = true;
                lock (stateLock)
                {
                    if (transportFailure == null) transportFailure = error;
                }
                Report(error);
                ready.TrySetException(error);
                if (bridge != null) bridge.Stop(error);
                if (activeBridge != null) activeBridge.Stop(error);
                BeginClose();
                return;
            }
            // Loss of the top-level renderer ends its bridge.
            // GPU/utility/plugin helpers recover independently; subframe loss,
            // unresponsiveness and unspecified failures remain full diagnostics.
            if (kind == CoreWebView2ProcessFailedKind.RenderProcessExited)
            {
                AppControlRendererExited();
                CoreFailed(error);
            }
            else Report(error);
        }

        private void ReceiveCoreMessage(string json)
        {
            Dictionary<string, object> envelope = ReadEnvelope(json);
            lock (stateLock)
            {
                long targetGeneration = generation;
                if (EnvelopeString(envelope, "type") == "response")
                {
                    string requestId = EnvelopeString(envelope, "id");
                    if (requestId == null || !requestGenerations.TryGetValue(requestId, out targetGeneration))
                        targetGeneration = -1;
                    else requestGenerations.Remove(requestId);
                }
                pending.Enqueue(new CoreDelivery(targetGeneration, json));
            }
            ScheduleDelivery();
        }

        private static Dictionary<string, object> ReadEnvelope(string json)
        {
            try { return ArcaneHost.Serializer().DeserializeObject(json) as Dictionary<string, object>; }
            catch (Exception error)
            {
                error.Data["coreMessage"] = json;
                throw;
            }
        }

        private static string EnvelopeString(Dictionary<string, object> envelope, string name)
        {
            object value;
            return envelope != null && envelope.TryGetValue(name, out value) ? value as string : null;
        }

        private void ScheduleDelivery()
        {
            lock (stateLock)
            {
                if (deliveryScheduled || pending.Count == 0 || (!documentReady && !closing)) return;
                deliveryScheduled = true;
            }
            PostToUi(DrainDeliveries);
        }

        private void DrainDeliveries()
        {
            while (true)
            {
                CoreDelivery delivery;
                bool current;
                lock (stateLock)
                {
                    if (pending.Count == 0 || (!documentReady && !closing))
                    {
                        deliveryScheduled = false;
                        return;
                    }
                    delivery = pending.Dequeue();
                    current = delivery.Generation == generation && !closing && transportFailure == null;
                }
                if (!current) { DeliverDiagnostic(delivery.Json); continue; }
                try { webView.CoreWebView2.PostWebMessageAsJson(delivery.Json); }
                catch (Exception error)
                {
                    error.Data["coreMessage"] = delivery.Json;
                    CoreFailed(error);
                }
            }
        }

        private void DrainRetiredFrames()
        {
            while (true)
            {
                CoreDelivery delivery;
                lock (stateLock)
                {
                    if (pending.Count == 0 || pending.Peek().Generation == generation) return;
                    delivery = pending.Dequeue();
                }
                DeliverDiagnostic(delivery.Json);
            }
        }

        private void CoreFailed(Exception error)
        {
            Report(error);
            lock (stateLock)
            {
                if (transportFailure == null) transportFailure = error;
            }
            PostToUi(HandleTransportFailure);
        }

        private void HandleTransportFailure()
        {
            if (IsDisposed) return;
            if (bridge != null) bridge.Stop(transportFailure);
            if (activeBridge != null) activeBridge.Stop(transportFailure);
            CancelDesktopNotificationRequests(null);
            NotifyTransportFailure();
            if (core != null) core.CloseAsync();
            ScheduleDelivery();
        }

        private void NotifyTransportFailure()
        {
            if (closing || browserProcessExited || !documentReady || webView.CoreWebView2 == null || transportFailure == null) return;
            if (failureNotifiedGeneration == generation) return;
            failureNotifiedGeneration = generation;
            Task failureNotification = NotifyTransportFailureAsync(transportFailure);
            failureNotifications.Add(failureNotification);
            failureNotification.ContinueWith(ObserveUnexpectedFailure, TaskContinuationOptions.OnlyOnFaulted);
        }

        private async Task NotifyTransportFailureAsync(Exception error)
        {
            string record = ArcaneHost.Serializer().Serialize(ArcaneHost.ErrorRecord(error, "ARCANE_NATIVE_TRANSPORT_FAILED"));
            // This callback is installed by the canonical client, which owns
            // rejection of pending requests and complete transport diagnostics.
            string result = await webView.CoreWebView2.ExecuteScriptAsync(
                "(function(){if(typeof globalThis.__arcaneTransportFailed!=='function')return false;"
                + "globalThis.__arcaneTransportFailed(" + record + ");return true;})()");
            if (result != "true")
                throw new InvalidOperationException("The injected SDK client has no transport-failure callback.", error);
        }

        private async Task ObserveCoreLifetimeAsync()
        {
            try { await core.Completion.ConfigureAwait(false); }
            catch (Exception error) { CoreFailed(error); }
        }

        private void ObserveSend(Task send)
        {
            send.ContinueWith(ObserveSendFailure, TaskContinuationOptions.OnlyOnFaulted);
        }

        private void ObserveSendFailure(Task send) { CoreFailed(send.Exception); }

        public Task CloseAsync()
        {
            PostToUi(BeginClose);
            return Completion;
        }

        private void BeginClose()
        {
            if (closing) return;
            lock (stateLock) closing = true;
            if (!started) initialized.TrySetResult(null);
            if (bridge != null) bridge.Stop(new InvalidOperationException("The application window is closing."));
            if (activeBridge != null) activeBridge.Stop(new InvalidOperationException("The application window is closing."));
            StopAppControl();
            StopDesktopNotifications();
            WindowStateTransition.ReleasePending(this);
            shutdown = DrainAndCloseAsync();
            shutdown.ContinueWith(ObserveUnexpectedFailure, TaskContinuationOptions.OnlyOnFaulted);
        }

        private async Task DrainAndCloseAsync()
        {
            await initialized.Task;
            if (core != null)
            {
                Task cancellation = Task.FromResult<object>(null);
                try
                {
                    if (transportFailure == null) cancellation = core.SendAsync(CancelRendererRequests);
                }
                catch (Exception error) { Report(error); }
                try { core.CloseAsync(); }
                catch (Exception error) { Report(error); }
                Task settled = Task.WhenAll(cancellation, core.Completion);
                try { await settled; }
                catch (Exception error) { ReportTaskFailure(settled, error); }
                if (coreLifetime != null)
                {
                    try { await coreLifetime; }
                    catch (Exception error) { ReportTaskFailure(coreLifetime, error); }
                }
            }
            await DrainAppControlAsync();
            await DrainDesktopNotificationsAsync();
            // Joining the independent image owner belongs after Core input has
            // closed; image I/O must never delay accepted service work draining.
            if (iconLoading != null)
            {
                try
                {
                    await iconLoading;
                }
                catch (Exception error)
                {
                    ReportTaskFailure(iconLoading, error);
                }
            }
            Task notifications = Task.WhenAll(failureNotifications);
            try { await notifications; }
            catch (Exception error) { ReportTaskFailure(notifications, error); }
            DrainDeliveries();
            // Cancellation does not release correlations: an accepted service
            // request can still finish after its renderer has gone away. All
            // remaining IDs belong to the child lifetime that just drained.
            lock (stateLock) requestGenerations.Clear();
            ready.TrySetCanceled();
            try
            {
                if (!browserProcessExited && webView.CoreWebView2 != null)
                {
                    webView.CoreWebView2.RemoveHostObjectFromScript("arcaneBridge");
                    if (injectedScript != null) webView.CoreWebView2.RemoveScriptToExecuteOnDocumentCreated(injectedScript);
                    if (appControlScript != null) webView.CoreWebView2.RemoveScriptToExecuteOnDocumentCreated(appControlScript);
                }
            }
            catch (Exception error) { Report(error); }
            closeAllowed = true;
            // Defer the final Close so a synchronous drain never recursively
            // closes the form inside its original FormClosing notification.
            try
            {
                if (IsHandleCreated) BeginInvoke(new Action(CloseDrainedWindow));
                else CloseDrainedWindow();
            }
            catch (Exception error) { Report(error); CompleteWindow(); }
        }

        private void CloseDrainedWindow()
        {
            try { Close(); }
            catch (Exception error) { Report(error); CompleteWindow(); }
            if (IsDisposed) CompleteWindow();
        }

        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            base.OnFormClosing(args);
            if (args.Cancel) return;
            if (closeAllowed) return;
            args.Cancel = true;
            BeginClose();
        }

        protected override void OnFormClosed(FormClosedEventArgs args)
        {
            base.OnFormClosed(args);
            if (applicationIcon != null)
            {
                applicationIcon.Dispose();
                applicationIcon = null;
            }
            CompleteWindow();
        }

        private void CompleteWindow()
        {
            Exception[] errors;
            lock (stateLock) errors = failures.ToArray();
            if (errors.Length == 0) completion.TrySetResult(null);
            else completion.TrySetException(new AggregateException("The Windows Core host closed with errors.", errors));
        }

        private void PostToUi(Action action)
        {
            if (IsDisposed) return;
            try
            {
                if (InvokeRequired) BeginInvoke(new Action(delegate { InvokeUiAction(action); }));
                else InvokeUiAction(action);
            }
            catch (Exception error) { Report(error); }
        }

        private void InvokeUiAction(Action action)
        {
            try { action(); }
            catch (Exception error) { Report(error); }
        }

        private void DeliverDiagnostic(string text)
        {
            try { onDiagnostic(text); }
            catch (Exception error)
            {
                IOException failure = new IOException("The host diagnostic callback failed.", error);
                failure.Data["diagnostic"] = text;
                Report(failure);
            }
        }

        private void Report(Exception error)
        {
            lock (stateLock)
            {
                if (failures.Contains(error)) return;
                failures.Add(error);
            }
            if (onError == null) return;
            try { onError(error); }
            catch (Exception callbackError)
            {
                lock (stateLock) failures.Add(callbackError);
            }
        }

        private void ObserveUnexpectedFailure(Task failed) { Report(failed.Exception); }
        private static void ObserveReportedFailure(Task failed) { failed.Exception.Handle(error => true); }

        private void ReportTaskFailure(Task task, Exception caught)
        {
            // Await reports one failure; retain every sibling task failure.
            // A cancelled task has no Exception and still needs observation.
            if (task.Exception == null) { Report(caught); return; }
            foreach (Exception error in task.Exception.InnerExceptions) Report(error);
        }

        private sealed class CoreDelivery
        {
            internal readonly long Generation;
            internal readonly string Json;
            internal CoreDelivery(long generation, string json) { Generation = generation; Json = json; }
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public sealed class ArcaneBridge
    {
        private readonly Func<string, Task> send;
        private readonly Action<Exception> onFailure;
        private readonly Action onConnected;
        private Exception stopped;

        internal ArcaneBridge(Func<string, Task> send, Action<Exception> onFailure, Action onConnected)
        {
            this.send = send;
            this.onFailure = onFailure;
            this.onConnected = onConnected;
        }

        internal void Stop(Exception reason) { Interlocked.CompareExchange(ref stopped, reason, null); }

        public string Send(string json)
        {
            try
            {
                // Calling Send proves the SDK listener is installed. Publish
                // that boundary even when Core failed before the first write,
                // so the client can observe the complete transport failure.
                onConnected();
                Exception unavailable = Volatile.Read(ref stopped);
                if (unavailable != null) return Rejected(unavailable);
                Task accepted = send(json);
                if (accepted.IsFaulted)
                {
                    Stop(accepted.Exception);
                    onFailure(accepted.Exception);
                    return Rejected(accepted.Exception);
                }
                if (accepted.IsCanceled)
                {
                    OperationCanceledException error = new OperationCanceledException("The Core transport write was cancelled.");
                    Stop(error);
                    onFailure(error);
                    return Rejected(error);
                }
                accepted.ContinueWith(SendCompleted, TaskScheduler.Default);
                // This acknowledges the ordered write queue, not RPC success.
                return "{\"accepted\":true}";
            }
            catch (Exception error)
            {
                Stop(error);
                onFailure(error);
                return Rejected(error);
            }
        }

        private void SendCompleted(Task sent)
        {
            if (sent.IsFaulted) { Stop(sent.Exception); onFailure(sent.Exception); }
            else if (sent.IsCanceled)
            {
                OperationCanceledException error = new OperationCanceledException("The Core transport write was cancelled.");
                Stop(error);
                onFailure(error);
            }
        }

        private static string Rejected(Exception error)
        {
            return ArcaneHost.Serializer().Serialize(new Dictionary<string, object>
            {
                { "accepted", false }, { "error", ArcaneHost.ErrorRecord(error, "ARCANE_BRIDGE_WRITE_FAILED") }
            });
        }
    }
}
