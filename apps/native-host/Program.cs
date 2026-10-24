using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

const int MaxMessageBytes = 16 * 1024 * 1024;
var config = LoadConfig();
if (args.Contains("--pipe-relay"))
{
    var externalName = ReadArgument(args, "--external");
    var internalName = ReadArgument(args, "--internal");
    await RunPipeRelayAsync(externalName, internalName);
    return;
}
if (args.Contains("--broker-config"))
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        pipeName = $@"\\.\pipe\{config.PipeName}",
        authSecret = Convert.ToBase64String(config.Secret)
    }));
    return;
}
var pipeName = Environment.GetEnvironmentVariable("EGO_COMPANION_PIPE_NAME")
    ?? config.PipeName;

using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();
using var pipe = new NamedPipeClientStream(
    ".",
    pipeName,
    PipeDirection.InOut,
    PipeOptions.Asynchronous,
    System.Security.Principal.TokenImpersonationLevel.Identification);

await ConnectWithRetryAsync(pipe, TimeSpan.FromSeconds(15));
using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 64 * 1024, leaveOpen: true);
using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
{
    AutoFlush = true,
    NewLine = "\n"
};

await AuthenticateAsync(reader, writer, config.Secret);

using var shutdown = new CancellationTokenSource();
var browserToPipe = PumpBrowserAsync(input, writer, shutdown.Token);
var pipeToBrowser = PumpPipeAsync(reader, output, shutdown.Token);
await Task.WhenAny(browserToPipe, pipeToBrowser);
shutdown.Cancel();
pipe.Dispose();
// Native Messaging owns stdin for the browser lifetime. On Windows an outstanding
// console read may ignore cancellation, so waiting for both pumps would prevent the
// extension from observing host exit and reconnecting after a Broker restart.

static async Task ConnectWithRetryAsync(NamedPipeClientStream pipe, TimeSpan timeout)
{
    var deadline = DateTime.UtcNow + timeout;
    Exception? lastError = null;
    while (DateTime.UtcNow < deadline)
    {
        try
        {
            await pipe.ConnectAsync(1000);
            return;
        }
        catch (Exception error) when (error is TimeoutException or IOException)
        {
            lastError = error;
            await Task.Delay(250);
        }
    }
    throw new IOException("Ego Companion broker pipe is unavailable", lastError);
}

static string ReadArgument(string[] values, string name)
{
    var index = Array.IndexOf(values, name);
    if (index < 0 || index + 1 >= values.Length) throw new ArgumentException($"Missing {name}");
    return values[index + 1];
}

static async Task RunPipeRelayAsync(string externalName, string internalName)
{
    var currentSid = WindowsIdentity.GetCurrent().User
        ?? throw new InvalidOperationException("Current Windows SID is unavailable");
    var systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    var security = new PipeSecurity();
    security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
    security.SetOwner(currentSid);
    security.AddAccessRule(new PipeAccessRule(currentSid, PipeAccessRights.FullControl, AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(systemSid, PipeAccessRights.FullControl, AccessControlType.Allow));

    var announced = false;
    while (true)
    {
        await using var external = NamedPipeServerStreamAcl.Create(
            externalName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            64 * 1024,
            64 * 1024,
            security);
        if (!announced)
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ready = true,
                ownerSid = currentSid.Value,
                allowedSids = new[] { currentSid.Value, systemSid.Value },
                protectedAcl = true
            }));
            Console.Out.Flush();
            announced = true;
        }
        await external.WaitForConnectionAsync();
        await using var internalPipe = new NamedPipeClientStream(
            ".",
            internalName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification);
        try
        {
            await ConnectWithRetryAsync(internalPipe, TimeSpan.FromSeconds(10));
            using var stop = new CancellationTokenSource();
            var upstream = external.CopyToAsync(internalPipe, stop.Token);
            var downstream = internalPipe.CopyToAsync(external, stop.Token);
            await Task.WhenAny(upstream, downstream);
            stop.Cancel();
        }
        catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException)
        {
        }
    }
}

static async Task AuthenticateAsync(StreamReader reader, StreamWriter writer, byte[] secret)
{
    var line = await reader.ReadLineAsync() ?? throw new IOException("Broker closed before authentication");
    using var message = JsonDocument.Parse(line);
    if (message.RootElement.GetProperty("method").GetString() != "auth.challenge")
        throw new InvalidDataException("Invalid Broker authentication challenge");
    var nonce = Convert.FromBase64String(
        message.RootElement.GetProperty("params").GetProperty("nonce").GetString() ?? "");
    using var hmac = new HMACSHA256(secret);
    var proof = Convert.ToBase64String(hmac.ComputeHash(nonce));
    await writer.WriteLineAsync(JsonSerializer.Serialize(new
    {
        method = "auth.response",
        @params = new { proof }
    }));
    var confirmation = await reader.ReadLineAsync()
        ?? throw new IOException("Broker closed before authentication confirmation");
    using var confirmationMessage = JsonDocument.Parse(confirmation);
    if (confirmationMessage.RootElement.GetProperty("method").GetString() != "auth.ok")
        throw new InvalidDataException("Broker rejected Native Host authentication");
}

static CompanionConfig LoadConfig()
{
    var path = Environment.GetEnvironmentVariable("EGO_COMPANION_CONFIG")
        ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EgoCompat",
            "companion.json");
    if (!File.Exists(path))
        return new CompanionConfig("ego-compat-companion", Array.Empty<byte>());
    using var document = JsonDocument.Parse(File.ReadAllText(path));
    var pipeName = document.RootElement.GetProperty("pipeName").GetString()
        ?? throw new InvalidDataException("Companion config is missing pipeName");
    var protectedSecret = Convert.FromBase64String(
        document.RootElement.GetProperty("protectedSecret").GetString() ?? "");
    var secret = ProtectedData.Unprotect(protectedSecret, null, DataProtectionScope.CurrentUser);
    return new CompanionConfig(pipeName, secret);
}

static async Task PumpBrowserAsync(Stream input, StreamWriter writer, CancellationToken token)
{
    var header = new byte[4];
    while (!token.IsCancellationRequested)
    {
        if (!await ReadExactAsync(input, header, token)) return;
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > MaxMessageBytes) throw new InvalidDataException("Invalid native message length");
        var payload = new byte[length];
        if (!await ReadExactAsync(input, payload, token)) throw new EndOfStreamException();
        await writer.WriteLineAsync(Encoding.UTF8.GetString(payload).AsMemory(), token);
    }
}

static async Task PumpPipeAsync(StreamReader reader, Stream output, CancellationToken token)
{
    while (!token.IsCancellationRequested)
    {
        var line = await reader.ReadLineAsync(token);
        if (line is null) return;
        var payload = Encoding.UTF8.GetBytes(line);
        if (payload.Length > MaxMessageBytes) throw new InvalidDataException("Native message is too large");
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await output.WriteAsync(header, token);
        await output.WriteAsync(payload, token);
        await output.FlushAsync(token);
    }
}

static async Task<bool> ReadExactAsync(Stream stream, byte[] buffer, CancellationToken token)
{
    var offset = 0;
    while (offset < buffer.Length)
    {
        var read = await stream.ReadAsync(buffer.AsMemory(offset), token);
        if (read == 0) return offset == 0 ? false : throw new EndOfStreamException();
        offset += read;
    }
    return true;
}

readonly record struct CompanionConfig(string PipeName, byte[] Secret);
