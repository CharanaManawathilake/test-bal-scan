import ballerina/scan;

public function main() {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Literal input that always parses"}
    int suppressed = checkpanic int:fromString("1");
    int active = checkpanic int:fromString("2");
    @scan:Suppress {rules: ["ballerina:7"], reason: "Matches nothing"}
    int unmatched = suppressed + active;
    _ = unmatched;
}

@scan:Suppress
function generated() {
    int value = checkpanic int:fromString("3");
    _ = value;
}
