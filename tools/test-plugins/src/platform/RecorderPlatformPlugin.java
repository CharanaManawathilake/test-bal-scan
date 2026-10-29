package playground.platform;

import io.ballerina.scan.Issue;
import io.ballerina.scan.PlatformPluginContext;
import io.ballerina.scan.StaticCodeAnalysisPlatformPlugin;
import io.ballerina.tools.text.LineRange;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * A platform plugin that writes what the scan tool hands it to platform-&lt;name&gt;-output.json in the working
 * directory, so the playground can show which issues and arguments reached a platform.
 */
public class RecorderPlatformPlugin implements StaticCodeAnalysisPlatformPlugin {
    private Map<String, String> platformArgs = Map.of();
    private boolean initiatedByPlatform;
    private boolean initialized;

    @Override
    public String platform() {
        return "recorder";
    }

    @Override
    public void init(PlatformPluginContext context) {
        this.platformArgs = new TreeMap<>(context.platformArgs());
        this.initiatedByPlatform = context.initiatedByPlatform();
        this.initialized = true;
    }

    @Override
    public void onScan(List<Issue> issues) {
        StringBuilder json = new StringBuilder("{\n");
        json.append("  \"platform\": ").append(quote(platform())).append(",\n");
        json.append("  \"initialized\": ").append(initialized).append(",\n");
        json.append("  \"initiatedByPlatform\": ").append(initiatedByPlatform).append(",\n");
        json.append("  \"workingDirectory\": ").append(quote(System.getProperty("user.dir"))).append(",\n");
        json.append("  \"platformArgs\": {");
        String sep = "\n";
        for (Map.Entry<String, String> arg : platformArgs.entrySet()) {
            json.append(sep).append("    ").append(quote(arg.getKey())).append(": ").append(quote(arg.getValue()));
            sep = ",\n";
        }
        json.append(platformArgs.isEmpty() ? "},\n" : "\n  },\n");
        json.append("  \"issueCount\": ").append(issues.size()).append(",\n");
        json.append("  \"issues\": [");
        sep = "\n";
        for (Issue issue : issues) {
            LineRange range = issue.location().lineRange();
            json.append(sep).append("    {\"ruleId\": ").append(quote(issue.rule().id()))
                    .append(", \"kind\": ").append(quote(String.valueOf(issue.rule().kind())))
                    .append(", \"source\": ").append(quote(String.valueOf(issue.source())))
                    .append(", \"file\": ").append(quote(range.fileName()))
                    .append(", \"startLine\": ").append(range.startLine().line() + 1)
                    .append(", \"endLine\": ").append(range.endLine().line() + 1)
                    .append(", \"description\": ").append(quote(issue.rule().description())).append("}");
            sep = ",\n";
        }
        json.append(issues.isEmpty() ? "]\n}\n" : "\n  ]\n}\n");
        Path out = Path.of(System.getProperty("user.dir")).resolve("platform-" + platform() + "-output.json");
        try {
            Files.writeString(out, json.toString(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        System.out.println("[" + platform() + " platform plugin] received " + issues.size() + " issue(s), args "
                + platformArgs + ", initiatedByPlatform=" + initiatedByPlatform + " -> " + out);
    }

    static String quote(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c < 0x20 ? String.format("\\u%04x", (int) c) : String.valueOf(c));
            }
        }
        return sb.append('"').toString();
    }
}
