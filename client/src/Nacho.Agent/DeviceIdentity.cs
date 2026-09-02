using Microsoft.Win32;
using System.Security.Cryptography;
using System.Text;

namespace Nacho.Agent;

/// <summary>
/// 返回与安装目录无关的 Windows 设备标识。
/// 标识不保存在 ProgramData，因此清理数据后重新安装仍会复用服务端设备记录。
/// </summary>
public static class DeviceIdentity
{
    private const string MachineGuidKey = @"SOFTWARE\Microsoft\Cryptography";

    public static string GetStableId()
    {
        var machineGuid = ReadMachineGuid();
        var source = string.IsNullOrWhiteSpace(machineGuid)
            ? $"machine:{Environment.MachineName.ToUpperInvariant()}"
            : $"machine-guid:{machineGuid.Trim().ToUpperInvariant()}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes("nacho-device-v1:" + source));
        return "device-" + Convert.ToHexString(hash.AsSpan(0, 16)).ToLowerInvariant();
    }

    private static string? ReadMachineGuid()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(MachineGuidKey, writable: false);
            return key?.GetValue("MachineGuid") as string;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
