using System.Runtime.InteropServices;

namespace Nacho.Agent;

internal static class WindowsCommandLine
{
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern nint CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc);

    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint handle);

    public static string[] Split(string commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return [];
        var pointer = CommandLineToArgvW("nacho-agent.exe " + commandLine, out var argc);
        if (pointer == 0) throw new InvalidDataException("Arguments are not valid Windows command-line syntax.");
        try
        {
            var result = new string[Math.Max(argc - 1, 0)];
            for (var i = 1; i < argc; i++) result[i - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * nint.Size)) ?? "";
            return result;
        }
        finally { LocalFree(pointer); }
    }
}
