import ballerina/scan;

function parseTestInput() returns int {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Test input always parses"}
    int suppressed = checkpanic int:fromString("1");
    int active = checkpanic int:fromString("2");
    return suppressed + active;
}
