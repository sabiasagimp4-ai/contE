using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace ContE.Desktop.Services;

public sealed record NativeResponse(Stream Body, int StatusCode, string Reason, string Headers);

public sealed class NativeFileService
{
    public const string AppOrigin = "https://app.conte.invalid";
    private readonly Dictionary<string, Transfer> _transfers = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private string? _currentPath;
    private bool _dirty;

    public object? PrepareOpen()
    {
        var dialog = new OpenFileDialog
        {
            Title = "contE Projectを開く",
            Filter = "contE Project (*.contb;*.contp)|*.contb;*.contp|すべてのファイル (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (dialog.ShowDialog() != true) return null;
        var path = dialog.FileName;
        var token = AddTransfer(new Transfer(TransferKind.Open, path));
        return new { token, url = StreamUrl(token), name = Path.GetFileName(path), mime = Mime(path) };
    }

    public object? PrepareSave(string suggestedName)
    {
        var path = _currentPath;
        if (string.IsNullOrWhiteSpace(path) ||
            !string.Equals(Path.GetExtension(path), ".contb", StringComparison.OrdinalIgnoreCase))
        {
            var dialog = new SaveFileDialog
            {
                Title = "contE Projectを保存",
                Filter = "contE Project (*.contb)|*.contb|すべてのファイル (*.*)|*.*",
                DefaultExt = ".contb",
                AddExtension = true,
                FileName = Path.GetFileName(suggestedName),
                OverwritePrompt = true,
            };
            if (dialog.ShowDialog() != true) return null;
            path = dialog.FileName;
        }
        if (!string.Equals(Path.GetExtension(path), ".contb", StringComparison.OrdinalIgnoreCase))
            path += ".contb";
        var token = AddTransfer(new Transfer(TransferKind.Save, path));
        return new { token, url = StreamUrl(token), name = Path.GetFileName(path) };
    }

    public async Task<NativeResponse> HandleStreamAsync(string method, string token, IStream? content)
    {
        if (string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
            return Open(token);
        if (string.Equals(method, "PUT", StringComparison.OrdinalIgnoreCase))
            return await SaveAsync(token, content ?? throw new IOException("保存データがありません"));
        return TextResponse("対応していないHTTPメソッドです", 405, "Method Not Allowed");
    }

    public static bool TryParseStreamPath(string uri, out string token)
    {
        token = "";
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed) ||
            !string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(parsed.Host, "app.conte.invalid", StringComparison.OrdinalIgnoreCase))
            return false;
        const string prefix = "/__native__/";
        if (!parsed.AbsolutePath.StartsWith(prefix, StringComparison.Ordinal)) return false;
        token = parsed.AbsolutePath[prefix.Length..];
        return token.Length is > 0 and <= 128 && token.All(c => char.IsLetterOrDigit(c) || c is '-' or '_');
    }

    private NativeResponse Open(string token)
    {
        var transfer = Take(token, TransferKind.Open);
        if (!File.Exists(transfer.Path))
            return TextResponse("ファイルが見つかりません", 404, "Not Found");
        _currentPath = transfer.Path;
        var stream = new FileStream(transfer.Path, FileMode.Open, FileAccess.Read, FileShare.Read,
            128 * 1024, FileOptions.SequentialScan);
        var headers = $"Content-Type: {Mime(transfer.Path)}\r\nContent-Length: {stream.Length}\r\nCache-Control: no-store";
        return new NativeResponse(stream, 200, "OK", headers);
    }

    private async Task<NativeResponse> SaveAsync(string token, IStream content)
    {
        var transfer = Take(token, TransferKind.Save);
        var directory = Path.GetDirectoryName(transfer.Path);
        if (string.IsNullOrWhiteSpace(directory))
            return TextResponse("保存先が不正です", 400, "Bad Request");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".{Path.GetFileName(transfer.Path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                128 * 1024, FileOptions.SequentialScan | FileOptions.WriteThrough))
            {
                await CopyComStreamAsync(content, output);
                await output.FlushAsync();
                output.Flush(true);
            }
            if (File.Exists(transfer.Path))
                File.Replace(temporary, transfer.Path, transfer.Path + ".bak", true);
            else
                File.Move(temporary, transfer.Path);
            _currentPath = transfer.Path;
            _dirty = false;
            var info = new FileInfo(transfer.Path);
            await using var savedFile = File.OpenRead(transfer.Path);
            var hash = await SHA256.HashDataAsync(savedFile);
            var body = JsonSerializer.SerializeToUtf8Bytes(new
            {
                saved = true,
                name = info.Name,
                bytes = info.Length,
                sha256 = Convert.ToHexString(hash).ToLowerInvariant(),
            });
            return new NativeResponse(new MemoryStream(body), 200, "OK", "Content-Type: application/json\r\nCache-Control: no-store");
        }
        catch (Exception error)
        {
            TryDelete(temporary);
            return TextResponse(error.Message, 500, "Internal Server Error", new { error = new { code = "save_failed", message = error.Message } });
        }
    }

    private string AddTransfer(Transfer transfer)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant();
        lock (_gate) _transfers[token] = transfer;
        return token;
    }

    private Transfer Take(string token, TransferKind kind)
    {
        lock (_gate)
        {
            if (!_transfers.Remove(token, out var transfer) || transfer.Kind != kind)
                throw new FileNotFoundException("一時ファイルTokenが無効です");
            return transfer;
        }
    }

    private static string StreamUrl(string token) => $"{AppOrigin}/__native__/{token}";

    private static string Mime(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".contb" => "application/octet-stream",
        ".contp" => "application/json",
        _ => "application/octet-stream",
    };

    private static NativeResponse TextResponse(string message, int status, string reason, object? payload = null)
    {
        var body = payload is null
            ? JsonSerializer.SerializeToUtf8Bytes(new { message })
            : JsonSerializer.SerializeToUtf8Bytes(payload);
        return new NativeResponse(new MemoryStream(body), status, reason, "Content-Type: application/json\r\nCache-Control: no-store");
    }

    private static async Task CopyComStreamAsync(IStream source, FileStream destination)
    {
        var buffer = new byte[128 * 1024];
        var readPointer = Marshal.AllocHGlobal(sizeof(int));
        try
        {
            while (true)
            {
                Marshal.WriteInt32(readPointer, 0);
                source.Read(buffer, buffer.Length, readPointer);
                var count = Marshal.ReadInt32(readPointer);
                if (count <= 0) break;
                await destination.WriteAsync(buffer.AsMemory(0, count));
            }
        }
        finally
        {
            Marshal.FreeHGlobal(readPointer);
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private sealed record Transfer(TransferKind Kind, string Path);
    private enum TransferKind { Open, Save }
}
