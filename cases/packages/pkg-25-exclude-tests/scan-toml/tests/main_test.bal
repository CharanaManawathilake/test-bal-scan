import ballerina/scan;

function parseTestInput() returns int {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Test input always parses"}
    int suppressed = checkpanic getResult();
    @scan:Suppress {rules: ["ballerina:7"], reason: "Matches no issue"}
    int active = checkpanic getResult();
    return suppressed + active;
}
