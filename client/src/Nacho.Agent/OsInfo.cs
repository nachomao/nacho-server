using Microsoft.Win32;

namespace Nacho.Agent;

/// <summary>
/// 解析本机具体操作系统名称，供面板匹配对应的系统标识（如 Windows 11）。
/// 注册表在 Windows 11 上仍将 ProductName 写作 "Windows 10"，因此需按内部版本号（>= 22000）纠正。
/// </summary>
public static class OsInfo
{
    private const int Windows11MinimumBuild = 22000;

    /// <summary>缓存一次即可，运行期间系统版本不会变化。</summary>
    public static string DisplayName { get; } = Resolve();

    private static string Resolve()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var product = key?.GetValue("ProductName") as string;
            var displayVersion = key?.GetValue("DisplayVersion") as string;
            var build = Environment.OSVersion.Version.Build;

            if (string.IsNullOrWhiteSpace(product))
                return build >= Windows11MinimumBuild ? "Windows 11" : "Windows";

            // Windows 11 的 ProductName 仍为 "Windows 10 ..."，按内部版本号替换前缀
            if (build >= Windows11MinimumBuild && product.Contains("Windows 10", StringComparison.OrdinalIgnoreCase))
                product = product.Replace("Windows 10", "Windows 11", StringComparison.OrdinalIgnoreCase);

            return string.IsNullOrWhiteSpace(displayVersion) ? product : $"{product} {displayVersion}";
        }
        catch (Exception)
        {
            // 注册表不可读时退回到内部版本号判断，避免影响注册与心跳
            return Environment.OSVersion.Version.Build >= Windows11MinimumBuild ? "Windows 11" : "Windows";
        }
    }
}
