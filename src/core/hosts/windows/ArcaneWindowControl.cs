using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace Arcane.Core.Hosts.Windows
{
    // The form owns UI-thread dispatch and document lifetime. The pipe owner
    // handles only connections and framed requests, never another Core child.
    public sealed partial class ArcaneHostForm
    {
        private const string AppControlDocumentKey = "Symbol.for('arcane-os.app-control.document')";
        private readonly HashSet<Task> appControlDocumentTasks = new HashSet<Task>();
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
                { "window", new Dictionary<string, object>
                    { { "title", Text }, { "state", WindowState.ToString() },
                      { "width", ClientSize.Width }, { "height", ClientSize.Height } } },
                { "operations", new string[] { "status", "inspect", "capture", "act" } }
            };
        }

        private async Task<object> ExecuteAppControlAsync(string method, Dictionary<string, object> parameters,
            CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            if (method == "app.control.status") return AppControlStatus();
            if (method != "app.control.inspect" && method != "app.control.capture" && method != "app.control.act")
                throw new ArgumentException("Unknown app-control method: " + method);
            if (!AppControlDocumentReady()) throw new InvalidOperationException("The app document is not ready for control.");
            long selectedGeneration = appControlGeneration;
            string selectedDocument = appControlDocument;
            string selectedUrl = webView.Source == null ? null : webView.Source.AbsoluteUri;
            object expected;
            if (method == "app.control.act" && !parameters.ContainsKey("documentGeneration"))
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
            else
            {
                string operation = method == "app.control.inspect" ? "inspect" : "act";
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
                if (!envelope.TryGetValue("result", out result))
                    throw new InvalidDataException("The document omitted the app-control result.");
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
