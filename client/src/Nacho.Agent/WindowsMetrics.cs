using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace Nacho.Agent;

public sealed class WindowsMetrics
{
    private long _previousIdle;
    private long _previousKernel;
    private long _previousUser;

    public ClientMetrics Read()
    {
        // 心跳指标统一保留两位小数，避免面板把多位浮点数挤在同一行。
        var cpu = RoundPercent(ReadCpu());
        var memory = RoundPercent(ReadMemory());
        var disk = RoundPercent(ReadDisk());
        return new ClientMetrics(cpu, memory, disk, Environment.TickCount64 / 1000);
    }

    private static double RoundPercent(double value) => Math.Round(Math.Clamp(value, 0, 100), 2, MidpointRounding.AwayFromZero);

    private double ReadCpu()
    {
        if (!GetSystemTimes(out var idle, out var kernel, out var user)) return 0;
        var idleTicks = ToLong(idle);
        var kernelTicks = ToLong(kernel);
        var userTicks = ToLong(user);
        var total = (kernelTicks - _previousKernel) + (userTicks - _previousUser);
        var active = total - (idleTicks - _previousIdle);
        _previousIdle = idleTicks;
        _previousKernel = kernelTicks;
        _previousUser = userTicks;
        return total <= 0 ? 0 : Math.Clamp(active * 100d / total, 0, 100);
    }

    private static double ReadMemory()
    {
        var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        return GlobalMemoryStatusEx(ref status) ? (1 - status.AvailablePhysical / (double)status.TotalPhysical) * 100 : 0;
    }

    private static double ReadDisk()
    {
        var drive = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory)!);
        return drive.TotalSize == 0 ? 0 : (1 - drive.AvailableFreeSpace / (double)drive.TotalSize) * 100;
    }

    private static long ToLong(FileTime time) => ((long)time.High << 32) | (uint)time.Low;

    [DllImport("kernel32.dll")]
    private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);

    [DllImport("kernel32.dll")]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhysical;
        public ulong AvailablePhysical;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;
    }
}
