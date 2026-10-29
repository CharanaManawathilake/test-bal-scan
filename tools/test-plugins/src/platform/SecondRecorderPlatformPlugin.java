package playground.platform;

/**
 * Same as {@link RecorderPlatformPlugin} under a second name, for packages that report to different platforms.
 */
public class SecondRecorderPlatformPlugin extends RecorderPlatformPlugin {
    @Override
    public String platform() {
        return "recorder2";
    }
}
