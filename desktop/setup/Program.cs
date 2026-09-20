using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Win32;
using System.Windows.Forms;

namespace ContE.Setup;

internal static class Program
{
    private const string InstallFolder = "contE";
    private const string ProjectClass = "contE.Project";

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            if (args.Any(arg => string.Equals(arg, "--uninstall", StringComparison.OrdinalIgnoreCase)))
            {
                Uninstall();
                return 0;
            }

            Install();
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"contEのセットアップに失敗しました。{Environment.NewLine}{Environment.NewLine}{error.Message}",
                "contE Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Install()
    {
        var installRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", InstallFolder);
        var parent = Directory.GetParent(installRoot)?.FullName
            ?? throw new InvalidOperationException("インストール先を解決できません");
        Directory.CreateDirectory(parent);

        var staging = Path.Combine(parent, $".{InstallFolder}.new-{Guid.NewGuid():N}");
        var previous = Path.Combine(parent, $".{InstallFolder}.old-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(staging);
            using var payload = Assembly.GetExecutingAssembly()
                .GetManifestResourceStream("contE.payload.zip")
                ?? throw new InvalidOperationException("セットアップにアプリ本体が含まれていません");
            ExtractSafely(payload, staging);

            if (Directory.Exists(installRoot))
                Directory.Move(installRoot, previous);
            Directory.Move(staging, installRoot);
            RegisterFileAssociations(Path.Combine(installRoot, "contE.exe"));

            TryDeleteDirectory(previous);
            staging = "";
        }
        finally
        {
            if (!string.IsNullOrEmpty(staging))
                TryDeleteDirectory(staging);
        }

        var start = MessageBox.Show(
            "contEのインストールが完了しました。今すぐ起動しますか？",
            "contE Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (start == DialogResult.Yes)
            Process.Start(new ProcessStartInfo(Path.Combine(installRoot, "contE.exe"))
            {
                UseShellExecute = true,
            });
    }

    private static void ExtractSafely(Stream payload, string destination)
    {
        var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
        using var archive = new ZipArchive(payload, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(destination, entry.FullName));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("セットアップ内のパスが不正です");

            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }
    }

    private static void RegisterFileAssociations(string executable)
    {
        RegisterFileAssociation(".contb", executable);
        RegisterFileAssociation(".contp", executable);
    }

    private static void RegisterFileAssociation(string extension, string executable)
    {
        using var extensionKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{extension}");
        extensionKey!.SetValue("", ProjectClass);

        using var classKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProjectClass}");
        classKey!.SetValue("", "contE Project");
        using var iconKey = classKey.CreateSubKey("DefaultIcon");
        var quoted = $"\"{executable}\"";
        iconKey!.SetValue("", $"{quoted},0");
        using var commandKey = classKey.CreateSubKey(@"shell\open\command");
        commandKey!.SetValue("", $"{quoted} \"%1\"");
    }

    private static void Uninstall()
    {
        var installRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", InstallFolder);
        TryDeleteDirectory(installRoot);
        Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{ProjectClass}", throwOnMissingSubKey: false);
        foreach (var extension in new[] { ".contb", ".contp" })
        {
            using var key = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{extension}", writable: true);
            if (key?.GetValue("") is string value &&
                string.Equals(value, ProjectClass, StringComparison.Ordinal))
                Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{extension}", throwOnMissingSubKey: false);
        }
        MessageBox.Show("contEをアンインストールしました。", "contE Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static void TryDeleteDirectory(string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch
        {
            // 古いバージョンの掃除は次回セットアップで再試行する。
        }
    }
}
