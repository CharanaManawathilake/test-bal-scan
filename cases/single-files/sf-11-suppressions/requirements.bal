import ballerina/scan;

public function main() {
    @scan:Suppress {rules: ["ballerina:1"]}
    int noReason = checkpanic int:fromString("1");
    @scan:Suppress {reason: "No rule id given"}
    int noRuleId = checkpanic int:fromString("2");
    @scan:Suppress
    int bare = checkpanic int:fromString("3");
    _ = noReason + noRuleId + bare;
}
