using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>Controls one existing app window through its explicit pipe endpoint.</summary>
    internal sealed class ArcaneAppControl
    {
        private readonly string endpoint;
        private readonly Func<string, Dictionary<string, object>, CancellationToken, Task<object>> dispatch;
        private readonly Action<string> onDiagnostic;
        private readonly Action<Exception> onError;
        private readonly object stateLock = new object();
        private readonly HashSet<Connection> connections = new HashSet<Connection>();
        private readonly List<Exception> failures = new List<Exception>();
        private readonly CancellationTokenSource accepting = new CancellationTokenSource();
        private readonly TaskCompletionSource<object> completion = new TaskCompletionSource<object>();
        private NamedPipeServerStream listener;
        private Task lifetime;
        private bool closing;

        internal ArcaneAppControl(string endpoint,
            Func<string, Dictionary<string, object>, CancellationToken, Task<object>> dispatch,
            Action<string> onDiagnostic, Action<Exception> onError)
        {
            if (String.IsNullOrEmpty(endpoint)) throw new ArgumentException("Select the full app-control pipe endpoint.", "endpoint");
            if (dispatch == null) throw new ArgumentNullException("dispatch");
            if (onDiagnostic == null) throw new ArgumentNullException("onDiagnostic");
            if (onError == null) throw new ArgumentNullException("onError");
            this.endpoint = endpoint;
            this.dispatch = dispatch;
            this.onDiagnostic = onDiagnostic;
            this.onError = onError;
            // Claim before returning. An occupied endpoint never joins another
            // app instance's pipe group or connects to that app as a client.
            listener = CreateListener(true);
            completion.Task.ContinueWith(ObserveReportedFailure, TaskContinuationOptions.OnlyOnFaulted);
            lifetime = ListenAsync();
            lifetime.ContinueWith(ListenerFailed, TaskContinuationOptions.OnlyOnFaulted);
        }

        internal Task Completion { get { return completion.Task; } }

        internal Task CloseAsync()
        {
            StopIngress();
            return Completion;
        }

        private NamedPipeServerStream CreateListener(bool first)
        {
            const uint duplex = 0x00000003;
            const uint overlapped = 0x40000000;
            const uint firstInstance = 0x00080000;
            // Zero selects the platform's stream/wait modes and buffer defaults.
            SafePipeHandle handle = CreateNamedPipe(endpoint,
                duplex | overlapped | (first ? firstInstance : 0), 0, 255, 0, 0, 0, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                IOException error = new IOException("The app-control pipe endpoint could not be opened.", new Win32Exception(code));
                error.Data["endpoint"] = endpoint;
                throw error;
            }
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
            catch { handle.Dispose(); throw; }
        }

        [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode,
            uint maximumInstances, uint outputBuffer, uint inputBuffer, uint defaultTimeout, IntPtr attributes);

        private async Task ListenAsync()
        {
            try
            {
                while (true)
                {
                    NamedPipeServerStream current;
                    lock (stateLock)
                    {
                        if (closing) break;
                        current = listener;
                    }
                    await current.WaitForConnectionAsync(accepting.Token).ConfigureAwait(false);
                    Connection connection;
                    lock (stateLock)
                    {
                        if (closing) break;
                        // Retain an instance continuously, including between
                        // accepts, so another host cannot claim this endpoint.
                        listener = CreateListener(false);
                        connection = new Connection(this, current);
                        connections.Add(connection);
                    }
                    connection.Start();
                }
            }
            catch (OperationCanceledException error)
            {
                if (!accepting.IsCancellationRequested) Report(error);
            }
            catch (Exception error) { Report(error); }
            StopIngress();
            Connection[] active;
            lock (stateLock) active = SnapshotConnections();
            List<Task> drains = new List<Task>();
            foreach (Connection connection in active) drains.Add(connection.Completion);
            Task draining = Task.WhenAll(drains);
            try { await draining.ConfigureAwait(false); }
            catch (Exception error) { ReportTaskFailure(draining, error); }
            // The final pipe handle owns the endpoint until accepted work
            // settles, even though cancellation has stopped further accepts.
            try { listener.Dispose(); }
            catch (Exception error) { Report(error); }
            accepting.Dispose();
            Exception[] errors;
            lock (stateLock) errors = failures.ToArray();
            if (errors.Length == 0) completion.TrySetResult(null);
            else completion.TrySetException(new AggregateException("App-control transport closed with errors.", errors));
        }

        private Connection[] SnapshotConnections()
        {
            Connection[] active = new Connection[connections.Count];
            connections.CopyTo(active);
            return active;
        }

        private void StopIngress()
        {
            Connection[] active;
            lock (stateLock)
            {
                if (closing) return;
                closing = true;
                // The listener stays open as the endpoint claim. Cancellation
                // stops its overlapped accept without releasing that ownership.
                try { accepting.Cancel(); }
                catch (Exception error) { Report(error); }
                active = SnapshotConnections();
            }
            foreach (Connection connection in active) connection.Stop();
        }

        private void Remove(Connection connection)
        {
            lock (stateLock) connections.Remove(connection);
        }

        private void Report(Exception error)
        {
            lock (stateLock)
            {
                if (failures.Contains(error)) return;
                failures.Add(error);
            }
            try { onError(error); }
            catch (Exception callbackError) { lock (stateLock) failures.Add(callbackError); }
        }

        private void Diagnose(object record)
        {
            string diagnostic = null;
            try
            {
                diagnostic = ArcaneHost.Serializer().Serialize(record) + Environment.NewLine;
                onDiagnostic(diagnostic);
            }
            catch (Exception error)
            {
                IOException failure = new IOException("The app-control diagnostic could not be delivered.", error);
                failure.Data["diagnosticRecord"] = record;
                if (diagnostic != null) failure.Data["diagnostic"] = diagnostic;
                Report(failure);
            }
        }

        private void ReportTaskFailure(Task task, Exception caught)
        {
            if (task.Exception == null) { Report(caught); return; }
            foreach (Exception error in task.Exception.InnerExceptions) Report(error);
        }

        private void ListenerFailed(Task task)
        {
            ReportTaskFailure(task, task.Exception);
            completion.TrySetException(task.Exception);
        }

        private static void ObserveReportedFailure(Task task) { task.Exception.Handle(IgnoreReportedFailure); }
        private static bool IgnoreReportedFailure(Exception error) { return true; }

        private sealed class Connection
        {
            private readonly ArcaneAppControl owner;
            private readonly NamedPipeServerStream pipe;
            private readonly object stateLock = new object();
            private readonly Dictionary<string, Request> requests = new Dictionary<string, Request>();
            private readonly SemaphoreSlim writing = new SemaphoreSlim(1, 1);
            private readonly TaskCompletionSource<object> completion = new TaskCompletionSource<object>();
            private Task lifetime;
            private bool closed;

            internal Connection(ArcaneAppControl owner, NamedPipeServerStream pipe)
            {
                this.owner = owner;
                this.pipe = pipe;
            }

            internal Task Completion { get { return completion.Task; } }

            internal void Start()
            {
                lifetime = ReadAsync();
                lifetime.ContinueWith(Failed, TaskContinuationOptions.OnlyOnFaulted);
            }

            private async Task ReadAsync()
            {
                try
                {
                    while (true)
                    {
                        lock (stateLock) { if (closed) break; }
                        string json = await ArcaneFrameTransport.ReadAsync(pipe).ConfigureAwait(false);
                        if (json == null) break;
                        Receive(json);
                    }
                }
                catch (ObjectDisposedException error) { ReadStopped(error); }
                catch (OperationCanceledException error) { ReadStopped(error); }
                catch (IOException error)
                {
                    if (IsClosed()) ReadStopped(error);
                    else owner.Report(error);
                }
                catch (Exception error) { owner.Report(error); }
                Stop();
                List<Task> drains = new List<Task>();
                lock (stateLock)
                {
                    foreach (Request request in requests.Values) drains.Add(request.Completion);
                }
                Task draining = Task.WhenAll(drains);
                try { await draining.ConfigureAwait(false); }
                catch (Exception error) { owner.ReportTaskFailure(draining, error); }
                writing.Dispose();
                owner.Remove(this);
                completion.TrySetResult(null);
            }

            private bool IsClosed() { lock (stateLock) return closed; }

            private void ReadStopped(Exception error)
            {
                if (IsClosed()) owner.Diagnose(ArcaneHost.ErrorRecord(error, "ARCANE_APP_CONTROL_INPUT_CLOSED"));
                else owner.Report(error);
            }

            private void Receive(string json)
            {
                try
                {
                    Dictionary<string, object> frame = ArcaneHost.Serializer().DeserializeObject(json) as Dictionary<string, object>;
                    if (frame == null || Text(frame, "protocol") != "arcane/1")
                        throw new FormatException("Unknown app-control protocol.");
                    if (Text(frame, "type") == "control")
                    {
                        string control = Text(frame, "control");
                        if (control == "requests.cancelAll") { CancelRequests(); return; }
                        if (control == "request.cancel")
                        {
                            string id = Text(frame, "requestId");
                            if (String.IsNullOrEmpty(id)) throw new FormatException("Request cancellation requires a requestId.");
                            Request request;
                            lock (stateLock) requests.TryGetValue(id, out request);
                            if (request != null) request.Cancel();
                            return;
                        }
                        throw new FormatException("Unknown app-control cancellation control.");
                    }
                    string requestId = Text(frame, "id");
                    string method = Text(frame, "method");
                    if (Text(frame, "type") != "request" || String.IsNullOrEmpty(requestId) || method == null)
                        throw new FormatException("An app-control request requires an id and method.");
                    object parameters;
                    frame.TryGetValue("parameters", out parameters);
                    Request accepted;
                    lock (stateLock)
                    {
                        if (closed)
                        {
                            owner.Diagnose(new Dictionary<string, object>
                            {
                                { "appControlFrame", json }, { "reason", "connection-closed-before-dispatch" }
                            });
                            return;
                        }
                        if (requests.ContainsKey(requestId))
                            throw new FormatException("The app-control request id is already active on this connection.");
                        accepted = new Request(this, requestId, method, parameters, json);
                        requests.Add(requestId, accepted);
                    }
                    accepted.Start();
                }
                catch (Exception error)
                {
                    error.Data["appControlFrame"] = json;
                    throw;
                }
            }

            private static string Text(Dictionary<string, object> frame, string key)
            {
                object value;
                return frame.TryGetValue(key, out value) ? value as string : null;
            }

            private void CancelRequests()
            {
                Request[] active;
                lock (stateLock)
                {
                    active = new Request[requests.Count];
                    requests.Values.CopyTo(active, 0);
                }
                foreach (Request request in active) request.Cancel();
            }

            internal void Stop()
            {
                lock (stateLock)
                {
                    if (closed) return;
                    closed = true;
                }
                CancelRequests();
                try { pipe.Dispose(); }
                catch (Exception error) { owner.Report(error); }
            }

            private async Task<bool> SendAsync(Dictionary<string, object> response)
            {
                string json = ArcaneHost.Serializer().Serialize(response);
                await writing.WaitAsync().ConfigureAwait(false);
                try
                {
                    if (IsClosed()) { RetireResponse(json, null); return true; }
                    await ArcaneFrameTransport.WriteAsync(pipe, json).ConfigureAwait(false);
                    return false;
                }
                catch (Exception error)
                {
                    if (PeerDisconnected(error)
                        || (IsClosed() && (error is IOException || error is ObjectDisposedException || error is OperationCanceledException)))
                    {
                        Stop();
                        RetireResponse(json, error);
                        return true;
                    }
                    error.Data["appControlResponse"] = json;
                    throw;
                }
                finally { writing.Release(); }
            }

            private static bool PeerDisconnected(Exception error)
            {
                if (!(error is IOException)) return false;
                // These platform results mean the peer ended the pipe, even
                // when the write observes that before the reader sees EOF.
                int code = error.HResult & 0xffff;
                return code == 109 || code == 232 || code == 233;
            }

            private void RetireResponse(string json, Exception error)
            {
                Dictionary<string, object> record = new Dictionary<string, object>
                {
                    { "appControlResponse", json }, { "reason", "connection-closed" }
                };
                if (error != null) record["error"] = ArcaneHost.ErrorRecord(error, "ARCANE_APP_CONTROL_OUTPUT_CLOSED");
                owner.Diagnose(record);
            }

            private void Failed(Task task)
            {
                owner.ReportTaskFailure(task, task.Exception);
                Stop();
                owner.Remove(this);
                completion.TrySetException(task.Exception);
            }

            private sealed class Request
            {
                private readonly Connection connection;
                private readonly string id;
                private readonly string method;
                private readonly object parameters;
                private readonly string frame;
                private readonly object stateLock = new object();
                private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
                private readonly TaskCompletionSource<object> completion = new TaskCompletionSource<object>();
                private Task lifetime;
                private bool settled;

                internal Request(Connection connection, string id, string method, object parameters, string frame)
                {
                    this.connection = connection;
                    this.id = id;
                    this.method = method;
                    this.parameters = parameters;
                    this.frame = frame;
                }

                internal Task Completion { get { return completion.Task; } }

                internal void Start()
                {
                    lifetime = AnswerAsync();
                    lifetime.ContinueWith(Failed, TaskContinuationOptions.OnlyOnFaulted);
                }

                internal void Cancel()
                {
                    lock (stateLock)
                    {
                        if (settled || cancellation.IsCancellationRequested) return;
                        try { cancellation.Cancel(); }
                        catch (Exception error) { connection.owner.Report(error); }
                    }
                }

                private async Task AnswerAsync()
                {
                    Dictionary<string, object> response = new Dictionary<string, object>
                    {
                        { "protocol", "arcane/1" }, { "type", "response" }, { "id", id }
                    };
                    bool responseRecorded = false;
                    try
                    {
                        try
                        {
                            cancellation.Token.ThrowIfCancellationRequested();
                            if (method != "app.control.status" && method != "app.control.diagnostics" && method != "app.control.inspect"
                                && method != "app.control.capture" && method != "app.control.act"
                                && method != "app.control.key" && method != "app.control.resize")
                                throw new NotSupportedException("The app does not expose " + method + ".");
                            Dictionary<string, object> arguments = parameters as Dictionary<string, object>;
                            if (arguments == null)
                                throw new ArgumentException("App-control parameters must be an object.", "parameters");
                            // Dispatch owns the actual UI operation. Cancellation
                            // after it starts never fabricates a reversed action.
                            object result = await connection.owner.dispatch(method, arguments, cancellation.Token).ConfigureAwait(false);
                            response["ok"] = true;
                            response["result"] = result;
                        }
                        catch (Exception error)
                        {
                            error.Data["appControlFrame"] = frame;
                            response["ok"] = false;
                            string code = error is OperationCanceledException ? "REQUEST_ABORTED"
                                : error is NotSupportedException ? "METHOD_NOT_ALLOWED"
                                : error is ArgumentException ? "INVALID_ARGUMENT" : "ARCANE_APP_CONTROL_FAILED";
                            response["error"] = ArcaneHost.ErrorRecord(error, code);
                        }
                        response["time"] = DateTime.UtcNow.ToString("o");
                        responseRecorded = await connection.SendAsync(response).ConfigureAwait(false);
                    }
                    catch (Exception error)
                    {
                        if (!error.Data.Contains("appControlResponse")) error.Data["appControlResponse"] = response;
                        connection.owner.Report(error);
                        connection.Stop();
                    }
                    finally { Complete(response, responseRecorded); }
                }

                private void Complete(Dictionary<string, object> response, bool responseRecorded)
                {
                    bool cancelled;
                    lock (stateLock)
                    {
                        if (settled) return;
                        cancelled = cancellation.IsCancellationRequested;
                        settled = true;
                    }
                    try
                    {
                        try { cancellation.Dispose(); }
                        catch (Exception error) { connection.owner.Report(error); }
                        // A live peer retires its cancelled request before this
                        // actual operation finishes, even while the pipe stays open.
                        if (cancelled && response != null && !responseRecorded)
                            connection.owner.Diagnose(new Dictionary<string, object>
                            {
                                { "appControlResponse", response }, { "reason", "request-cancelled" }
                            });
                    }
                    catch (Exception error) { connection.owner.Report(error); }
                    finally
                    {
                        try { lock (connection.stateLock) connection.requests.Remove(id); }
                        finally { completion.TrySetResult(null); }
                    }
                }

                private void Failed(Task task)
                {
                    connection.owner.ReportTaskFailure(task, task.Exception);
                    Complete(null, false);
                }
            }
        }
    }
}
