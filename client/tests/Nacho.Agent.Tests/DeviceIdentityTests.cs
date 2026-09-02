using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class DeviceIdentityTests
{
    [Fact]
    public void Stable_id_is_deterministic_and_opaque()
    {
        var first = DeviceIdentity.GetStableId();
        var second = DeviceIdentity.GetStableId();

        Assert.Equal(first, second);
        Assert.StartsWith("device-", first, StringComparison.Ordinal);
        Assert.Equal(39, first.Length);
    }
}
