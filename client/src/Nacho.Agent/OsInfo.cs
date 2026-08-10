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
            return NormalizeDisplayName(product, displayVersion, build);
        }
        catch (Exception)
        {
            // 注册表不可读时退回到内部版本号判断，避免影响注册与心跳
            return NormalizeDisplayName(null, null, Environment.OSVersion.Version.Build);
        }
    }

    /// <summary>根据注册表名称与内部构建号生成稳定的展示名称。</summary>
    internal static string NormalizeDisplayName(string? product, string? displayVersion, int build)
    {
        var normalizedProduct = product?.Trim();
        var normalizedDisplayVersion = displayVersion?.Trim();

        if (string.IsNullOrWhiteSpace(normalizedProduct))
            return build >= Windows11MinimumBuild ? "Windows 11" : "Windows";

        // Windows 11 的 ProductName 仍可能写作 "Windows 10 ..."，必须以内核构建号为准。
        if (build >= Windows11MinimumBuild && normalizedProduct.Contains("Windows 10", StringComparison.OrdinalIgnoreCase))
            normalizedProduct = normalizedProduct.Replace("Windows 10", "Windows 11", StringComparison.OrdinalIgnoreCase);

        return string.IsNullOrWhiteSpace(normalizedDisplayVersion)
            ? normalizedProduct
            : $"{normalizedProduct} {normalizedDisplayVersion}";
    }
}
