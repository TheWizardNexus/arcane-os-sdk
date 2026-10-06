using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>
    /// Owns one caller-selected Core child and its complete framed transport.
    /// Output callbacks run on background threads; errors can also be reported
    /// during Start. Callbacks must not synchronously wait for CloseAsync or
    /// Completion. CloseAsync drains; it never kills the child.
    /// </summary>
    public sealed class ArcaneCoreProcess
    {
        private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
        private readonly object stateLock = new object();
        private readonly Process process;
        private readonly Action<string> onMessage;
        private readonly Action<string> onDiagnostic;
        private readonly Action<Exception> onError;
        private readonly List<Exception> failures = new List<Exception>();
        private readonly TaskCompletionSource<int> exited = new TaskCompletionSource<int>();
        private readonly TaskCompletionSource<object> completion = new TaskCompletionSource<object>();
        private Task writes = Task.FromResult<object>(null);
        private Task inputClosing;
        private Task outputReader;
        private Task diagnosticReader;
        private Task lifetime;
        private bool accepting = true;
        private bool closeRequested;
        private int exitObserved;
        private int inputClosed;

        private ArcaneCoreProcess(ProcessStartInfo startInfo, Action<string> onMessage,
            Action<string> onDiagnostic, Action<Exception> onError)
        {
            this.onMessage = onMessage;
            this.onDiagnostic = onDiagnostic;
            this.onError = onError;
            // Observing the fault internally does not change the faulted task
            // returned to callers; all errors are also retained and reported.
            completion.Task.ContinueWith(
                failed => failed.Exception.Handle(error => true), CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.Exited += OnExited;
        }

        /// <summary>
        /// Starts the selected executable without shell execution or a visible
        /// console. Arguments use the selected executable's command-line syntax.
        /// Diagnostic text is decoded as UTF-8 without changing line endings.
        /// </summary>
        public static ArcaneCoreProcess Start(string executable, string arguments,
            string workingDirectory, Action<string> onMessage,
            Action<string> onDiagnostic, Action<Exception> onError = null)
        {
            if (String.IsNullOrWhiteSpace(executable)) throw new ArgumentException("Select a Core executable.", "executable");
            if (String.IsNullOrWhiteSpace(workingDirectory)) throw new ArgumentException("Select a Core working directory.", "workingDirectory");
            if (onMessage == null) throw new ArgumentNullException("onMessage");
            if (onDiagnostic == null) throw new ArgumentNullException("onDiagnostic");
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = executable,
                Arguments = arguments ?? String.Empty,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            ArcaneCoreProcess host = new ArcaneCoreProcess(startInfo, onMessage, onDiagnostic, onError);
            try
            {
                if (!host.process.Start()) throw new IOException("The selected Core process did not start.");
            }
            catch (Exception error)
            {
                host.Report(error);
                host.process.Exited -= host.OnExited;
                try { host.process.Dispose(); }
                catch (Exception disposalError) { host.Report(disposalError); }
                AggregateException failure = new AggregateException("Core process startup failed.", host.SnapshotFailures());
                host.completion.TrySetException(failure);
                throw failure;
            }
            // All callbacks and exit observation exist before either reader starts.
            host.outputReader = Task.Run(new Func<Task>(host.ReadOutputAsync));
            host.diagnosticReader = Task.Run(new Func<Task>(host.ReadDiagnosticsAsync));
            host.lifetime = host.CompleteAsync();
            host.lifetime.ContinueWith(host.ObserveLifetimeFailure, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            return host;
        }

        /// <summary>
        /// Settles only after child exit, accepted writes, both output readers
        /// and resource disposal. Every transport/callback failure is retained.
        /// </summary>
        public Task Completion { get { return completion.Task; } }

        /// <summary>Writes this exact JSON string after earlier accepted sends.</summary>
        public Task SendAsync(string json)
        {
            if (json == null) throw new ArgumentNullException("json");
            lock (stateLock)
            {
                if (!accepting)
                {
                    TaskCompletionSource<object> rejected = new TaskCompletionSource<object>();
                    rejected.SetException(new InvalidOperationException("The Core transport is closing."));
                    return rejected.Task;
                }
                writes = writes.ContinueWith(
                    previous => WriteAfterAsync(previous, json), CancellationToken.None,
                    TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
                return writes;
            }
        }

        public Task CloseAsync()
        {
            lock (stateLock) closeRequested = true;
            BeginInputClose();
            return Completion;
        }

        private async Task WriteAfterAsync(Task previous, string json)
        {
            // A failed earlier write also faults later accepted sends; it cannot
            // leave a caller waiting on a request that was never transmitted.
            await previous.ConfigureAwait(false);
            try
            {
                if (Volatile.Read(ref exitObserved) != 0) throw new IOException("Core exited before the accepted write completed.");
                Stream input = process.StandardInput.BaseStream;
                await ArcaneFrameTransport.WriteAsync(input, json).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                Report(error);
                BeginInputClose();
                throw;
            }
        }

        private Task BeginInputClose()
        {
            lock (stateLock)
            {
                if (inputClosing != null) return inputClosing;
                accepting = false;
                inputClosing = writes.ContinueWith<Task>(
                    CloseInputAfterWritesAsync, CancellationToken.None,
                    TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
                return inputClosing;
            }
        }

        private async Task CloseInputAfterWritesAsync(Task acceptedWrites)
        {
            try { await acceptedWrites.ConfigureAwait(false); }
            catch { /* The originating write already reported the complete error. */ }
            CloseInputStream();
        }

        private void CloseInputStream()
        {
            if (Interlocked.Exchange(ref inputClosed, 1) != 0) return;
            try { process.StandardInput.BaseStream.Close(); }
            catch (Exception error) { Report(error); }
        }

        private void OnExited(object sender, EventArgs args)
        {
            if (Interlocked.Exchange(ref exitObserved, 1) != 0) return;
            bool requested;
            lock (stateLock) requested = closeRequested;
            int exitCode = 0;
            try
            {
                exitCode = process.ExitCode;
                if (!requested || exitCode != 0)
                    Report(new IOException("Core process exited " + (requested ? "during shutdown" : "unexpectedly")
                        + " with exit code " + exitCode.ToString(CultureInfo.InvariantCulture) + "."));
            }
            catch (Exception error) { Report(error); }
            BeginInputClose();
            // A dead child cannot accept the remaining writes. Closing its pipe
            // unblocks an in-flight write; queued sends observe that same failure.
            CloseInputStream();
            exited.TrySetResult(exitCode);
        }

        private async Task ReadOutputAsync()
        {
            Stream output = null;
            try
            {
                output = process.StandardOutput.BaseStream;
                while (true)
                {
                    string message = await ArcaneFrameTransport.ReadAsync(output).ConfigureAwait(false);
                    if (message == null) break;
                    try { onMessage(message); }
                    catch (Exception error)
                    {
                        IOException callbackError = new IOException("The Core message callback failed.", error);
                        callbackError.Data["coreMessage"] = message;
                        Report(callbackError);
                    }
                }
                BeginInputClose();
                return;
            }
            catch (Exception error)
            {
                Report(error);
                BeginInputClose();
            }
            if (output != null) await DrainUnparsedAsync(output, "stdout").ConfigureAwait(false);
        }

        private async Task ReadDiagnosticsAsync()
        {
            Stream diagnostic = null;
            byte[] input = new byte[4096];
            byte[] pending = new byte[0];
            try
            {
                diagnostic = process.StandardError.BaseStream;
                while (true)
                {
                    int read = await diagnostic.ReadAsync(input, 0, input.Length).ConfigureAwait(false);
                    byte[] combined = new byte[pending.Length + read];
                    Buffer.BlockCopy(pending, 0, combined, 0, pending.Length);
                    Buffer.BlockCopy(input, 0, combined, pending.Length, read);
                    pending = combined;
                    int complete = read == 0 ? combined.Length : CompleteUtf8Prefix(combined);
                    string text = Utf8.GetString(combined, 0, complete);
                    if (text.Length != 0)
                    {
                        try { onDiagnostic(text); }
                        catch (Exception error)
                        {
                            IOException callbackError = new IOException("The Core diagnostic callback failed.", error);
                            callbackError.Data["coreDiagnostic"] = text;
                            Report(callbackError);
                        }
                    }
                    pending = new byte[combined.Length - complete];
                    Buffer.BlockCopy(combined, complete, pending, 0, pending.Length);
                    if (read == 0) break;
                }
                return;
            }
            catch (Exception error)
            {
                error.Data["stderr"] = pending;
                Report(error);
                BeginInputClose();
            }
            if (diagnostic != null) await DrainUnparsedAsync(diagnostic, "stderr").ConfigureAwait(false);
        }

        private static int CompleteUtf8Prefix(byte[] input)
        {
            if (input.Length == 0) return 0;
            int start = input.Length - 1;
            while (start > 0 && (input[start] & 0xc0) == 0x80) start--;
            int first = input[start];
            int required = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2
                : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
            return input.Length - start < required ? start : input.Length;
        }

        private async Task DrainUnparsedAsync(Stream stream, string channel)
        {
            byte[] buffer = new byte[4096];
            try
            {
                int read;
                while ((read = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
                {
                    byte[] content = new byte[read];
                    Buffer.BlockCopy(buffer, 0, content, 0, read);
                    IOException diagnostic = new IOException("Unparsed Core " + channel + " is retained in this error's Data.");
                    diagnostic.Data[channel] = content;
                    Report(diagnostic);
                }
            }
            catch (Exception error) { Report(error); }
        }

        private async Task CompleteAsync()
        {
            try
            {
                await exited.Task.ConfigureAwait(false);
                Task readers = Task.WhenAll(outputReader, diagnosticReader);
                try { await readers.ConfigureAwait(false); }
                catch
                {
                    foreach (Exception error in readers.Exception.InnerExceptions) Report(error);
                }
            }
            catch (Exception error) { Report(error); }
            try { await BeginInputClose().ConfigureAwait(false); }
            catch (Exception error) { Report(error); }
            finally
            {
                process.Exited -= OnExited;
                try { process.StandardOutput.Close(); }
                catch (Exception error) { Report(error); }
                try { process.StandardError.Close(); }
                catch (Exception error) { Report(error); }
                try { process.Dispose(); }
                catch (Exception error) { Report(error); }
                Exception[] errors = SnapshotFailures();
                if (errors.Length != 0)
                    completion.TrySetException(new AggregateException("Core process completed with errors.", errors));
                else completion.TrySetResult(null);
            }
        }

        private void ObserveLifetimeFailure(Task failed)
        {
            foreach (Exception error in failed.Exception.InnerExceptions) Report(error);
            completion.TrySetException(new AggregateException("Core lifetime observation failed.", SnapshotFailures()));
        }

        private void Report(Exception error)
        {
            lock (stateLock) failures.Add(error);
            if (onError == null) return;
            try { onError(error); }
            catch (Exception callbackError)
            {
                lock (stateLock) failures.Add(callbackError);
            }
        }

        private Exception[] SnapshotFailures()
        {
            lock (stateLock) return failures.ToArray();
        }
    }
}
