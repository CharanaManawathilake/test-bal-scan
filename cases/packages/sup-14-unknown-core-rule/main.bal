import ballerina/scan;

public function main() {
    @scan:Suppress {rules: ["ballerina:999"], reason: "Rule the tool does not define"}
    int unknown = 1;
    @scan:Suppress {rules: ["ballerina:1"], reason: "Literal input that always parses"}
    int known = checkpanic int:fromString("1");
    @scan:Suppress {rules: ["acme/lint:1"], reason: "Analyzer the project does not use"}
    int unused = 2;
    _ = unknown + known + unused;
}
