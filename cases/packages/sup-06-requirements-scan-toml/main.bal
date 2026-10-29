import ballerina/scan;

public function main() {
    @scan:Suppress {rules: ["ballerina:1"]}
    int noReason = checkpanic int:fromString("1");
    @scan:Suppress {reason: "Accepted as a whole"}
    int noRuleId = checkpanic int:fromString("2");
    _ = noReason + noRuleId;
}
