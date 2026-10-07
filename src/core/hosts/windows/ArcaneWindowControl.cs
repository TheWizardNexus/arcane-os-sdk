using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace Arcane.Core.Hosts.Windows
{
    // The form owns UI-thread dispatch and document lifetime. The pipe owner
    // handles only connections and framed requests, never another Core child.
    public sealed partial class ArcaneHostForm
    {
        private const string AppControlDocumentKey = "Symbol.for('arcane-os.app-control.document')";
        private readonly HashSet<Task> appControlDocumentTasks = new HashSet<Task>();
        private readonly SemaphoreSlim appControlKeyOwner = new SemaphoreSlim(1, 1);
        private ArcaneAppControl appControl;
        private Task appControlClosing;
        private string appControlScript;
        private string appControlDocument;
        private long appControlGeneration;
        private long appControlDocumentEpoch;
        private ulong appControlNavigationId;
        private bool appControlNavigating;

        private void StartAppControl()
        {
            if (options.AppControlEndpoint == null) return;
            if (String.IsNullOrEmpty(options.AppControlSource))
                throw new ArgumentException("Supply the SDK-generated app-control source for the selected endpoint.");
            appControl = new ArcaneAppControl(options.AppControlEndpoint, DispatchAppControl, DeliverDiagnostic, Report);
            appControl.Completion.ContinueWith(ObserveUnexpectedFailure, TaskContinuationOptions.OnlyOnFaulted);
        }

        private async Task InstallAppControlAsync(CoreWebView2 browser)
        {
            if (appControl == null) return;
            appControlScript = await browser.AddScriptToExecuteOnDocumentCreatedAsync(
                "globalThis[" + AppControlDocumentKey + "] = globalThis.crypto.randomUUID();");
            if (closing) return;
            browser.NavigationStarting += AppControlNavigationStarting;
            browser.NavigationCompleted += AppControlNavigationCompleted;
        }

        private void StopAppControl()
        {
            if (appControl == null || appControlClosing != null) return;
            appControlClosing = appControl.CloseAsync();
        }

        private async Task DrainAppControlAsync()
        {
            // Ingress stops in BeginClose. Join only after the existing Core
            // cancellation/close has started, with the UI pump still alive.
            if (appControlClosing != null)
            {
                try { await appControlClosing; }
                catch (Exception error) { ReportTaskFailure(appControlClosing, error); }
            }
            Task documents = Task.WhenAll(appControlDocumentTasks);
            try { await documents; }
            catch (Exception error) { ReportTaskFailure(documents, error); }
            appControlKeyOwner.Dispose();
        }

        private void AppControlNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            appControlNavigationId = args.NavigationId;
            appControlDocumentEpoch++;
            appControlNavigating = true;
        }

        private void AppControlNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (closing || browserProcessExited || args.NavigationId != appControlNavigationId) return;
            // A cancelled navigation may leave the old document alive. Read its
            // actual creation marker instead of treating every attempt as new.
            Task task = RefreshAppControlDocumentAsync(args.NavigationId, appControlDocumentEpoch);
            appControlDocumentTasks.Add(task);
            task.ContinueWith(AppControlDocumentSettled, CancellationToken.None,
                TaskContinuationOptions.None, TaskScheduler.FromCurrentSynchronizationContext());
        }

        private void AppControlRendererExited()
        {
            appControlDocumentEpoch++;
            appControlDocument = null;
            appControlNavigating = true;
        }

        private async Task RefreshAppControlDocumentAsync(ulong selectedNavigation, long selectedEpoch)
        {
            string json = await webView.CoreWebView2.ExecuteScriptAsync("globalThis[" + AppControlDocumentKey + "]");
            if (closing || browserProcessExited || selectedNavigation != appControlNavigationId
                || selectedEpoch != appControlDocumentEpoch) return;
            string current = ArcaneHost.Serializer().DeserializeObject(json) as string;
            if (current == null) throw new InvalidOperationException("The current document has no app-control lifecycle marker.");
            if (current != appControlDocument)
            {
                appControlDocument = current;
                appControlGeneration++;
            }
            appControlNavigating = false;
        }

        private void AppControlDocumentSettled(Task task)
        {
            appControlDocumentTasks.Remove(task);
            if (task.IsFaulted) ReportTaskFailure(task, task.Exception);
        }

        private Task<object> DispatchAppControl(string method, Dictionary<string, object> parameters,
            CancellationToken cancellation)
        {
            AppControlRequest request = new AppControlRequest(this, method, parameters, cancellation);
            try
            {
                // The form's owned message pump stays alive through control and
                // Core drain. No foreground window or desktop input is selected.
                BeginInvoke(new Action(request.Run));
            }
            catch (Exception error) { request.Completion.TrySetException(error); }
            return request.Completion.Task;
        }

        private bool AppControlDocumentReady()
        {
            return !closing && !browserProcessExited && !appControlNavigating
                && appControlDocument != null && webView.CoreWebView2 != null;
        }

        private Dictionary<string, object> AppControlStatus()
        {
            return new Dictionary<string, object>
            {
                { "app", new Dictionary<string, object> { { "id", options.ApplicationId }, { "name", options.Title } } },
                { "platform", "windows" }, { "host", "webview2" },
                { "url", webView.Source == null ? null : webView.Source.AbsoluteUri },
                { "documentGeneration", appControlGeneration }, { "ready", AppControlDocumentReady() },
                { "window", AppControlWindow() },
                { "operations", new string[] { "status", "inspect", "capture", "act", "key", "resize" } }
            };
        }

        private Dictionary<string, object> AppControlWindow()
        {
            return new Dictionary<string, object>
            {
                { "title", Text }, { "state", WindowStateName() },
                { "width", ClientSize.Width }, { "height", ClientSize.Height }
            };
        }

        private async Task<object> ExecuteAppControlAsync(string method, Dictionary<string, object> parameters,
            CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            if (method == "app.control.status") return AppControlStatus();
            if (method != "app.control.inspect" && method != "app.control.capture" && method != "app.control.act"
                && method != "app.control.key" && method != "app.control.resize")
                throw new ArgumentException("Unknown app-control method: " + method);
            if (method == "app.control.resize") RequireAppControlNormalWindow();
            if (!AppControlDocumentReady()) throw new InvalidOperationException("The app document is not ready for control.");
            long selectedGeneration = appControlGeneration;
            string selectedDocument = appControlDocument;
            string selectedUrl = webView.Source == null ? null : webView.Source.AbsoluteUri;
            object expected;
            if ((method == "app.control.act" || method == "app.control.key") && !parameters.ContainsKey("documentGeneration"))
                throw new ArgumentException("An action requires the documentGeneration returned by status or inspect.");
            if (parameters.TryGetValue("documentGeneration", out expected)
                && (!(expected is int || expected is long || expected is decimal || expected is double)
                    || Convert.ToDouble(expected) != selectedGeneration))
                throw new InvalidOperationException("The selected app document has been replaced.");

            object result;
            if (method == "app.control.capture")
            {
                using (MemoryStream image = new MemoryStream())
                {
                    await webView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                    result = new Dictionary<string, object>
                    {
                        { "mimeType", "image/png" }, { "data", Convert.ToBase64String(image.ToArray()) }
                    };
                }
            }
            else if (method == "app.control.key")
                result = await AppControlKeyAsync(parameters, cancellation, selectedGeneration, selectedDocument);
            else if (method == "app.control.resize")
                result = await AppControlResizeAsync(parameters, selectedGeneration, selectedDocument);
            else
            {
                string operation = method == "app.control.inspect" ? "inspect" : "act";
                result = await ReadAppControlDocumentAsync(operation, parameters, selectedDocument);
            }
            // Completion is observed after dispatch even if a caller cancelled.
            // A document change is reported with the actual returned result; it
            // neither retries an action nor claims its effects were reversed.
            if (!AppControlDocumentReady() || appControlGeneration != selectedGeneration || appControlDocument != selectedDocument)
            {
                IOException error = new IOException("The app document changed while the operation was completing.");
                error.Data["result"] = result;
                error.Data["documentGeneration"] = selectedGeneration;
                error.Data["url"] = selectedUrl;
                throw error;
            }
            Dictionary<string, object> record = result as Dictionary<string, object>;
            if (record == null) throw new InvalidDataException("The app-control result must be an object.");
            record["documentGeneration"] = selectedGeneration;
            record["url"] = webView.Source == null ? null : webView.Source.AbsoluteUri;
            return record;
        }

        private async Task<Dictionary<string, object>> ReadAppControlDocumentAsync(string operation,
            Dictionary<string, object> parameters, string selectedDocument)
        {
            // The creation marker is checked inside the executing document.
            // Native generation checks alone cannot stop a queued script
            // from reaching a successor document during navigation.
            string script = "(function(expected,operation,parameters){"
                + "if(globalThis[" + AppControlDocumentKey + "]!==expected)"
                + "return {ok:false,error:{code:'APP_CONTROL_DOCUMENT_REPLACED',message:'The selected app document has been replaced.'}};"
                + "return (" + options.AppControlSource + ")(operation,parameters);})("
                + ArcaneHost.Serializer().Serialize(selectedDocument) + ","
                + ArcaneHost.Serializer().Serialize(operation) + ","
                + ArcaneHost.Serializer().Serialize(parameters) + ")";
            string json = await webView.CoreWebView2.ExecuteScriptAsync(script);
            Dictionary<string, object> envelope = ArcaneHost.Serializer().DeserializeObject(json) as Dictionary<string, object>;
            object ok;
            if (envelope == null || !envelope.TryGetValue("ok", out ok) || !(ok is bool))
                throw new InvalidDataException("The document returned no app-control result.");
            if (!(bool)ok)
            {
                object detail;
                envelope.TryGetValue("error", out detail);
                IOException error = new IOException("The document app-control operation failed.");
                error.Data["documentError"] = detail;
                throw error;
            }
            object result;
            if (!envelope.TryGetValue("result", out result))
                throw new InvalidDataException("The document omitted the app-control result.");
            Dictionary<string, object> record = result as Dictionary<string, object>;
            if (record == null) throw new InvalidDataException("The app-control result must be an object.");
            return record;
        }

        private async Task<object> AppControlKeyAsync(Dictionary<string, object> parameters,
            CancellationToken cancellation, long selectedGeneration, string selectedDocument)
        {
            object value;
            string key = parameters.TryGetValue("key", out value) ? value as string : null;
            if (key != "Tab" && key != "Enter" && key != "Space" && key != "Escape")
                throw new ArgumentException("key must be Tab, Enter, Space, or Escape.");
            bool shiftKey = false;
            if (parameters.TryGetValue("shiftKey", out value))
            {
                if (!(value is bool)) throw new ArgumentException("shiftKey must be a boolean.");
                shiftKey = (bool)value;
            }
            if (shiftKey && key != "Tab") throw new ArgumentException("shiftKey is supported only with Tab.");
            Dictionary<string, object> down = new Dictionary<string, object>
            {
                { "type", key == "Tab" || key == "Escape" ? "rawKeyDown" : "keyDown" },
                { "key", key == "Space" ? " " : key }, { "code", key },
                { "windowsVirtualKeyCode", key == "Tab" ? 9 : key == "Enter" ? 13 : key == "Escape" ? 27 : 32 },
                { "modifiers", shiftKey ? 8 : 0 }
            };
            Dictionary<string, object> up = new Dictionary<string, object>(down);
            up["type"] = "keyUp";
            if (key == "Enter" || key == "Space")
            {
                down["text"] = key == "Enter" ? "\r" : " ";
                down["unmodifiedText"] = down["text"];
            }
            Dictionary<string, object> press = new Dictionary<string, object>
                { { "parameters", down }, { "attempted", false }, { "completed", false } };
            Dictionary<string, object> release = new Dictionary<string, object>
                { { "parameters", up }, { "attempted", false }, { "completed", false } };
            Dictionary<string, object> result = new Dictionary<string, object>
            {
                { "key", key }, { "shiftKey", shiftKey }, { "press", press }, { "release", release },
                { "documentGeneration", selectedGeneration },
                { "url", webView.Source == null ? null : webView.Source.AbsoluteUri }
            };
            // Only keyboard pairs share this owner: an awaited down must not
            // allow another accepted key to interleave before its owned up.
            await appControlKeyOwner.WaitAsync(cancellation);
            try
            {
                cancellation.ThrowIfCancellationRequested();
                RequireAppControlDocument(selectedGeneration, selectedDocument);
                result["previous"] = await ReadAppControlDocumentAsync("view", new Dictionary<string, object>(), selectedDocument);
                cancellation.ThrowIfCancellationRequested();
                RequireAppControlDocument(selectedGeneration, selectedDocument);
                CoreWebView2 browser = webView.CoreWebView2;
                string downJson = ArcaneHost.Serializer().Serialize(down);
                string upJson = ArcaneHost.Serializer().Serialize(up);
                Exception pressError = null;
                Exception releaseError = null;
                press["attempted"] = true;
                try
                {
                    press["response"] = await browser.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", downJson);
                    press["completed"] = true;
                }
                catch (Exception error) { pressError = error; }
                // C# 5 cannot await in finally. This unconditional phase follows
                // the observed down task, including failure/cancellation/navigation.
                // Release can itself activate Space; it cannot undo the press.
                release["attempted"] = true;
                try
                {
                    release["response"] = await browser.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", upJson);
                    release["completed"] = true;
                }
                catch (Exception error) { releaseError = error; }
                try
                {
                    if (pressError != null) press["error"] = ArcaneHost.ErrorRecord(pressError, "ARCANE_APP_CONTROL_FAILED");
                    if (releaseError != null) release["error"] = ArcaneHost.ErrorRecord(releaseError, "ARCANE_APP_CONTROL_FAILED");
                    if (pressError != null && releaseError != null)
                        throw new AggregateException("The key press and release failed.", pressError, releaseError);
                    if (pressError != null) throw new IOException("The key press failed.", pressError);
                    if (releaseError != null) throw new IOException("The key release failed.", releaseError);
                    RequireAppControlDocument(selectedGeneration, selectedDocument);
                    result["actual"] = await ReadAppControlDocumentAsync("view", new Dictionary<string, object>(), selectedDocument);
                    return result;
                }
                catch (Exception error)
                {
                    throw AppControlOutcomeError("The app key operation did not complete normally.", error, result);
                }
            }
            finally { appControlKeyOwner.Release(); }
        }

        private void RequireAppControlDocument(long selectedGeneration, string selectedDocument)
        {
            if (!AppControlDocumentReady() || appControlGeneration != selectedGeneration || appControlDocument != selectedDocument)
                throw new InvalidOperationException("The selected app document has been replaced or is no longer ready.");
        }

        private void RequireAppControlNormalWindow()
        {
            if (WindowStateName() == "Normal") return;
            InvalidOperationException error = new InvalidOperationException("App-control resize requires a Normal window.");
            error.Data["reason"] = "unsupported-window-state";
            error.Data["supportedWindowState"] = "Normal";
            error.Data["window"] = AppControlWindow();
            throw error;
        }

        private static int AppControlDimension(Dictionary<string, object> parameters, string name)
        {
            object value;
            if (!parameters.TryGetValue(name, out value)
                || !(value is int || value is long || value is decimal || value is double))
                throw new ArgumentException(name + " must be a positive integral native client dimension.");
            double dimension = Convert.ToDouble(value);
            if (Double.IsNaN(dimension) || dimension < 1 || dimension > Int32.MaxValue || dimension != Math.Truncate(dimension)
                || (value is decimal && (decimal)value != Decimal.Truncate((decimal)value)))
                throw new ArgumentException(name + " must be a positive integral native client dimension.");
            return (int)dimension;
        }

        private async Task<object> AppControlResizeAsync(Dictionary<string, object> parameters,
            long selectedGeneration, string selectedDocument)
        {
            int width = AppControlDimension(parameters, "width");
            int height = AppControlDimension(parameters, "height");
            // This check and immediate previous snapshot run in the same UI turn
            // as the setter. Never normalize a maximized/minimized window.
            RequireAppControlNormalWindow();
            Dictionary<string, object> result = new Dictionary<string, object>
            {
                { "requested", new Dictionary<string, object> { { "width", width }, { "height", height } } },
                { "previous", AppControlWindow() }, { "resizeAttempted", false }, { "resizeCompleted", false },
                { "documentGeneration", selectedGeneration },
                { "url", webView.Source == null ? null : webView.Source.AbsoluteUri }
            };
            try
            {
                result["resizeAttempted"] = true;
                ClientSize = new Size(width, height);
                result["resizeCompleted"] = true;
                result["actual"] = AppControlWindow();
                Dictionary<string, object> view = await ReadAppControlDocumentAsync("view", new Dictionary<string, object>(), selectedDocument);
                result["viewport"] = view["viewport"];
                return result;
            }
            catch (Exception error)
            {
                if (!result.ContainsKey("actual")) result["actual"] = AppControlWindow();
                throw AppControlOutcomeError("The app resize operation did not complete normally.", error, result);
            }
        }

        private static IOException AppControlOutcomeError(string message, Exception cause, Dictionary<string, object> result)
        {
            IOException error = new IOException(message, cause);
            error.Data["result"] = result;
            return error;
        }

        private sealed class AppControlRequest
        {
            private readonly ArcaneHostForm window;
            private readonly string method;
            private readonly Dictionary<string, object> parameters;
            private readonly CancellationToken cancellation;
            internal readonly TaskCompletionSource<object> Completion = new TaskCompletionSource<object>();

            internal AppControlRequest(ArcaneHostForm window, string method,
                Dictionary<string, object> parameters, CancellationToken cancellation)
            {
                this.window = window;
                this.method = method;
                this.parameters = parameters;
                this.cancellation = cancellation;
            }

            internal async void Run()
            {
                try { Completion.TrySetResult(await window.ExecuteAppControlAsync(method, parameters, cancellation)); }
                catch (OperationCanceledException) { Completion.TrySetCanceled(); }
                catch (Exception error) { Completion.TrySetException(error); }
            }
        }
    }
}
