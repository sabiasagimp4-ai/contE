using System.Text.Json;
using ContE.Desktop.Services;

namespace ContE.Desktop.Bridge;

public sealed class BridgeRouter
{
    private readonly NativeFileService _files;
    private readonly Action<bool> _setDirty;

    public BridgeRouter(NativeFileService files, Action<bool> setDirty)
    {
        _files = files;
        _setDirty = setDirty;
    }

    public async Task<string?> HandleAsync(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (!root.TryGetProperty("type", out var type) || type.GetString() != "request")
            return null;
        var id = root.GetProperty("id").GetString() ?? throw new BridgeException("invalid_request", "Bridge要求にidがありません");
        var protocol = root.TryGetProperty("protocol", out var protocolNode) ? protocolNode.GetInt32() : 0;
        var method = root.GetProperty("method").GetString() ?? "";
        var parameters = root.TryGetProperty("params", out var paramsNode)
            ? paramsNode
            : default;

        try
        {
            if (protocol != 1)
                throw new BridgeException("protocol_mismatch", "Bridgeのプロトコルが一致しません");

            object result = method switch
            {
                "app.hello" => new
                {
                    protocol = 1,
                    platform = "windows-webview2",
                    hostVersion = typeof(BridgeRouter).Assembly.GetName().Version?.ToString() ?? "0.1.0",
                    capabilities = new[] { "file.open", "file.save", "indexeddb", "downloads", "startup-open" },
                    startupFile = _files.ConsumeStartupOpen(),
                },
                "app.setDirty" => SetDirty(parameters),
                "file.open" => _files.PrepareOpen() ?? new { cancelled = true },
                "file.prepareSave" => _files.PrepareSave(GetString(parameters, "suggestedName") ?? "contE.contb") ?? new { cancelled = true },
                _ => throw new BridgeException("unknown_method", $"未対応のBridge操作です：{method}"),
            };
            return Response(id, true, result, null);
        }
        catch (BridgeException error)
        {
            return Response(id, false, null, new { code = error.Code, message = error.Message });
        }
        catch (Exception error)
        {
            return Response(id, false, null, new { code = "host_error", message = error.Message });
        }
    }

    private object SetDirty(JsonElement parameters)
    {
        _setDirty(parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("dirty", out var dirty) && dirty.GetBoolean());
        return new { accepted = true };
    }

    private static string? GetString(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value)
            ? value.GetString()
            : null;

    private static string Response(string id, bool ok, object? result, object? error) =>
        JsonSerializer.Serialize(new { type = "response", id, ok, result, error });
}
