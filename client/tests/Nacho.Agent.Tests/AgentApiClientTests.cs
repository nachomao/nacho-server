using System.Net;
using System.Text;
using Microsoft.Extensions.Options;
using Nacho.Agent;

namespace Nacho.Agent.Tests;

public sealed class AgentApiClientTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "nacho-agent-api-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Concurrent_enrollment_requests_share_one_server_call()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllText(Path.Combine(_directory, "enrollment.key"), "test-key");
        var handler = new EnrollmentHandler();
        using var client = new AgentApiClient(
            Options.Create(new AgentOptions { ServerUrl = "http://127.0.0.1:8443" }),
            new StateStore(new AgentPaths(_directory)),
            handler);

        var states = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => client.EnsureEnrolledAsync(CancellationToken.None)));

        Assert.Equal(1, handler.RequestCount);
        Assert.All(states, state => Assert.Equal(new AgentState("client-1", "token-1"), state));
        Assert.False(File.Exists(Path.Combine(_directory, "enrollment.key")));
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }

    private sealed class EnrollmentHandler : HttpMessageHandler
    {
        private int _requestCount;
        public int RequestCount => _requestCount;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requestCount);
            Assert.Equal("/agent/enroll", request.RequestUri?.AbsolutePath);
            await Task.Delay(20, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent("{\"ok\":true,\"data\":{\"client\":{\"id\":\"client-1\"},\"token\":\"token-1\"}}", Encoding.UTF8, "application/json"),
            };
        }
    }
}
