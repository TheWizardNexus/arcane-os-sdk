using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.Versioning;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: TargetFramework(".NETFramework,Version=v4.6.2", FrameworkDisplayName = ".NET Framework 4.6.2")]

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>The reusable executable entry; application policy stays in its manifest and services.</summary>
    internal static class ArcaneLauncher
    {
        private static TextWriter diagnostics;
        private static string diagnosticFilename;
        private static Exception runnerInputFailure;

        [STAThread]
        private static int Main(string[] args)
        {
            bool closeOnInputEnd = false;
            try
            {
                string launchFilename = null;
                for (int index = 0; index < args.Length; index++)
                {
                    if (args[index] == "--arcane-launch-config")
                    {
                        if (++index == args.Length || String.IsNullOrEmpty(args[index]))
                            throw new ArgumentException("--arcane-launch-config requires a filename.");
                        launchFilename = args[index];
                    }
                    else if (args[index] == "--close-on-stdin-eof") closeOnInputEnd = true;
                    else throw new ArgumentException("Unknown launcher argument: " + args[index]);
                }

                // A GUI executable has no console encoding handle. The SDK
                // runner can still redirect stderr; write UTF-8 to that stream
                // directly without changing a nonexistent console code page.
                StreamWriter standardError = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
                standardError.AutoFlush = true;
                Console.SetError(TextWriter.Synchronized(standardError));

                string directory = AppDomain.CurrentDomain.BaseDirectory;
                Dictionary<string, object> manifest = ReadRecord(Path.Combine(directory, "arcane-native.json"));
                Dictionary<string, object> app = RequiredRecord(manifest, "app");
                Dictionary<string, object> client = RequiredRecord(manifest, "client");
                string appId = RequiredString(app, "id");
                object title;
                string name = app.TryGetValue("displayName", out title) && title is string ? (string)title : appId;

                // Core rereads this exact selected file. Do not normalize,
                // rewrite, filter or copy the application's launch record.
                Dictionary<string, object> launchContext = launchFilename == null ? null : ReadRecord(launchFilename);
                object stateRoot;
                string profileParent = launchContext != null && launchContext.TryGetValue("stateRoot", out stateRoot) && stateRoot is string
                    ? Path.GetFullPath((string)stateRoot)
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Arcane", appId);
                OpenDiagnostics(Path.Combine(profileParent, "Diagnostics"));
                ArcaneHostOptions options = new ArcaneHostOptions
                {
                    ApplicationRoot = Path.GetFullPath(Path.Combine(directory, RequiredString(manifest, "webRoot"))),
                    StartPath = RequiredString(manifest, "start"),
                    OriginHost = "arcane.local",
                    ProfileDirectory = Path.Combine(profileParent, "WebView2"),
                    Title = name,
                    ClassicClientSource = File.ReadAllText(Path.Combine(directory, RequiredString(client, "source"))),
                    CoreExecutable = Path.Combine(directory, "runtime", "ArcaneCore.exe"),
                    // Forward the actual host selection separately; Core keeps
                    // every explicit launch-record field unchanged.
                    CoreArguments = "--arcane-host-state-root " + QuoteArgument(profileParent)
                        + (launchFilename == null ? String.Empty : " --arcane-launch-config " + QuoteArgument(launchFilename)),
                    // Relative explicit launch filenames retain their caller's
                    // meaning; the SEA locates its loader beside its executable.
                    CoreWorkingDirectory = Environment.CurrentDirectory
                };

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (ArcaneHostForm window = new ArcaneHostForm(options, WriteDiagnostic, WriteError))
                {
                    Task inputLifetime = null;
                    if (closeOnInputEnd)
                    {
                        // Only the SDK runner opts into stdin lifetime. Starting
                        // after Shown gives CloseAsync its actual UI handle; the
                        // default double-click path never reads or waits on stdin.
                        window.Shown += delegate
                        {
                            if (inputLifetime != null) return;
                            inputLifetime = CloseOnInputEndAsync(window);
                            inputLifetime.ContinueWith(ObserveInputFailure, TaskContinuationOptions.OnlyOnFaulted);
                        };
                    }
                    Application.Run(window);
                    // The host keeps its message loop alive for the accepted
                    // Core work and transport drain before FormClosed.
                    window.Completion.GetAwaiter().GetResult();
                    if (runnerInputFailure != null) throw new IOException("The runner's input lifetime failed.", runnerInputFailure);
                    if (inputLifetime != null && inputLifetime.IsFaulted) throw inputLifetime.Exception;
                    GC.KeepAlive(inputLifetime);
                }
                GC.KeepAlive(launchContext);
                return 0;
            }
            catch (Exception error)
            {
                try
                {
                    // An unreadable manifest cannot supply an app identity.
                    // Retain that early failure in the launcher's diagnostic
                    // directory without inventing an application's namespace.
                    if (diagnostics == null)
                        OpenDiagnostics(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Arcane", "Diagnostics"));
                    WriteError(error);
                }
                catch (Exception diagnosticError)
                {
                    Console.Error.WriteLine(new AggregateException("The application and diagnostic output failed.", error, diagnosticError));
                    Trace.WriteLine(error);
                    Trace.WriteLine(diagnosticError);
                }
                if (!closeOnInputEnd)
                    MessageBox.Show("The application encountered an error."
                        + (diagnosticFilename == null ? " A diagnostic file could not be opened." : "\n\nDetails: " + diagnosticFilename),
                        "Arcane", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                if (diagnostics != null) diagnostics.Dispose();
            }
        }

        private static Dictionary<string, object> ReadRecord(string filename)
        {
            object value = ArcaneHost.Serializer().DeserializeObject(File.ReadAllText(filename));
            Dictionary<string, object> record = value as Dictionary<string, object>;
            if (record == null) throw new FormatException("Expected a JSON object in " + filename + ".");
            return record;
        }

        private static Dictionary<string, object> RequiredRecord(Dictionary<string, object> source, string name)
        {
            object value;
            Dictionary<string, object> record = source.TryGetValue(name, out value) ? value as Dictionary<string, object> : null;
            if (record == null) throw new FormatException("The native manifest needs an object at " + name + ".");
            return record;
        }

        private static string RequiredString(Dictionary<string, object> source, string name)
        {
            object value;
            string text = source.TryGetValue(name, out value) ? value as string : null;
            if (String.IsNullOrEmpty(text)) throw new FormatException("The native manifest needs a string at " + name + ".");
            return text;
        }

        private static string QuoteArgument(string value)
        {
            // Windows command-line escaping is transport-local. The child
            // receives the complete original filename, including backslashes.
            StringBuilder quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    quoted.Append('\\', slashes * 2 + 1);
                    quoted.Append('"');
                }
                else
                {
                    quoted.Append('\\', slashes);
                    quoted.Append(character);
                }
                slashes = 0;
            }
            quoted.Append('\\', slashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private static async Task CloseOnInputEndAsync(ArcaneHostForm window)
        {
            // Standard input is an optional process-lifetime signal, not an
            // application message channel. Its blocking read stays off the UI
            // thread. Closing the window never waits for an open parent's pipe.
            try
            {
                await Task.Run(delegate
                {
                    using (Stream input = Console.OpenStandardInput())
                    {
                        byte[] buffer = new byte[4096];
                        while (input.Read(buffer, 0, buffer.Length) != 0) { }
                    }
                }).ConfigureAwait(false);
            }
            catch (Exception error) { runnerInputFailure = error; }
            await window.CloseAsync().ConfigureAwait(false);
        }

        private static void ObserveInputFailure(Task failure)
        {
            // Main reports the same window-completion failure and any input
            // failure after the graceful drain. Observation itself cannot throw.
            failure.Exception.Handle(error => true);
        }

        private static void WriteDiagnostic(string text)
        {
            diagnostics.Write(text);
            diagnostics.Flush();
            Console.Error.Write(text);
            Trace.Write(text);
        }

        private static void WriteError(Exception error)
        {
            string diagnostic = ArcaneHost.Serializer().Serialize(ArcaneHost.ErrorRecord(error, "ARCANE_WINDOWS_HOST_FAILED"));
            diagnostics.WriteLine(diagnostic);
            diagnostics.Flush();
            Console.Error.WriteLine(diagnostic);
            Trace.WriteLine(diagnostic);
        }

        private static void OpenDiagnostics(string directory)
        {
            Directory.CreateDirectory(directory);
            string filename = Path.Combine(directory, "launch-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmss") + "-" + Guid.NewGuid().ToString("N") + ".log");
            StreamWriter writer = new StreamWriter(new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
            writer.AutoFlush = true;
            diagnostics = TextWriter.Synchronized(writer);
            diagnosticFilename = filename;
        }
    }
}
