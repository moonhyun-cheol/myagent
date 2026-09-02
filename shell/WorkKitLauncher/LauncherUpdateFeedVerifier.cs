using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CqrPa.WorkKitLauncher;

internal sealed record LauncherUpdateFeedAsset(
    string Repository,
    string ReleaseTag,
    string Name,
    long Size,
    string Sha256);

internal sealed record LauncherAvailableUpdate(
    int Sequence,
    int MinimumSupportedSequence,
    string Version,
    string Channel,
    string ReleaseNotes,
    LauncherUpdateFeedAsset Asset,
    byte[] FeedBytes);

internal static class LauncherUpdateFeedVerifier
{
    private const string Algorithm = "RSA-PSS-SHA256";
    private const string Schema = "my-agent-launcher-feed/v1";
    private const string Kind = "work-kit-launcher";

    public static LauncherAvailableUpdate Verify(
        byte[] feedBytes,
        string publicKeyPem,
        string expectedRepository,
        string expectedChannel)
    {
        using var envelopeDocument = JsonDocument.Parse(feedBytes);
        var envelope = envelopeDocument.RootElement;
        RequireString(envelope, "algorithm", Algorithm);
        if (!envelope.TryGetProperty("document", out var document))
            throw new InvalidDataException("Launcher update feed document is missing.");
        var signatureText = RequireNonEmptyString(envelope, "signature");
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(signatureText);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("Launcher update feed signature is not base64.", ex);
        }

        using var rsa = RSA.Create();
        rsa.ImportFromPem(publicKeyPem);
        if (!rsa.VerifyData(
                Encoding.UTF8.GetBytes(CanonicalJson(document)),
                signature,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pss))
        {
            throw new InvalidDataException("Launcher update feed signature verification failed.");
        }

        RequireString(document, "schema", Schema);
        RequireString(document, "kind", Kind);
        var sequence = RequirePositiveInt(document, "update_sequence");
        var minimumSequence = RequirePositiveInt(document, "minimum_supported_sequence");
        if (minimumSequence > sequence)
            throw new InvalidDataException("Launcher update feed minimum sequence exceeds update sequence.");
        var version = RequireNonEmptyString(document, "version");
        var channel = RequireNonEmptyString(document, "channel");
        if (!string.Equals(channel, expectedChannel, StringComparison.Ordinal))
            throw new InvalidDataException("Launcher update feed channel does not match this installation.");
        var notes = document.TryGetProperty("release_notes", out var notesValue)
            && notesValue.ValueKind == JsonValueKind.String
            ? notesValue.GetString() ?? string.Empty
            : string.Empty;
        var asset = document.GetProperty("asset");
        var repository = RequireNonEmptyString(asset, "repository");
        if (!string.Equals(repository, expectedRepository, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Launcher update feed repository does not match this installation.");
        var releaseTag = RequireNonEmptyString(asset, "release_tag");
        if (!string.Equals(releaseTag, $"launcher-update-{sequence}", StringComparison.Ordinal))
            throw new InvalidDataException("Launcher release tag does not match its sequence.");
        var name = RequireNonEmptyString(asset, "name");
        if (!string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal)
            || name.IndexOfAny(['/', '\\']) >= 0
            || !Regex.IsMatch(
                name,
                $@"^WorkKitLauncher-v.+\-update-{sequence}\.zip$",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
        {
            throw new InvalidDataException("Launcher update asset name is unsafe.");
        }
        var size = asset.GetProperty("size").GetInt64();
        if (size < 1) throw new InvalidDataException("Launcher update asset size is invalid.");
        var sha = RequireSha256(asset, "sha256");
        return new LauncherAvailableUpdate(
            sequence,
            minimumSequence,
            version,
            channel,
            notes,
            new LauncherUpdateFeedAsset(repository, releaseTag, name, size, sha),
            feedBytes);
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
                throw new InvalidDataException($"Unsupported feed JSON value: {element.ValueKind}");
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
