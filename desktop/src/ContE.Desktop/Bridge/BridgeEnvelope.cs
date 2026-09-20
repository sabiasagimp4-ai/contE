using System.Text.Json;

namespace ContE.Desktop.Bridge;

public sealed record BridgeEnvelope(
    int Protocol,
    string Type,
    string Id,
    string Method,
    JsonElement Params);

public sealed class BridgeException : Exception
{
    public BridgeException(string code, string message) : base(message) => Code = code;

    public string Code { get; }
}
