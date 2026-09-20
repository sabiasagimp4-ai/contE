using System.Diagnostics;
using System.IO;
using System.Text;
using Microsoft.Web.WebView2.Core;
using ContE.Desktop.Bridge;
using ContE.Desktop.Services;

namespace ContE.Desktop;

public partial class MainWindow : System.Windows.Window
{
    private const string AppOrigin = NativeFileService.AppOrigin;
    private readonly bool _smokeTest = Environment.GetCommandLineArgs().Contains("--smoke-test", StringComparer.OrdinalIgnoreCase);
    private readonly NativeFileService _files = new();
    private BridgeRouter? _router;
    private bool _dirty;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    private async void OnLoaded(object sender, System.Windows.RoutedEventArgs e)
    {
        try
        {
            var webRoot = Path.Combine(AppContext.BaseDirectory, "Web");
            if (!Directory.Exists(webRoot))
                throw new DirectoryNotFoundException($"Web資産が見つかりません：{webRoot}");

            var dataRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "contE", "WebView2");
            Directory.CreateDirectory(dataRoot);
            var environment = await CoreWebView2Environment.CreateAsync(null, dataRoot);
            await Browser.EnsureCoreWebView2Async(environment);
            var core = Browser.CoreWebView2;
            _router = new BridgeRouter(_files, SetDirty);
            core.Settings.AreDefaultContextMenusEnabled = !_smokeTest;
            core.Settings.AreDevToolsEnabled = _smokeTest;
            core.Settings.IsZoomControlEnabled = true;
            core.SetVirtualHostNameToFolderMapping(
                "app.conte.invalid", webRoot, CoreWebView2HostResourceAccessKind.Allow);
            core.AddWebResourceRequestedFilter(
                $"{AppOrigin}/__native__/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnWebResourceRequested;
            core.WebMessageReceived += OnWebMessageReceived;
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.DownloadStarting += OnDownloadStarting;
            core.Navigate($"{AppOrigin}/index.html");
            if (_smokeTest) await WaitForSmokeReadyAsync();
        }
        catch (Exception error)
        {
            Fail(error);
        }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_router is null) return;
        try
        {
            var response = await _router.HandleAsync(e.WebMessageAsJson);
            if (response is not null) Browser.CoreWebView2.PostWebMessageAsJson(response);
        }
        catch (Exception error)
        {
            Fail(error);
        }
    }

    private async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (!NativeFileService.TryParseStreamPath(e.Request.Uri, out var token)) return;
        var deferral = e.GetDeferral();
        try
        {
            var result = await _files.HandleStreamAsync(e.Request.Method, token, e.Request.Content);
            e.Response = Browser.CoreWebView2.Environment.CreateWebResourceResponse(
                result.Body, result.StatusCode, result.Reason, result.Headers);
        }
        catch (FileNotFoundException error)
        {
            e.Response = Browser.CoreWebView2.Environment.CreateWebResourceResponse(
                new MemoryStream(Encoding.UTF8.GetBytes(error.Message)), 404, "Not Found",
                "Content-Type: text/plain; charset=utf-8");
        }
        catch (Exception error)
        {
            e.Response = Browser.CoreWebView2.Environment.CreateWebResourceResponse(
                new MemoryStream(Encoding.UTF8.GetBytes(error.Message)), 500, "Internal Server Error",
                "Content-Type: text/plain; charset=utf-8");
        }
        finally
        {
            deferral.Complete();
        }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) &&
            string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(uri.Host, "app.conte.invalid", StringComparison.OrdinalIgnoreCase)) return;
        if (!string.Equals(e.Uri, "about:blank", StringComparison.OrdinalIgnoreCase))
        {
            e.Cancel = true;
            OpenExternal(e.Uri);
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenExternal(e.Uri);
    }

    private static void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed) ||
            parsed.Scheme is not (Uri.UriSchemeHttp or Uri.UriSchemeHttps)) return;
        Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var downloads = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(downloads);
        var name = Path.GetFileName(e.ResultFilePath);
        if (string.IsNullOrWhiteSpace(name)) name = "contE-export";
        e.ResultFilePath = UniquePath(Path.Combine(downloads, name));
    }

    private static string UniquePath(string path)
    {
        if (!File.Exists(path)) return path;
        var directory = Path.GetDirectoryName(path)!;
        var name = Path.GetFileNameWithoutExtension(path);
        var extension = Path.GetExtension(path);
        for (var i = 2; i < 10_000; i++)
        {
            var candidate = Path.Combine(directory, $"{name} ({i}){extension}");
            if (!File.Exists(candidate)) return candidate;
        }
        return Path.Combine(directory, $"{name}-{Guid.NewGuid():N}{extension}");
    }

    private void SetDirty(bool dirty)
    {
        _dirty = dirty;
        Title = dirty ? "contE *" : "contE";
    }

    private async Task WaitForSmokeReadyAsync()
    {
        for (var i = 0; i < 100; i++)
        {
            var ready = await Browser.ExecuteScriptAsync("Boolean(window.__conteDesktopReady)");
            if (ready == "true")
            {
                System.Windows.Application.Current.Shutdown(0);
                return;
            }
            await Task.Delay(100);
        }
        Fail(new TimeoutException("contE desktop handshakeが完了しませんでした"));
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (!_dirty || _smokeTest) return;
        var result = System.Windows.MessageBox.Show(
            "保存されていない変更があります。終了しますか？",
            "contE", System.Windows.MessageBoxButton.YesNo,
            System.Windows.MessageBoxImage.Warning);
        if (result != System.Windows.MessageBoxResult.Yes) e.Cancel = true;
    }

    private void Fail(Exception error)
    {
        if (_smokeTest)
        {
            Console.Error.WriteLine(error);
            System.Windows.Application.Current.Shutdown(1);
            return;
        }
        System.Windows.MessageBox.Show(error.Message, "contEを起動できません", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Error);
        System.Windows.Application.Current.Shutdown(1);
    }
}
