using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace Arcane.Core.Hosts.Windows
{
    /// <summary>
    /// One host-session ledger, independent of Core and renderer readiness.
    /// The dedicated document-start ingress acknowledges only retained records.
    /// Diagnostic property graphs are data; the host never evaluates their fields.
    /// </summary>
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public sealed class ArcaneNativeDiagnostics
    {
        private readonly object stateLock = new object();
        private readonly string sessionId = Guid.NewGuid().ToString();
        private readonly string captureStartedAt = DateTime.UtcNow.ToString("o");
        private readonly List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
        private readonly Dictionary<string, Dictionary<string, object>> documents =
            new Dictionary<string, Dictionary<string, object>>();
        private readonly Action<Exception> onFailure;
        private long sequence;
        private bool captureInstalled;
        private bool stopped;

        internal ArcaneNativeDiagnostics(Action<Exception> onFailure) { this.onFailure = onFailure; }

        public string Send(string json)
        {
            try
            {
                Dictionary<string, object> frame = ArcaneHost.Serializer().DeserializeObject(json) as Dictionary<string, object>;
                if (frame == null || Text(frame, "protocol") != "arcane.native-diagnostics/1")
                    throw new InvalidDataException("Expected an Arcane native diagnostic envelope.");
                string type = Text(frame, "type");
                string documentId = Text(frame, "documentId");
                string documentUrl = Text(frame, "documentUrl");
                string time = Text(frame, "time");
                if (documentId == null || documentUrl == null || time == null)
                    throw new InvalidDataException("The diagnostic envelope needs its document identity, URL and time.");
                object value;
                Dictionary<string, object> record = frame.TryGetValue("record", out value)
                    ? value as Dictionary<string, object> : null;
                if (type != "document" && (type != "error" || record == null))
                    throw new InvalidDataException("Expected a document announcement or an error record.");

                Dictionary<string, object> result = new Dictionary<string, object>
                {
                    { "accepted", true }, { "sessionId", sessionId }
                };
                lock (stateLock)
                {
                    if (stopped) throw new InvalidOperationException("The native diagnostic session is closing.");
                    string receivedAt = DateTime.UtcNow.ToString("o");
                    if (!documents.ContainsKey(documentId))
                        documents.Add(documentId, new Dictionary<string, object>
                        {
                            { "documentId", documentId }, { "documentUrl", documentUrl },
                            { "time", time }, { "receivedAt", receivedAt }
                        });
                    if (type == "error")
                    {
                        Dictionary<string, object> retained = new Dictionary<string, object>(record);
                        retained["sequence"] = ++sequence;
                        retained["receivedAt"] = receivedAt;
                        retained["documentId"] = documentId;
                        retained["documentUrl"] = documentUrl;
                        retained["time"] = time;
                        records.Add(retained);
                        result["sequence"] = sequence;
                    }
                }
                return ArcaneHost.Serializer().Serialize(result);
            }
            catch (Exception error)
            {
                onFailure(error);
                return ArcaneHost.Serializer().Serialize(new Dictionary<string, object>
                {
                    { "accepted", false },
                    { "error", ArcaneHost.ErrorRecord(error, "ARCANE_NATIVE_DIAGNOSTIC_CAPTURE_FAILED") }
                });
            }
        }

        internal object Snapshot(Dictionary<string, object> parameters)
        {
            object selected;
            long afterSequence = 0;
            if (parameters.TryGetValue("afterSequence", out selected))
            {
                if (!(selected is int || selected is long || selected is decimal || selected is double))
                    throw new ArgumentException("afterSequence must be a nonnegative integer.");
                afterSequence = Convert.ToInt64(selected);
                if (afterSequence < 0 || Convert.ToDouble(selected) != afterSequence)
                    throw new ArgumentException("afterSequence must be a nonnegative integer.");
            }
            string documentId = null;
            if (parameters.TryGetValue("documentId", out selected))
            {
                documentId = selected as string;
                if (documentId == null) throw new ArgumentException("documentId must be a string.");
            }
            lock (stateLock)
            {
                List<object> found = new List<object>();
                foreach (Dictionary<string, object> record in records)
                {
                    if ((long)record["sequence"] <= afterSequence) continue;
                    if (documentId != null && (string)record["documentId"] != documentId) continue;
                    found.Add(record);
                }
                List<object> observedDocuments = new List<object>();
                foreach (KeyValuePair<string, Dictionary<string, object>> document in documents)
                    if (documentId == null || document.Key == documentId) observedDocuments.Add(document.Value);
                return new Dictionary<string, object>
                {
                    { "sessionId", sessionId }, { "captureStartedAt", captureStartedAt },
                    { "captureInstalled", captureInstalled }, { "latestSequence", sequence },
                    { "documents", observedDocuments }, { "records", found }
                };
            }
        }

        internal void Installed() { lock (stateLock) captureInstalled = true; }

        internal void Stop() { lock (stateLock) stopped = true; }

        private static string Text(Dictionary<string, object> record, string key)
        {
            object value;
            return record.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
