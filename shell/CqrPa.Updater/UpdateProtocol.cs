using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace CqrPa.Updater;

internal sealed record UpdateFile(string Path, long Size, string Sha256);

internal sealed record VerifiedUpdate(
    int Sequence,
    int MinimumSupportedSequence,
    string Version,
    string Channel,
    string StageRoot,
    IReadOnlyList<UpdateFile> Files,
    IReadOnlyList<string> Deleted);

internal static class UpdateProtocol
{
    private const string Algorithm = "RSA-PSS-SHA256";
    private const string FeedSchema = "cqr-pa-update-feed/v1";
    private const string PayloadSchema = "cqr-pa-update-payload/v1";
    private static readonly HashSet<string> ProtectedRoots = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git",
        "data",
        "logs",
        "runtime",
    };

    public static VerifiedUpdate VerifyAndExtract(
        string feedPath,
        string zipPath,
        string publicKeyPath,
        string stageRoot)
    {
        var publicKeyPem = File.ReadAllText(publicKeyPath, Encoding.UTF8);
        using var feedEnvelope = JsonDocument.Parse(File.ReadAllBytes(feedPath));
        var feed = VerifyEnvelope(feedEnvelope.RootElement, publicKeyPem);
        RequireString(feed, "schema", FeedSchema);

        var sequence = RequirePositiveInt(feed, "update_sequence");
        var minimumSequence = RequirePositiveInt(feed, "minimum_supported_sequence");
        if (minimumSequence > sequence)
            throw new InvalidDataException("Feed minimum sequence exceeds update sequence.");
        var version = RequireNonEmptyString(feed, "version");
        var channel = RequireNonEmptyString(feed, "channel");
        var payloadManifestSha = RequireSha256(feed, "payload_manifest_sha256");
        var asset = feed.GetProperty("asset");
        var expectedSize = asset.GetProperty("size").GetInt64();
        var expectedZipSha = RequireSha256(asset, "sha256");
        if (expectedSize < 1 || new FileInfo(zipPath).Length != expectedSize)
            throw new InvalidDataException("Update ZIP size does not match signed feed.");
        if (!FixedEquals(expectedZipSha, Sha256File(zipPath)))
            throw new InvalidDataException("Update ZIP hash does not match signed feed.");

        ExtractZipSafely(zipPath, stageRoot);
        var payloadEnvelopePath = Path.Combine(stageRoot, "update-payload.json");
        if (!File.Exists(payloadEnvelopePath))
            throw new InvalidDataException("Signed payload manifest is missing.");
        var payloadEnvelopeBytes = File.ReadAllBytes(payloadEnvelopePath);
        if (!FixedEquals(payloadManifestSha, Sha256Bytes(payloadEnvelopeBytes)))
            throw new InvalidDataException("Payload manifest hash does not match signed feed.");

        using var payloadEnvelope = JsonDocument.Parse(payloadEnvelopeBytes);
        var payload = VerifyEnvelope(payloadEnvelope.RootElement, publicKeyPem);
        RequireString(payload, "schema", PayloadSchema);
        if (RequirePositiveInt(payload, "update_sequence") != sequence)
            throw new InvalidDataException("Feed and payload sequences differ.");
        if (RequirePositiveInt(payload, "minimum_supported_sequence") != minimumSequence)
            throw new InvalidDataException("Feed and payload minimum sequences differ.");
        RequireString(payload, "version", version);
        RequireString(payload, "channel", channel);

        var files = new List<UpdateFile>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in payload.GetProperty("files").EnumerateArray())
        {
            var relative = NormalizeManagedPath(RequireNonEmptyString(file, "path"));
            if (!seen.Add(relative)) throw new InvalidDataException($"Duplicate payload path: {relative}");
            var size = file.GetProperty("size").GetInt64();
            var sha = RequireSha256(file, "sha256");
            var stagedPath = ResolveUnder(stageRoot, relative);
            if (!File.Exists(stagedPath))
                throw new InvalidDataException($"Payload file is missing: {relative}");
            var info = new FileInfo(stagedPath);
            if (info.Length != size || !FixedEquals(sha, Sha256File(stagedPath)))
                throw new InvalidDataException($"Payload file verification failed: {relative}");
            files.Add(new UpdateFile(relative, size, sha));
        }
        if (files.Count == 0) throw new InvalidDataException("Payload contains no managed files.");

        var extractedFiles = Directory.EnumerateFiles(stageRoot, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(stageRoot, file).Replace('\\', '/'))
            .Where(relative => !relative.Equals("update-payload.json", StringComparison.OrdinalIgnoreCase))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!extractedFiles.SetEquals(seen))
            throw new InvalidDataException("ZIP contains files outside the signed inventory.");

        var deleted = payload.GetProperty("deleted").EnumerateArray()
            .Select(item => NormalizeManagedPath(item.GetString() ?? string.Empty))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (deleted.Any(seen.Contains))
            throw new InvalidDataException("A payload path cannot also be marked deleted.");

        return new VerifiedUpdate(
            sequence,
            minimumSequence,
            version,
            channel,
            stageRoot,
            files,
            deleted);
    }

    public static string NormalizeManagedPath(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.IndexOf('\0') >= 0)
            throw new InvalidDataException("Managed path must be non-empty.");
        var normalized = input.Replace('\\', '/');
        if (normalized.StartsWith('/') || Path.IsPathRooted(normalized))
            throw new InvalidDataException($"Managed path must be relative: {input}");
        var parts = normalized.Split('/');
        if (parts.Any(part => string.IsNullOrEmpty(part) || part is "." or ".."))
            throw new InvalidDataException($"Managed path contains unsafe segments: {input}");
        if (ProtectedRoots.Contains(parts[0]))
            throw new InvalidDataException($"Managed path targets protected data: {input}");
        return string.Join('/', parts);
    }

    public static string ResolveUnder(string root, string relative)
    {
        var safeRelative = NormalizeManagedPath(relative);
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(fullRoot, safeRelative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Path escapes update root: {relative}");
        return full;
    }

    public static string Sha256File(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string Sha256Bytes(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static bool FixedEquals(string expected, string actual) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(expected.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(actual.ToLowerInvariant()));

    private static JsonElement VerifyEnvelope(JsonElement envelope, string publicKeyPem)
    {
        RequireString(envelope, "algorithm", Algorithm);
        if (!envelope.TryGetProperty("document", out var document))
            throw new InvalidDataException("Signed envelope document is missing.");
        var signatureText = RequireNonEmptyString(envelope, "signature");
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(signatureText);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("Signed envelope signature is not base64.", ex);
        }

        using var rsa = RSA.Create();
        rsa.ImportFromPem(publicKeyPem);
        var canonical = CanonicalJson(document);
        if (!rsa.VerifyData(
                Encoding.UTF8.GetBytes(canonical),
                signature,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pss))
        {
            throw new InvalidDataException("Update signature verification failed.");
        }
        return document.Clone();
    }

    private static string CanonicalJson(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(
                   stream,
                   new JsonWriterOptions
                   {
                       Indented = false,
                       Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
                   }))
        {
            WriteCanonical(writer, element);
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(element.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(element.GetRawText(), skipInputValidation: false);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new InvalidDataException($"Unsupported JSON value: {element.ValueKind}");
        }
    }

    private static void ExtractZipSafely(string zipPath, string stageRoot)
    {
        Directory.CreateDirectory(stageRoot);
        using var archive = ZipFile.OpenRead(zipPath);
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue;
            var unixType = (entry.ExternalAttributes >> 16) & 0xF000;
            if (unixType == 0xA000)
                throw new InvalidDataException($"ZIP symlink is not allowed: {entry.FullName}");
            var entryPath = entry.FullName.Replace('\\', '/');
            while (entryPath.StartsWith("./", StringComparison.Ordinal)) entryPath = entryPath[2..];
            var relative = NormalizeManagedPath(entryPath);
            var destination = ResolveUnder(stageRoot, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            using var input = entry.Open();
            using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            input.CopyTo(output);
        }
    }

    private static int RequirePositiveInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)
            || !value.TryGetInt32(out var result)
            || result < 1)
        {
            throw new InvalidDataException($"{name} must be a positive integer.");
        }
        return result;
    }

    private static string RequireSha256(JsonElement element, string name)
    {
        var value = RequireNonEmptyString(element, name).ToLowerInvariant();
        if (value.Length != 64 || value.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException($"{name} must be SHA-256 hex.");
        return value;
    }

    private static string RequireNonEmptyString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"{name} is required.");
        }
        return value.GetString()!;
    }

    private static void RequireString(JsonElement element, string name, string expected)
    {
        var actual = RequireNonEmptyString(element, name);
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
            throw new InvalidDataException($"{name} must be {expected}.");
    }
}
